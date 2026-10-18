/**
 * POST /api/upload
 * Validation pipeline (section 5.2 order), then GitHub or local write, then success response.
 * Duplicate detection via in-memory ring (last 500) + startup scan of documents/contributions/**.
 */
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { errorLabel } from '../redact.js';
import { Limiter } from '../limiter.js';
import { GitHubClient, GitHubError } from '../github.js';
import {
  normalizeText,
  sanitizeSingleLine,
  sha256Hex,
  buildSubmissionId,
  buildStoredFile,
  detectSuspiciousInstructions,
  mapErrorToResponse,
  type StoredFileHeader,
} from '../upload.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.join(__dirname, '..', '..', 'documents');
const INBOX_DIR = path.join(DOCS_DIR, 'inbox');
const CONTRIBUTIONS_DIR = path.join(DOCS_DIR, 'contributions');

const MAX_FILE_BYTES = 204800;
const MAX_FILE_NAME_CHARS = 80;
const MAX_FILE_LINES = 5000;
const HASH_RING_SIZE = 500;

interface UploadRequest {
  fileName?: unknown;
  content?: unknown;
  consent?: unknown;
  contributor?: unknown;
  note?: unknown;
}

const hashRing: Set<string> = new Set();

function seedHashRing(): void {
  for (const dir of [CONTRIBUTIONS_DIR, INBOX_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir, { recursive: true })) {
      if (typeof file !== 'string') continue;
      const fullPath = path.join(dir, file);
      if (!fs.statSync(fullPath).isFile()) continue;
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const match = content.match(/^# sha256: ([a-f0-9]{64})/m);
        if (match && match[1]) {
          hashRing.add(match[1]);
        }
      } catch {
        // Ignore unreadable files
      }
    }
  }
}

function recordHash(hash: string): void {
  hashRing.add(hash);
  if (hashRing.size > HASH_RING_SIZE) {
    const first = hashRing.values().next().value;
    if (first) hashRing.delete(first);
  }
}

function validateFileName(name: unknown): { ok: true } | { ok: false; code: string } {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, code: 'INVALID_FILE_NAME' };
  }
  if (name.length > MAX_FILE_NAME_CHARS) {
    return { ok: false, code: 'INVALID_FILE_NAME' };
  }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { ok: false, code: 'INVALID_FILE_NAME' };
  }
  if (/[\x00-\x1F]/.test(name)) {
    return { ok: false, code: 'INVALID_FILE_NAME' };
  }
  return { ok: true };
}

function validateExtension(name: string): { ok: true; ext: string } | { ok: false; code: string } {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.txt' || ext === '.md') {
    return { ok: true, ext };
  }
  return { ok: false, code: 'UNSUPPORTED_FILE_TYPE' };
}

function validateContent(text: unknown): { ok: true } | { ok: false; code: string } {
  if (typeof text !== 'string') {
    return { ok: false, code: 'INVALID_PAYLOAD' };
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    return { ok: false, code: 'FILE_TOO_LARGE' };
  }
  const lines = text.split('\n').length;
  if (lines > MAX_FILE_LINES) {
    return { ok: false, code: 'FILE_TOO_LARGE' };
  }
  if (/\x00/.test(text)) {
    return { ok: false, code: 'CONTENT_REJECTED' };
  }
  if (/[\x01-\x08\x0B-\x0C\x0E-\x1F]/.test(text)) {
    return { ok: false, code: 'CONTENT_REJECTED' };
  }
  const replacementRatio = (text.match(/\ufffd/g) || []).length / Math.max(1, text.length);
  if (replacementRatio > 0.01) {
    return { ok: false, code: 'CONTENT_REJECTED' };
  }
  return { ok: true };
}

export function createUploadHandler(uploadLimiter: Limiter) {
  return async function uploadHandler(req: Request, res: Response): Promise<void> {
    const requestId = 'req_' + randomUUID().replace(/-/g, '').slice(0, 20);
    const body = req.body as UploadRequest;

    try {
      if (body.consent !== true) {
        const errorInfo = mapErrorToResponse('CONSENT_REQUIRED');
        res.status(errorInfo.status).json({ ok: false, code: errorInfo.code, error: errorInfo.error });
        return;
      }

      const fileNameCheck = validateFileName(body.fileName);
      if (!fileNameCheck.ok) {
        const errorInfo = mapErrorToResponse(fileNameCheck.code);
        res.status(errorInfo.status).json({ ok: false, code: errorInfo.code, error: errorInfo.error });
        return;
      }
      const fileName = body.fileName as string;

      const extCheck = validateExtension(fileName);
      if (!extCheck.ok) {
        const errorInfo = mapErrorToResponse(extCheck.code);
        res.status(errorInfo.status).json({ ok: false, code: errorInfo.code, error: errorInfo.error });
        return;
      }
      const ext = extCheck.ext;

      const contentCheck = validateContent(body.content);
      if (!contentCheck.ok) {
        const errorInfo = mapErrorToResponse(contentCheck.code);
        res.status(errorInfo.status).json({ ok: false, code: errorInfo.code, error: errorInfo.error });
        return;
      }
      const rawContent = body.content as string;

      const contributor = sanitizeSingleLine(String(body.contributor || ''), 40);
      const note = sanitizeSingleLine(String(body.note || ''), 200);

      const clientIp = req.ip || 'unknown';
      const limitCheck = uploadLimiter.check(clientIp);
      if (!limitCheck.allowed) {
        const errorInfo = mapErrorToResponse('UPLOAD_RATE_LIMITED');
        res.status(errorInfo.status).json({ ok: false, code: errorInfo.code, error: errorInfo.error });
        return;
      }

      const normalized = normalizeText(rawContent);
      const contentHash = sha256Hex(normalized);

      if (hashRing.has(contentHash)) {
        const errorInfo = mapErrorToResponse('DUPLICATE_CONTRIBUTION');
        res.status(errorInfo.status).json({ ok: false, code: errorInfo.code, error: errorInfo.error });
        return;
      }

      detectSuspiciousInstructions(normalized);

      const submissionId = buildSubmissionId();
      const now = new Date();
      const year = now.getUTCFullYear();
      const month = String(now.getUTCMonth() + 1).padStart(2, '0');
      const fileName2 = submissionId + ext;
      const storedPath = path.join('documents', 'contributions', String(year), month, fileName2);

      const header: StoredFileHeader = {
        contributed: now.toISOString(),
        submission: submissionId,
        sha256: contentHash,
        originalName: fileName,
        contributor,
        note,
        source: 'user-contribution (unreviewed until merged)',
      };
      const storedContent = buildStoredFile(header, normalized);
      const storedBase64 = Buffer.from(storedContent, 'utf8').toString('base64');

      recordHash(contentHash);

      if (config.contributionMode === 'local') {
        if (!fs.existsSync(INBOX_DIR)) {
          fs.mkdirSync(INBOX_DIR, { recursive: true });
        }
        const inboxPath = path.join(INBOX_DIR, fileName2);
        fs.writeFileSync(inboxPath, storedContent, 'utf8');
        res.status(200).json({
          ok: true,
          status: 'local_only',
          submissionId,
          sha256: contentHash,
          storedPath,
          message: '感谢您的贡献！内容已保存到本地审核队列。',
        });
        return;
      }

      if (!config.contributionsEnabled) {
        const errorInfo = mapErrorToResponse('GITHUB_NOT_CONFIGURED');
        res.status(errorInfo.status).json({ ok: false, code: errorInfo.code, error: errorInfo.error });
        return;
      }

      const github = new GitHubClient(
        config.githubOwner,
        config.githubRepo,
        config.githubToken,
        config.githubApiBase,
      );

      const branch = 'contributions/' + submissionId;
      let commitSha: string | null = null;
      let pullRequestUrl: string | null = null;

      if (config.contributionMode === 'pr') {
        try {
          const baseSha = await github.getRef(config.githubBaseBranch);
          await github.createRef(branch, baseSha);
          const commitMessage = '提交：' + submissionId + '（' + fileName + '）';
          commitSha = await github.putFile(storedPath, storedBase64, commitMessage, branch);
          const prBody = '贡献 ID：' + submissionId + '\nSHA256：' + contentHash + '\n字节数：' + Buffer.byteLength(storedContent, 'utf8') + '\n行数：' + storedContent.split('\n').length + '\n贡献者：' + (contributor || '匿名') + '\n备注：' + (note || '无') + '\n\n审核清单：\n- [ ] 内容真实可靠？\n- [ ] 无个人隐私？\n- [ ] 无代码注入指令？\n\n说明：本内容为用户提交，未合并前视为不受信任数据。';
          pullRequestUrl = await github.openPullRequest({ title: 'feat(contributions): ' + submissionId, head: branch, base: config.githubBaseBranch, body: prBody });
          res.status(200).json({ ok: true, status: 'pending_review', submissionId, sha256: contentHash, storedPath, branch, commitSha, pullRequestUrl, message: '感谢您的贡献！内容已提交到审核队列，PR 已创建。' });
        } catch (err) {
          const ghErr = err instanceof GitHubError ? err : null;
          const code = ghErr ? (ghErr.kind === 'auth' ? 'GITHUB_AUTH_FAILED' : 'GITHUB_UPSTREAM_ERROR') : 'INTERNAL';
          console.error('[upload] ' + requestId + ' ' + code + ' ' + errorLabel(err));
          const errorInfo = mapErrorToResponse(code);
          res.status(errorInfo.status).json({ ok: false, code: errorInfo.code, error: errorInfo.error });
        }
        return;
      }

      if (config.contributionMode === 'direct') {
        try {
          const baseSha = await github.getRef(config.githubBaseBranch);
          const commitMessage = '提交：' + submissionId + '（' + fileName + '）';
          commitSha = await github.putFile(storedPath, storedBase64, commitMessage, config.githubBaseBranch);
          res.status(200).json({ ok: true, status: 'committed', submissionId, sha256: contentHash, storedPath, branch: config.githubBaseBranch, commitSha, message: '感谢您的贡献！内容已直接提交到 ' + config.githubBaseBranch + '。' });
        } catch (err) {
          const ghErr = err instanceof GitHubError ? err : null;
          const code = ghErr ? (ghErr.kind === 'auth' ? 'GITHUB_AUTH_FAILED' : 'GITHUB_UPSTREAM_ERROR') : 'INTERNAL';
          console.error('[upload] ' + requestId + ' ' + code + ' ' + errorLabel(err));
          const errorInfo = mapErrorToResponse(code);
          res.status(errorInfo.status).json({ ok: false, code: errorInfo.code, error: errorInfo.error });
        }
        return;
      }
    } catch (err) {
      console.error('[upload] ' + requestId + ' INTERNAL ' + errorLabel(err));
      const errorInfo = mapErrorToResponse('INTERNAL');
      res.status(errorInfo.status).json({ ok: false, code: errorInfo.code, error: errorInfo.error });
    }
  };
}

seedHashRing();
