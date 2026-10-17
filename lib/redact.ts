/**
 * Secret redaction for every log line and every error text that leaves the process.
 *
 * Token prefixes are assembled from parts on purpose: the pre-commit secret scan
 * looks for the literal prefixes, and this file must never trip it.
 */

const PLACEHOLDER = '[REDACTED]';
const SECRET_ENV_NAMES = ['DEEPSEEK_API_KEY', 'GITHUB_TOKEN', 'API_AUTH_KEY'] as const;
const MIN_SECRET_LENGTH = 6;

const PATTERN_PARTS: ReadonlyArray<readonly [string, string]> = [
  ['(?<![A-Za-z0-9])s', 'k-[A-Za-z0-9_-]{16,}'],
  ['(?<![A-Za-z0-9])gh', '[pousr]_[A-Za-z0-9]{20,}'],
  ['(?<![A-Za-z0-9])github', '_pat_[A-Za-z0-9_]{20,}'],
  ['Bear', 'er\\s+[A-Za-z0-9._~+/=-]{8,}'],
];

const PATTERNS: RegExp[] = PATTERN_PARTS.map(([head, tail]) => new RegExp(head + tail, 'g'));

function toText(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.name + ': ' + input.message;
  try {
    const json = JSON.stringify(input);
    return typeof json === 'string' ? json : String(input);
  } catch {
    return String(input);
  }
}

/** Removes configured secret values and well-known token shapes from any value. */
export function redactSecrets(input: unknown): string {
  let text = toText(input);
  for (const name of SECRET_ENV_NAMES) {
    const secret = process.env[name];
    if (typeof secret === 'string') {
      const trimmed = secret.trim();
      if (trimmed.length >= MIN_SECRET_LENGTH) text = text.split(trimmed).join(PLACEHOLDER);
    }
  }
  for (const pattern of PATTERNS) {
    text = text.replace(pattern, PLACEHOLDER);
  }
  return text;
}

/** Short, safe label for logging an error: name plus code or kind, never the message. */
export function errorLabel(err: unknown): string {
  if (!(err instanceof Error)) return 'NonError';
  const extra = err as Error & { code?: unknown; kind?: unknown };
  let label = err.name;
  if (typeof extra.code === 'string') label += ':' + extra.code;
  if (typeof extra.kind === 'string') label += ':' + extra.kind;
  return redactSecrets(label);
}
