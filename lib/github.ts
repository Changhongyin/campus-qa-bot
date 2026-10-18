/**
 * GitHub REST API client (no dependencies).
 * Handles PR creation, file operations, issue opening with retries and error normalization.
 */
import { config } from './config.js';

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

interface Ref {
  object: { sha: string };
}

interface CommitResponse {
  sha: string;
}

interface PullRequestResponse {
  html_url: string;
}

interface IssueResponse {
  html_url: string;
}

export class GitHubClient {
  private baseUrl: string;
  private owner: string;
  private repo: string;
  private token: string;
  private readonly timeoutMs = 10000;
  private readonly retries = 2;
  private readonly backoffs = [400, 1200];

  constructor(owner: string, repo: string, token: string, baseUrl: string = 'https://api.github.com') {
    this.owner = owner;
    this.repo = repo;
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private headers(): Record<string, string> {
    return {
      'User-Agent': 'CampusQA-Contribution-Bot',
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': 'token ' + this.token,
    };
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
  ): Promise<Response> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const resp = await fetch(url, { ...options, signal: controller.signal });
          clearTimeout(timeoutHandle);
          return resp;
        } finally {
          clearTimeout(timeoutHandle);
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < this.retries) {
          const delay = this.backoffs[attempt] ?? 1000;
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError || new Error('fetch failed');
  }

  private async handleResponse<T>(resp: Response): Promise<T> {
    const text = await resp.text();
    if (!resp.ok) {
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      this.throwForStatus(resp.status, body);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new GitHubError('upstream', 'invalid JSON response from GitHub', resp.status);
    }
  }

  private throwForStatus(status: number, body: unknown): never {
    if (status === 401 || status === 403) {
      throw new GitHubError('auth', 'GitHub authentication failed', status);
    }
    if (status === 404) {
      throw new GitHubError('not_found', 'GitHub resource not found', status);
    }
    if (status === 409) {
      throw new GitHubError('conflict', 'GitHub conflict (branch may already exist)', status);
    }
    if (status === 429) {
      throw new GitHubError('rate_limited', 'GitHub rate limit exceeded', status);
    }
    if (status >= 500) {
      throw new GitHubError('upstream', 'GitHub API error (HTTP ' + status + ')', status);
    }
    throw new GitHubError('upstream', 'GitHub API error (HTTP ' + status + ')', status);
  }

  async getRef(branch: string): Promise<string> {
    const url = this.baseUrl + '/repos/' + this.owner + '/' + this.repo + '/git/ref/heads/' + branch;
    const resp = await this.fetchWithRetry(url, { method: 'GET', headers: this.headers() });
    const data = await this.handleResponse<Ref>(resp);
    return data.object.sha;
  }

  async createRef(branch: string, sha: string): Promise<void> {
    const url = this.baseUrl + '/repos/' + this.owner + '/' + this.repo + '/git/refs';
    const resp = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ ref: 'refs/heads/' + branch, sha }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      try {
        const json = JSON.parse(body);
        this.throwForStatus(resp.status, json);
      } catch {
        this.throwForStatus(resp.status, body);
      }
    }
  }

  async putFile(
    path: string,
    contentBase64: string,
    message: string,
    branch: string,
  ): Promise<string> {
    const url = this.baseUrl + '/repos/' + this.owner + '/' + this.repo + '/contents/' + path;
    const resp = await this.fetchWithRetry(url, {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify({ message, content: contentBase64, branch }),
    });
    const data = await this.handleResponse<CommitResponse>(resp);
    return data.sha;
  }

  async openPullRequest(params: {
    title: string;
    head: string;
    base: string;
    body: string;
  }): Promise<string> {
    const url = this.baseUrl + '/repos/' + this.owner + '/' + this.repo + '/pulls';
    const resp = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(params),
    });
    const data = await this.handleResponse<PullRequestResponse>(resp);
    return data.html_url;
  }

  async openIssue(title: string, body: string): Promise<string> {
    const url = this.baseUrl + '/repos/' + this.owner + '/' + this.repo + '/issues';
    const resp = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ title, body }),
    });
    const data = await this.handleResponse<IssueResponse>(resp);
    return data.html_url;
  }

  async fileExists(path: string): Promise<boolean> {
    const url = this.baseUrl + '/repos/' + this.owner + '/' + this.repo + '/contents/' + path;
    try {
      const resp = await this.fetchWithRetry(url, { method: 'GET', headers: this.headers() });
      return resp.ok;
    } catch {
      return false;
    }
  }
}
