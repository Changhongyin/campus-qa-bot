/**
 * POST /api/feedback
 * Validates body, sanitizes strings, applies rate limit, opens GitHub Issue on rating: "down" (soft-fail).
 */
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { errorLabel } from '../redact.js';
import { Limiter } from '../limiter.js';
import { GitHubClient, GitHubError } from '../github.js';
import { sanitizeSingleLine, mapErrorToResponse } from '../upload.js';

export function createFeedbackHandler(feedbackLimiter: Limiter) {
  return async function feedbackHandler(req: Request, res: Response): Promise<void> {
    const requestId = 'req_' + randomUUID().replace(/-/g, '').slice(0, 20);
    const body = req.body as Record<string, unknown>;

    try {
      const rating = body.rating;
      if (rating !== 'up' && rating !== 'down') {
        const errorInfo = mapErrorToResponse('INVALID_PAYLOAD');
        res.status(errorInfo.status).json({ ok: false, code: errorInfo.code, error: errorInfo.error });
        return;
      }

      const requestId2 = sanitizeSingleLine(String(body.requestId || ''), 40);
      const reason = sanitizeSingleLine(String(body.reason || ''), 200);
      const comment = sanitizeSingleLine(String(body.comment || ''), 500);

      const clientIp = req.ip || 'unknown';
      const limitCheck = feedbackLimiter.check(clientIp);
      if (!limitCheck.allowed) {
        const errorInfo = mapErrorToResponse('UPLOAD_RATE_LIMITED');
        res.status(errorInfo.status).json({ ok: false, code: errorInfo.code, error: errorInfo.error });
        return;
      }

      if (rating === 'up') {
        res.status(200).json({ ok: true, recorded: true });
        return;
      }

      if (!config.githubConfigured) {
        res.status(200).json({ ok: true, recorded: false });
        return;
      }

      const issueId = requestId2 || 'feedback_' + randomUUID().slice(0, 8);
      const issueTitle = 'feedback: ' + issueId;
      const issueBody = '- rating: down\n' + '- timestamp: ' + new Date().toISOString() + '\n' + (reason ? '- reason: ' + reason + '\n' : '') + (comment ? '- comment: ' + comment + '\n' : '');

      try {
        const github = new GitHubClient(config.githubOwner, config.githubRepo, config.githubToken, config.githubApiBase);
        const issueUrl = await github.openIssue(issueTitle, issueBody);
        res.status(200).json({ ok: true, recorded: true, issueUrl });
      } catch (ghErr) {
        console.error('[feedback] ' + requestId + ' GitHub error: ' + errorLabel(ghErr));
        res.status(200).json({ ok: true, recorded: false });
      }
    } catch (err) {
      console.error('[feedback] ' + requestId + ' INTERNAL ' + errorLabel(err));
      const errorInfo = mapErrorToResponse('INTERNAL');
      res.status(errorInfo.status).json({ ok: false, code: errorInfo.code, error: errorInfo.error });
    }
  };
}
