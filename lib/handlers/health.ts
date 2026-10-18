/**
 * GET /api/health
 * Existing fields are unchanged; mode, contributions and version are additive.
 */
import type { Request, Response } from 'express';
import { config } from '../config.js';
import type { Retriever } from '../retriever.js';

export interface HealthHandlerDeps {
  retriever: Pick<Retriever, 'stats'>;
}

export function createHealthHandler(deps: HealthHandlerDeps) {
  return function healthHandler(_req: Request, res: Response): void {
    res.json({
      ok: true,
      model: config.deepseekModel,
      apiKeyConfigured: Boolean(config.deepseekApiKey),
      authEnabled: Boolean(config.authKey),
      rateLimitPerMin: config.rateLimitPerMin,
      retriever: deps.retriever.stats,
      mode: config.deepseekApiKey.length > 0 ? 'deepseek' : 'offline',
      contributions: {
        enabled: config.contributionsEnabled,
        mode: config.contributionMode,
        maxBytes: config.contributionMaxBytes,
      },
      version: '2.0.0',
    });
  };
}
