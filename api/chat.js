import { API_KEY, callDeepSeek, offlineAnswer, rateLimit } from '../lib/qa.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: '仅支持 POST' });
    return;
  }
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd || req.headers['x-real-ip'] || 'unknown';
  const rl = rateLimit(ip);
  if (!rl.ok) {
    res.status(rl.status).json({ error: rl.error });
    return;
  }
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const history = messages
    .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
    .slice(-10)
    .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
  if (history.length === 0 || history[history.length - 1].role !== 'user') {
    res.status(400).json({ error: '请求中缺少用户消息 messages' });
    return;
  }
  if (!API_KEY) {
    res.json({ reply: offlineAnswer(history[history.length - 1].content), mode: 'offline' });
    return;
  }
  try {
    res.json(await callDeepSeek(history));
  } catch (err) {
    res.status(502).json({ error: 'DeepSeek 调用失败', detail: String(err.message).slice(0, 500) });
  }
}
