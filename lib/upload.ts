/**
 * Upload helpers: normalization, sanitization, hashing, ID generation, suspicious instruction detection.
 */
import { createHash } from 'node:crypto';

const SUSPICIOUS_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['instruction_override', /忽略|ignore|forget|forget all|prompt|system prompt|指令|你现在是|you are now/i],
  ['secret_request', /泄露|泄漏|reveal|leak|secret|密钥|token|密码|password/i],
  ['role_switch', /扮演|roleplay|assume|pretend|become|角色|变成|假设你是/i],
];

export function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n+$/g, '')
    .replace(/^\ufeff/, '');
}

export function sanitizeSingleLine(text: string, maxChars: number = 200): string {
  const cleaned = text
    .replace(/[\r\n\t]/g, ' ')
    .replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function buildSubmissionId(): string {
  const now = new Date();
  const isoString = now.toISOString();
  const yyyymmddHHMMSSz = isoString.replace(/[-:]/g, '').slice(0, 15) + 'z';
  const randomHex = Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  return 'c_' + yyyymmddHHMMSSz + '_' + randomHex;
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

export function buildStoredFile(
  header: StoredFileHeader,
  normalizedContent: string,
): string {
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

export interface SuspiciousFlags {
  instruction_override: boolean;
  secret_request: boolean;
  role_switch: boolean;
}

export function detectSuspiciousInstructions(text: string): SuspiciousFlags {
  const flags: SuspiciousFlags = {
    instruction_override: false,
    secret_request: false,
    role_switch: false,
  };
  for (const [flag, pattern] of SUSPICIOUS_PATTERNS) {
    if (pattern.test(text)) {
      (flags as unknown as Record<string, boolean>)[flag] = true;
    }
  }
  return flags;
}

export interface ErrorResponse {
  status: number;
  code: string;
  error: string;
}

export function mapErrorToResponse(code: string): ErrorResponse {
  const messages: Record<string, { status: number; error: string }> = {
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
  const msg = messages[code] ?? messages['INTERNAL'];
  return { status: msg.status, code, error: msg.error };
}
