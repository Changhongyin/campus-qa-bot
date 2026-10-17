/**
 * Typed, validated environment access for CampusQA backend v2.
 *
 * - Loads .env once (dotenv never overrides variables that are already set).
 * - Never throws at import time: invalid values fall back to safe defaults.
 * - Secrets are defined as non-enumerable properties, so JSON.stringify(config)
 *   and console.log(config) can never print them.
 */
import dotenv from 'dotenv';

dotenv.config();

export type ContributionMode = 'pr' | 'direct' | 'local';
export type RetrieverMode = 'auto' | 'tfidf';

export interface AppConfig {
  readonly port: number;
  readonly isVercel: boolean;
  readonly deepseekModel: string;
  readonly deepseekApiUrl: string;
  readonly deepseekTemperature: number;
  readonly deepseekMaxTokens: number;
  readonly deepseekTimeoutMs: number;
  readonly rateLimitPerMin: number;
  readonly corsOrigins: readonly string[];
  readonly sseHeartbeatMs: number;
  readonly sourceThreshold: number;
  readonly retrieverMode: RetrieverMode;
  readonly githubOwner: string;
  readonly githubRepo: string;
  readonly githubApiBase: string;
  readonly githubBaseBranch: string;
  readonly githubConfigured: boolean;
  readonly contributionMode: ContributionMode;
  readonly contributionMaxBytes: number;
  readonly uploadRateHour: number;
  readonly uploadRateDay: number;
  readonly contributionsEnabled: boolean;
  /** Secret, non-enumerable. */
  readonly deepseekApiKey: string;
  /** Secret, non-enumerable. */
  readonly authKey: string;
  /** Secret, non-enumerable. */
  readonly githubToken: string;
}

type PublicConfig = Omit<AppConfig, 'deepseekApiKey' | 'authKey' | 'githubToken'>;

function readString(name: string, fallback: string): string {
  const raw = process.env[name];
  if (typeof raw !== 'string') return fallback;
  const value = raw.trim();
  return value.length > 0 ? value : fallback;
}

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function loadConfig(): AppConfig {
  const isVercel = Boolean(process.env.VERCEL);

  const modeRaw = readString('CONTRIBUTION_MODE', 'pr').toLowerCase();
  const contributionMode: ContributionMode =
    modeRaw === 'direct' || modeRaw === 'local' ? modeRaw : 'pr';

  const retrieverRaw = readString('RETRIEVER_MODE', isVercel ? 'tfidf' : 'auto').toLowerCase();
  const retrieverMode: RetrieverMode = retrieverRaw === 'tfidf' ? 'tfidf' : 'auto';

  const githubToken = readString('GITHUB_TOKEN', '');
  const githubOwner = readString('GITHUB_OWNER', 'Changhongyin');
  const githubRepo = readString('GITHUB_REPO', 'campus-qa-bot');
  const githubConfigured =
    githubToken.length > 0 && githubOwner.length > 0 && githubRepo.length > 0;
  const contributionsEnabled = contributionMode === 'local' ? !isVercel : githubConfigured;

  const publicConfig: PublicConfig = {
    port: readInt('PORT', 3000, 1, 65535),
    isVercel,
    deepseekModel: readString('DEEPSEEK_MODEL', 'deepseek-chat'),
    deepseekApiUrl: readString('DEEPSEEK_API_URL', 'https://api.deepseek.com/chat/completions'),
    deepseekTemperature: 0.3,
    deepseekMaxTokens: 1024,
    deepseekTimeoutMs: readInt('DEEPSEEK_TIMEOUT_MS', 45000, 1000, 300000),
    rateLimitPerMin: readInt('RATE_LIMIT_PER_MIN', 120, 1, 1000000),
    corsOrigins: readString('CORS_ORIGINS', 'http://localhost:3000,http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    sseHeartbeatMs: readInt('SSE_HEARTBEAT_MS', 15000, 100, 300000),
    sourceThreshold: 0.12,
    retrieverMode,
    githubOwner,
    githubRepo,
    githubApiBase: readString('GITHUB_API_BASE', 'https://api.github.com').replace(/\/+$/, ''),
    githubBaseBranch: readString('GITHUB_BASE_BRANCH', 'main'),
    githubConfigured,
    contributionMode,
    contributionMaxBytes: readInt('CONTRIBUTION_MAX_BYTES', 204800, 1024, 524288),
    uploadRateHour: readInt('UPLOAD_RATE_HOUR', 3, 1, 1000),
    uploadRateDay: readInt('UPLOAD_RATE_DAY', 10, 1, 10000),
    contributionsEnabled,
  };

  return Object.defineProperties(publicConfig, {
    deepseekApiKey: { value: readString('DEEPSEEK_API_KEY', ''), enumerable: false },
    authKey: { value: readString('API_AUTH_KEY', ''), enumerable: false },
    githubToken: { value: githubToken, enumerable: false },
  }) as AppConfig;
}

export const config: AppConfig = loadConfig();

let reported = false;

/** Logs a single warning line when the contribution channel is disabled. Never throws. */
export function assertServerConfig(): void {
  if (reported) return;
  reported = true;
  if (config.contributionsEnabled) return;
  const reason =
    config.contributionMode === 'local'
      ? 'local mode is not available on this runtime'
      : 'GITHUB_TOKEN, GITHUB_OWNER or GITHUB_REPO is missing';
  console.warn(
    '[config] contributions disabled (mode=' + config.contributionMode + '): ' + reason +
      '. Uploads return GITHUB_NOT_CONFIGURED.',
  );
}
