import { API_KEY, DEEPSEEK_MODEL, KNOWLEDGE_BASE } from '../lib/qa.mjs';

export default function handler(_req, res) {
  res.json({
    ok: true,
    model: DEEPSEEK_MODEL,
    apiKeyConfigured: Boolean(API_KEY),
    knowledgeBaseChars: KNOWLEDGE_BASE.length,
    mode: API_KEY ? 'deepseek' : 'offline',
  });
}
