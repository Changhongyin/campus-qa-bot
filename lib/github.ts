/**
 * GitHub REST API client built on global fetch (no dependencies).
 *
 * - 10 s timeout per call.
 * - 2 retries (400 ms, then 1200 ms) on network errors, HTTP 429 and HTTP 5xx.
 *   A Retry-After header is respected, capped at 5 s so a request never hangs for long.
 * - Errors are normalized to GitHubError. Messages never contain the token or an upstream body.
 */

export type GitHubErrorKind = 'auth' | 'not_found' | 'rate_limited' | 'conflict' | 'upstream';

export class GitHubError extends Error {
  readonly kind: GitHubErrorKind;
  readonly status: number | null;

  constructor(kind: GitHubErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'GitHubError';
    this.kind = kind;
    this.status = status;
  }
}

const USER_AGENT = 'CampusQA-Contribution-Bot';
const REQUEST_TIMEOUT_MS = 10000;
const RETRY_DELAYS_MS: readonly number[] = [400, 1200];
const MAX_RETRY_AFTER_MS = 5000;

type HttpMethod = 'GET' | 'POST' | 'PUT';

interface CallResult {
  status: number;
  data: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function encodePath(value: string): string {
  return value.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function classify(resp: Response): GitHubErrorKind {
  const status = resp.status;
  if (status === 401) return 'auth';
  if (status === 403) {
    const limited = resp.headers.get('x-ratelimit-remaining') === '0' || resp.headers.get('retry-after') !== null;
    return limited ? 'rate_limited' : 'auth';
  }
  if (status === 404) return 'not_found';
  if (status === 409 || status === 422) return 'conflict';
  if (status === 429) return 'rate_limited';
  return 'upstream';
}

function retryDelay(resp: Response, baseMs: number): number {
  const header = resp.headers.get('retry-after');
  const seconds = header === null ? Number.NaN : Number(header);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(baseMs, Math.floor(seconds * 1000)));
  }
  return baseMs;
}

async function discard(resp: Response): Promise<void> {
  try {
    await resp.body?.cancel();
  } catch {
    // The body is already closed.
  }
}

async function parseBody(resp: Response): Promise<unknown> {
  const text = await resp.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new GitHubError('upstream', 'GitHub returned an invalid JSON payload', resp.status);
  }
}

export class GitHubClient {
  private readonly apiBase: string;
  private readonly repoPath: string;
  private readonly token: string;

  constructor(owner: string, repo: string, token: string, apiBase: string = 'https://api.github.com') {
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.repoPath = '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo);
    this.token = token;
  }

  private headers(hasBody: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      'User-Agent': USER_AGENT,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: 'token ' + this.token,
    };
    if (hasBody) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private async call(
    method: HttpMethod,
    apiPath: string,
    body?: unknown,
    allowNotFound: boolean = false,
  ): Promise<CallResult> {
    const url = this.apiBase + apiPath;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let attempt = 0;
    for (;;) {
      let resp: Response;
      try {
        resp = await fetch(url, {
          method,
          headers: this.headers(payload !== undefined),
          body: payload,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        if (attempt >= RETRY_DELAYS_MS.length) {
          throw new GitHubError('upstream', 'GitHub request failed (network error or timeout)');
        }
        await sleep(RETRY_DELAYS_MS[attempt]);
        attempt++;
        continue;
      }

      if ((resp.status === 429 || resp.status >= 500) && attempt < RETRY_DELAYS_MS.length) {
        const delay = retryDelay(resp, RETRY_DELAYS_MS[attempt]);
        await discard(resp);
        await sleep(delay);
        attempt++;
        continue;
      }

      if (resp.ok) {
        return { status: resp.status, data: await parseBody(resp) };
      }
      if (resp.status === 404 && allowNotFound) {
        await discard(resp);
        return { status: 404, data: null };
      }
      const kind = classify(resp);
      const status = resp.status;
      await discard(resp);
      throw new GitHubError(kind, 'GitHub API error (HTTP ' + status + ')', status);
    }
  }

  async getRepo(): Promise<{ defaultBranch: string; isPrivate: boolean }> {
    const data = asRecord((await this.call('GET', this.repoPath)).data);
    const defaultBranch = data?.default_branch;
    if (typeof defaultBranch !== 'string') {
      throw new GitHubError('upstream', 'GitHub returned an unexpected repository payload');
    }
    return { defaultBranch, isPrivate: data?.private === true };
  }

  async getRef(branch: string): Promise<string> {
    const data = asRecord((await this.call('GET', this.repoPath + '/git/ref/heads/' + encodePath(branch))).data);
    const sha = asRecord(data?.object)?.sha;
    if (typeof sha !== 'string' || sha.length === 0) {
      throw new GitHubError('upstream', 'GitHub returned an unexpected ref payload');
    }
    return sha;
  }

  async createRef(branch: string, sha: string): Promise<void> {
    await this.call('POST', this.repoPath + '/git/refs', { ref: 'refs/heads/' + branch, sha });
  }

  /** Creates a file on a branch and returns the new commit sha. */
  async putFile(path: string, contentBase64: string, message: string, branch: string): Promise<string> {
    const result = await this.call('PUT', this.repoPath + '/contents/' + encodePath(path), {
      message,
      content: contentBase64,
      branch,
    });
    const sha = asRecord(asRecord(result.data)?.commit)?.sha;
    if (typeof sha !== 'string' || sha.length === 0) {
      throw new GitHubError('upstream', 'GitHub returned an unexpected commit payload');
    }
    return sha;
  }

  async openPullRequest(params: { title: string; head: string; base: string; body: string }): Promise<string> {
    const data = asRecord((await this.call('POST', this.repoPath + '/pulls', params)).data);
    const url = data?.html_url;
    if (typeof url !== 'string') {
      throw new GitHubError('upstream', 'GitHub returned an unexpected pull request payload');
    }
    return url;
  }

  async openIssue(params: { title: string; body: string }): Promise<string> {
    const data = asRecord((await this.call('POST', this.repoPath + '/issues', params)).data);
    const url = data?.html_url;
    if (typeof url !== 'string') {
      throw new GitHubError('upstream', 'GitHub returned an unexpected issue payload');
    }
    return url;
  }

  /** True when the path exists on the branch (or the default branch when none is given). */
  async fileExists(path: string, branch?: string): Promise<boolean> {
    const query = branch ? '?ref=' + encodeURIComponent(branch) : '';
    const result = await this.call('GET', this.repoPath + '/contents/' + encodePath(path) + query, undefined, true);
    return result.status !== 404;
  }
}
