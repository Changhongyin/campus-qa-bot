/**
 * GET /api/knowledge
 * `files` lists only the files directly inside documents/ (unchanged behaviour).
 * `contributions.files` counts merged contribution files that are indexed.
 * No file contents are exposed.
 */
import type { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { errorLabel } from '../redact.js';
import type { Retriever } from '../retriever.js';

export interface KnowledgeHandlerDeps {
  retriever: Pick<Retriever, 'stats' | 'contributionCount'>;
  docsDir: string;
}

const NOTE = '本项目未使用数据库，数据源为 documents/ 目录下的纯文本知识库';

export function createKnowledgeHandler(deps: KnowledgeHandlerDeps) {
  return function knowledgeHandler(_req: Request, res: Response): void {
    try {
      const names = fs.existsSync(deps.docsDir)
        ? fs.readdirSync(deps.docsDir).filter((f) => f.endsWith('.txt') || f.endsWith('.md')).sort()
        : [];
      const files = names.map((name) => {
        try {
          const text = fs.readFileSync(path.join(deps.docsDir, name), 'utf8');
          return { name, chars: text.length, lines: text.split('\n').length };
        } catch {
          return { name, chars: 0, lines: 0 };
        }
      });
      const contributionFiles = deps.retriever.contributionCount();
      res.json({
        datastore: 'local-text-files',
        note: NOTE,
        files,
        retriever: deps.retriever.stats,
        contributions: { files: contributionFiles },
      });
    } catch (err) {
      console.error('[knowledge] INTERNAL ' + errorLabel(err));
      res.status(500).json({ error: '服务器内部错误，请稍后再试', code: 'INTERNAL' });
    }
  };
}
