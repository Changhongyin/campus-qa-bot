/**
 * POST /api/feedback (contract section 5.5)
 *  - rating "up": in-process counter, logged at most once per minute, no external call.
 *  - rating "down": counter plus a GitHub Issue when GitHub is configured.
 *  - Any GitHub failure, and any unexpected error, is a soft signal: 200 with recorded:false.
 * The question text is never stored or sent.
 */
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { errorLabel } from '../redact.js';
import type { Limiter } from '../limiter.js';
import { GitHubClient } from '../github.js';
import { sanitizeSingleLine } from '../upload.js';

const MAX_REASON_CHARS = 200;
const MAX_COMMENT_CHARS = 500;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const LOG_INTERVAL_MS = 60_000;

const ERRORS = {
  INVALID_PAYLOAD: { status: 400, error: '请求格式不正确' },
  RATE_LIMITED: { status: 429, error: '提交过于频繁，请稍后再试' },
} as const;

const counters = { up: 0, down: 0 };
let logged = { up: 0, down: 0 };
let logTimer: NodeJS.Timeout | null = null;

function ensureLogTimer(): void {
  if (logTimer) return;
  logTimer = setInterval(() => {
    if (counters.up !== logged.up || counters.down !== logged.down) {
      console.log('[feedback] totals up=' + counters.up + ' down=' + counters.down);
      logged = { up: counters.up, down: counters.down };
    }
  }, LOG_INTERVAL_MS);
  logTimer.unref();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Absent or null becomes an empty string; a non-string value is invalid (undefined). */
function readText(value: unknown, maxChars: number): string | undefined {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return undefined;
  return sanitizeSingleLine(value, maxChars);
}

function mdCode(value: string): string {
  const safe = value.replace(/`/g, "'");
  return safe.length > 0 ? '`' + safe + '`' : '_none_';
}

export function createFeedbackHandler(feedbackLimiter: Limiter) {
  return async function feedbackHandler(req: Request, res: Response): Promise<void> {
    const handlerId = 'req_' + randomUUID().replace(/-/g, '').slice(0, 20);

    const sendError = (code: keyof typeof ERRORS, retryAfterMs?: number): void => {
      if (retryAfterMs !== undefined) {
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
      }
      res.status(ERRORS[code].status).json({ ok: false, code, error: ERRORS[code].error });
    };

    try {
      if (!isRecord(req.body)) return sendError('INVALID_PAYLOAD');
      const body = req.body;

      const rating = body.rating;
      if (rating !== 'up' && rating !== 'down') return sendError('INVALID_PAYLOAD');

      const reason = readText(body.reason, MAX_REASON_CHARS);
      const comment = readText(body.comment, MAX_COMMENT_CHARS);
      if (reason === undefined || comment === undefined) return sendError('INVALID_PAYLOAD');
      if (body.requestId !== undefined && body.requestId !== null && typeof body.requestId !== 'string') {
        return sendError('INVALID_PAYLOAD');
      }
      const chatRequestId =
        typeof body.requestId === 'string' && REQUEST_ID_PATTERN.test(body.requestId) ? body.requestId : '';

      const limit = feedbackLimiter.check(req.ip || 'unknown');
      if (!limit.allowed) return sendError('RATE_LIMITED', limit.resetMs);

      ensureLogTimer();
      if (rating === 'up') {
        counters.up++;
        res.status(200).json({ ok: true, recorded: true });
        return;
      }
      counters.down++;

      if (!config.githubConfigured) {
        res.status(200).json({ ok: true, recorded: false });
        return;
      }

      const issueId = chatRequestId || 'fb_' + randomUUID().replace(/-/g, '').slice(0, 12);
      const issueBody = [
        '- rating: `down`',
        '- timestamp: `' + new Date().toISOString() + '`',
        '- reason: ' + mdCode(reason),
        '- comment: ' + mdCode(comment),
        '',
        'Sent from the in-app feedback button. The question text is intentionally not included.',
      ].join('\n');

      try {
        const github = new GitHubClient(config.githubOwner, config.githubRepo, config.githubToken, config.githubApiBase);
        const issueUrl = await github.openIssue({ title: 'feedback: ' + issueId, body: issueBody });
        res.status(200).json({ ok: true, recorded: true, issueUrl });
      } catch (err) {
        console.error('[feedback] ' + handlerId + ' issue failed ' + errorLabel(err));
        res.status(200).json({ ok: true, recorded: false });
      }
    } catch (err) {
      console.error('[feedback] ' + handlerId + ' INTERNAL ' + errorLabel(err));
      if (!res.headersSent) res.status(200).json({ ok: true, recorded: false });
    }
  };
}
