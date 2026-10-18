/**
 * Upload helpers: normalization, sanitization, hashing, id generation,
 * stored-file layout, suspicious-instruction flags and stable error mapping.
 * Pure functions: no I/O, no secrets.
 */
import { createHash, randomBytes } from 'node:crypto';

export interface SuspiciousFlags {
  instruction_override: boolean;
  secret_request: boolean;
  role_switch: boolean;
}

const SUSPICIOUS_PATTERNS: ReadonlyArray<readonly [keyof SuspiciousFlags, RegExp]> = [
  ['instruction_override', /忽略|ignore|forget|forget all|prompt|system prompt|指令|你现在是|you are now/i],
  ['secret_request', /泄露|泄漏|reveal|leak|secret|密钥|token|密码|password/i],
  ['role_switch', /扮演|roleplay|assume|pretend|become|角色|变成|假设你是/i],
];

/** BOM removed, CRLF and lone CR converted to LF, trailing whitespace trimmed. */
export function normalizeText(text: string): string {
  return text
    .replace(/^\ufeff/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trimEnd();
}

/** Reduces any text to a single line without control characters and caps it at maxChars characters. */
export function sanitizeSingleLine(text: string, maxChars: number = 200): string {
  const cleaned = text
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(cleaned);
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') : cleaned;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Format: c_<UTC YYYYMMDDTHHMMSSZ>_<8 hex>, for example c_20251018T012345Z_ab12cd34. */
export function buildSubmissionId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  return 'c_' + stamp + '_' + randomBytes(4).toString('hex');
}

export interface StoredFileHeader {
  contributed: string;
  submission: string;
  sha256: string;
  originalName: string;
  contributor: string;
  note: string;
  source: string;
}

/** Fixed, fully server-generated layout of a stored contribution (contract section 5.2). */
export function buildStoredFile(header: StoredFileHeader, normalizedContent: string): string {
  const headerLines = [
    '# contributed: ' + header.contributed,
    '# submission: ' + header.submission,
    '# sha256: ' + header.sha256,
    '# original-name: ' + header.originalName,
    '# contributor: ' + header.contributor,
    '# note: ' + header.note,
    '# source: ' + header.source,
  ];
  return headerLines.join('\n') + '\n\n' + normalizedContent;
}

/** Heuristic flags recorded in the pull request body. They never block a submission by themselves. */
export function detectSuspiciousInstructions(text: string): SuspiciousFlags {
  const flags: SuspiciousFlags = {
    instruction_override: false,
    secret_request: false,
    role_switch: false,
  };
  for (const [flag, pattern] of SUSPICIOUS_PATTERNS) {
    if (pattern.test(text)) flags[flag] = true;
  }
  return flags;
}

export interface ErrorResponse {
  status: number;
  code: string;
  error: string;
}

const ERROR_TABLE: Record<string, { status: number; error: string }> = {
  CONSENT_REQUIRED: { status: 422, error: '请勾选同意条款后提交' },
  INVALID_FILE_NAME: { status: 400, error: '文件名格式不正确（仅允许文件名，不含路径；长度不超过 80 字符）' },
  UNSUPPORTED_FILE_TYPE: { status: 415, error: '仅支持 .txt 和 .md 文件' },
  FILE_TOO_LARGE: { status: 413, error: '文件过大（单个不超过 200 KiB，行数不超过 5000）' },
  CONTENT_REJECTED: { status: 422, error: '文件内容包含非法字符' },
  DUPLICATE_CONTRIBUTION: { status: 409, error: '该内容已被提交过，请勿重复提交' },
  UPLOAD_RATE_LIMITED: { status: 429, error: '提交过于频繁，请稍后再试' },
  GITHUB_NOT_CONFIGURED: { status: 503, error: '贡献功能暂时不可用，请稍后再试' },
  GITHUB_UPSTREAM_ERROR: { status: 502, error: 'GitHub 服务暂时不可用，请稍后再试' },
  GITHUB_AUTH_FAILED: { status: 502, error: 'GitHub 认证失败，请稍后重试' },
  PAYLOAD_TOO_LARGE: { status: 413, error: '请求内容过大' },
  INVALID_PAYLOAD: { status: 400, error: '请求格式不正确' },
  INTERNAL: { status: 500, error: '服务器内部错误，请稍后再试' },
};

/** Maps a stable code to its HTTP status and zh-CN message; unknown codes become INTERNAL. */
export function mapErrorToResponse(code: string): ErrorResponse {
  const known = ERROR_TABLE[code];
  if (known) return { status: known.status, code, error: known.error };
  const fallback = ERROR_TABLE['INTERNAL'];
  return { status: fallback.status, code: 'INTERNAL', error: fallback.error };
}
