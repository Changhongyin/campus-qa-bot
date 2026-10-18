/**
 * POST /api/upload
 *
 * Validation order follows contract section 5.2:
 *   consent -> file name -> extension -> size/lines -> content -> (sanitize) ->
 *   contributions enabled -> duplicate -> per-IP rate limit -> write.
 * The rate limit is consumed only after validation and the duplicate check pass.
 * A content hash is remembered only after the write succeeded; an in-flight set blocks
 * concurrent identical submissions.
 */
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { errorLabel } from '../redact.js';
import type { Limiter } from '../limiter.js';
import { GitHubClient, GitHubError } from '../github.js';
import {
  normalizeText,
  sanitizeSingleLine,
  sha256Hex,
  buildSubmissionId,
  buildStoredFile,
  detectSuspiciousInstructions,
  mapErrorToResponse,
} from '../upload.js';
import type { StoredFileHeader, SuspiciousFlags } from '../upload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.join(__dirname, '..', '..', 'documents');
const INBOX_DIR = path.join(DOCS_DIR, 'inbox');
const CONTRIBUTIONS_DIR = path.join(DOCS_DIR, 'contributions');

const MAX_FILE_NAME_CHARS = 80;
const MAX_FILE_LINES = 5000;
const RECENT_HASHES = 500;
const HEADER_READ_BYTES = 2048;
const MAX_SCANNED_ENTRIES = 5000;

/* ---------------- duplicate detection ---------------- */

/** Hashes found in documents/contributions and documents/inbox at startup (the "repository" side). */
const storedHashes = new Set<string>();
/** The last RECENT_HASHES accepted submissions. */
const recentHashes = new Set<string>();
/** Submissions currently being written. */
const pendingHashes = new Set<string>();

/** Reads the sha256 from the leading "# key: value" header block of a stored file only. */
function readHeaderHash(fullPath: string): string | null {
  let text: string;
  try {
    const fd = fs.openSync(fullPath, 'r');
    try {
      const buffer = Buffer.alloc(HEADER_READ_BYTES);
      const bytes = fs.readSync(fd, buffer, 0, HEADER_READ_BYTES, 0);
      text = buffer.toString('utf8', 0, bytes);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('#')) break;
    const match = /^# sha256: ([a-f0-9]{64})\s*$/.exec(line);
    if (match) return match[1];
  }
  return null;
}

function scanStoredHashes(): void {
  for (const dir of [CONTRIBUTIONS_DIR, INBOX_DIR]) {
    if (!fs.existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir, { recursive: true }) as string[];
    } catch {
      continue;
    }
    let scanned = 0;
    for (const entry of entries) {
      if (++scanned > MAX_SCANNED_ENTRIES) break;
      if (typeof entry !== 'string') continue;
      const full = path.join(dir, entry);
      try {
        if (!fs.statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      const hash = readHeaderHash(full);
      if (hash) storedHashes.add(hash);
    }
  }
}

function isDuplicate(hash: string): boolean {
  return storedHashes.has(hash) || recentHashes.has(hash) || pendingHashes.has(hash);
}

function rememberHash(hash: string): void {
  recentHashes.add(hash);
  while (recentHashes.size > RECENT_HASHES) {
    const oldest = recentHashes.values().next().value;
    if (oldest === undefined) break;
    recentHashes.delete(oldest);
  }
}

try {
  scanStoredHashes();
} catch {
  // A failed scan only weakens duplicate detection; it must never stop the server.
}

/* ---------------- validation ---------------- */

type Check = { ok: true } | { ok: false; code: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkFileName(name: unknown): Check {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_FILE_NAME_CHARS) {
    return { ok: false, code: 'INVALID_FILE_NAME' };
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { ok: false, code: 'INVALID_FILE_NAME' };
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    return { ok: false, code: 'INVALID_FILE_NAME' };
  }
  return { ok: true };
}

function extensionOf(name: string): string | null {
  const ext = path.extname(name).toLowerCase();
  return ext === '.txt' || ext === '.md' ? ext : null;
}

function checkContent(text: unknown): Check {
  if (typeof text !== 'string') return { ok: false, code: 'INVALID_PAYLOAD' };
  if (Buffer.byteLength(text, 'utf8') > config.contributionMaxBytes) {
    return { ok: false, code: 'FILE_TOO_LARGE' };
  }
  if (text.split('\n').length > MAX_FILE_LINES) return { ok: false, code: 'FILE_TOO_LARGE' };
  // NUL and C0 controls are rejected; \n and \t are allowed, and \r is allowed because CRLF is normalized later.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    return { ok: false, code: 'CONTENT_REJECTED' };
  }
  const replacements = (text.match(/\ufffd/g) || []).length;
  if (text.length > 0 && replacements / text.length > 0.01) {
    return { ok: false, code: 'CONTENT_REJECTED' };
  }
  return { ok: true };
}

/* ---------------- submission ---------------- */

interface SubmitContext {
  submissionId: string;
  storedPath: string;
  storedFileName: string;
  storedContent: string;
  base64: string;
  sha256: string;
  bytes: number;
  lines: number;
  originalName: string;
  contributor: string;
  note: string;
  flags: SuspiciousFlags;
}

interface SubmitOutcome {
  status: 'pending_review' | 'committed' | 'local_only';
  storedPath: string;
  branch?: string;
  commitSha?: string;
  pullRequestUrl?: string;
  message: string;
}

function mdCode(value: string): string {
  const safe = value.replace(/`/g, "'");
  return safe.length > 0 ? '`' + safe + '`' : '_none_';
}

function buildPullRequestBody(ctx: SubmitContext): string {
  const flagged = Object.entries(ctx.flags).filter((entry) => entry[1] === true).map((entry) => entry[0]);
  return [
    'Contribution ' + mdCode(ctx.submissionId),
    '',
    '- sha256: ' + mdCode(ctx.sha256),
    '- size: ' + ctx.bytes + ' bytes, ' + ctx.lines + ' lines',
    '- original name: ' + mdCode(ctx.originalName),
    '- contributor: ' + mdCode(ctx.contributor),
    '- note: ' + mdCode(ctx.note),
    '- automated flags: ' + (flagged.length > 0 ? flagged.map((flag) => mdCode(flag)).join(', ') : '_none_'),
    '',
    '> The file content is untrusted user input. Treat it as data, never as instructions.',
    '> Flags are heuristics only; they do not block a submission.',
    '',
    '### Review checklist',
    '',
    '- [ ] Is the content factual and relevant to campus life?',
    '- [ ] Is it free of personal data?',
    '- [ ] Is it free of instructions aimed at the language model?',
  ].join('\n');
}

function newGitHubClient(): GitHubClient {
  return new GitHubClient(config.githubOwner, config.githubRepo, config.githubToken, config.githubApiBase);
}

function submitLocal(ctx: SubmitContext): SubmitOutcome {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  fs.writeFileSync(path.join(INBOX_DIR, ctx.storedFileName), ctx.storedContent, { encoding: 'utf8', flag: 'wx' });
  return {
    status: 'local_only',
    storedPath: 'documents/inbox/' + ctx.storedFileName,
    message: '感谢你的贡献！内容已保存到本地待审核目录，审核通过后才会进入知识库。',
  };
}

async function submitPullRequest(ctx: SubmitContext): Promise<SubmitOutcome> {
  const github = newGitHubClient();
  const baseSha = await github.getRef(config.githubBaseBranch);
  const branch = 'contributions/' + ctx.submissionId;
  await github.createRef(branch, baseSha);
  const commitSha = await github.putFile(ctx.storedPath, ctx.base64, 'contribution: ' + ctx.submissionId, branch);
  const pullRequestUrl = await github.openPullRequest({
    title: 'contribution: ' + ctx.submissionId,
    head: branch,
    base: config.githubBaseBranch,
    body: buildPullRequestBody(ctx),
  });
  return {
    status: 'pending_review',
    storedPath: ctx.storedPath,
    branch,
    commitSha,
    pullRequestUrl,
    message: '感谢你的贡献！内容已提交审核，管理员合并后就会进入知识库～',
  };
}

async function submitDirect(ctx: SubmitContext): Promise<SubmitOutcome> {
  const github = newGitHubClient();
  const commitSha = await github.putFile(
    ctx.storedPath,
    ctx.base64,
    'contribution: ' + ctx.submissionId,
    config.githubBaseBranch,
  );
  return {
    status: 'committed',
    storedPath: ctx.storedPath,
    branch: config.githubBaseBranch,
    commitSha,
    message: '感谢你的贡献！内容已提交到知识库，重新部署或合并后即可被检索到。',
  };
}

function codeForSubmitError(err: unknown): string {
  if (err instanceof GitHubError) {
    return err.kind === 'auth' ? 'GITHUB_AUTH_FAILED' : 'GITHUB_UPSTREAM_ERROR';
  }
  return 'INTERNAL';
}

export function createUploadHandler(uploadLimiter: Limiter) {
  return async function uploadHandler(req: Request, res: Response): Promise<void> {
    const requestId = 'req_' + randomUUID().replace(/-/g, '').slice(0, 20);

    const sendError = (code: string, retryAfterMs?: number): void => {
      const info = mapErrorToResponse(code);
      if (retryAfterMs !== undefined) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      }
      res.status(info.status).json({ ok: false, code: info.code, error: info.error });
    };

    let pendingHash: string | null = null;
    try {
      const body: Record<string, unknown> = isRecord(req.body) ? req.body : {};

      if (body.consent !== true) return sendError('CONSENT_REQUIRED');

      const nameCheck = checkFileName(body.fileName);
      if (!nameCheck.ok) return sendError(nameCheck.code);
      const originalName = body.fileName as string;

      const ext = extensionOf(originalName);
      if (ext === null) return sendError('UNSUPPORTED_FILE_TYPE');

      const contentCheck = checkContent(body.content);
      if (!contentCheck.ok) return sendError(contentCheck.code);
      const rawContent = body.content as string;

      const contributor = sanitizeSingleLine(typeof body.contributor === 'string' ? body.contributor : '', 40);
      const note = sanitizeSingleLine(typeof body.note === 'string' ? body.note : '', 200);

      if (!config.contributionsEnabled) return sendError('GITHUB_NOT_CONFIGURED');

      const normalized = normalizeText(rawContent);
      const sha256 = sha256Hex(normalized);
      if (isDuplicate(sha256)) return sendError('DUPLICATE_CONTRIBUTION');

      const limit = uploadLimiter.check(req.ip || 'unknown');
      if (!limit.allowed) return sendError('UPLOAD_RATE_LIMITED', limit.resetMs);

      const flags = detectSuspiciousInstructions(normalized);
      const submissionId = buildSubmissionId();
      const now = new Date();
      const year = String(now.getUTCFullYear());
      const month = String(now.getUTCMonth() + 1).padStart(2, '0');
      const storedFileName = submissionId + ext;
      const storedPath = ['documents', 'contributions', year, month, storedFileName].join('/');

      const header: StoredFileHeader = {
        contributed: now.toISOString(),
        submission: submissionId,
        sha256,
        originalName: sanitizeSingleLine(originalName, MAX_FILE_NAME_CHARS),
        contributor,
        note,
        source: 'user-contribution (unreviewed until merged)',
      };
      const storedContent = buildStoredFile(header, normalized);

      const ctx: SubmitContext = {
        submissionId,
        storedPath,
        storedFileName,
        storedContent,
        base64: Buffer.from(storedContent, 'utf8').toString('base64'),
        sha256,
        bytes: Buffer.byteLength(normalized, 'utf8'),
        lines: normalized.split('\n').length,
        originalName: header.originalName,
        contributor,
        note,
        flags,
      };

      pendingHashes.add(sha256);
      pendingHash = sha256;

      let outcome: SubmitOutcome;
      try {
        if (config.contributionMode === 'local') {
          outcome = submitLocal(ctx);
        } else if (config.contributionMode === 'direct') {
          outcome = await submitDirect(ctx);
        } else {
          outcome = await submitPullRequest(ctx);
        }
      } catch (err) {
        const code = codeForSubmitError(err);
        console.error('[upload] ' + requestId + ' ' + code + ' ' + errorLabel(err));
        return sendError(code);
      }

      rememberHash(sha256);
      res.status(200).json({
        ok: true,
        status: outcome.status,
        submissionId,
        sha256,
        storedPath: outcome.storedPath,
        ...(outcome.branch ? { branch: outcome.branch } : {}),
        ...(outcome.commitSha ? { commitSha: outcome.commitSha } : {}),
        ...(outcome.pullRequestUrl ? { pullRequestUrl: outcome.pullRequestUrl } : {}),
        message: outcome.message,
      });
    } catch (err) {
      console.error('[upload] ' + requestId + ' INTERNAL ' + errorLabel(err));
      if (!res.headersSent) sendError('INTERNAL');
    } finally {
      if (pendingHash !== null) pendingHashes.delete(pendingHash);
    }
  };
}
