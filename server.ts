/**
 * 量大智答 —— Express 后端（TypeScript）
 * 接入层：helmet + CORS 白名单 + express-rate-limit + 轻量鉴权
 * 核心：双闸门拒答 + 语义检索引擎（RAG）+ DeepSeek
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { Retriever } from './lib/retriever.js';
import { quickGate, classifyIntent, hasCampusTerm, REFUSAL_TEXT } from './lib/gate.js';
import { buildSystemPrompt } from './lib/prompt.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.join(__dirname, 'documents');
const PORT = Number(process.env.PORT || 3000);
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';
const TEMPERATURE = 0.3;
const API_KEY = process.env.DEEPSEEK_API_KEY || '';
const API_URL = process.env.DEEPSEEK_API_URL || 'https://api.deepseek.com/chat/completions';
const AUTH_KEY = process.env.API_AUTH_KEY || '';
const RATE_MAX = Number(process.env.RATE_LIMIT_PER_MIN || 120);
const SOURCE_THRESHOLD = 0.12;

const retriever = new Retriever(DOCS_DIR);
await retriever.init();

async function callDeepSeek(system: string, messages: { role: string; content: string }[]): Promise<string> {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      temperature: TEMPERATURE,
      max_tokens: 1024,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
  });
  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error('DeepSeek ' + resp.status + ': ' + detail.slice(0, 300));
  }
  const data: any = await resp.json();
  return (data?.choices?.[0]?.message?.content || '').trim();
}

const app = express();
app.use(helmet());
app.use(express.json({ limit: '1mb' }));

/* CORS 白名单（严格限制） */
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
}));

/* 轻量鉴权（可选：设置了 API_AUTH_KEY 才启用） */
app.use('/api', (req, res, next) => {
  if (!AUTH_KEY) return next();
  if (req.headers['x-api-key'] === AUTH_KEY) return next();
  return res.status(401).json({ error: '未授权：缺少有效的 X-API-Key' });
});

/* 限流（防 CC 攻击） */
const limiter = rateLimit({
  windowMs: 60_000,
  limit: RATE_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
});
app.use('/api/chat', limiter);

app.use(express.static(path.join(__dirname, 'dist')));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    model: DEEPSEEK_MODEL,
    apiKeyConfigured: Boolean(API_KEY),
    authEnabled: Boolean(AUTH_KEY),
    rateLimitPerMin: RATE_MAX,
    retriever: retriever.stats,
  });
});

app.get('/api/knowledge', (_req, res) => {
  const files = fs.existsSync(DOCS_DIR)
    ? fs.readdirSync(DOCS_DIR).filter((f) => f.endsWith('.txt') || f.endsWith('.md')).sort()
    : [];
  res.json({
    datastore: 'local-text-files',
    note: '本项目未使用数据库，数据源为 documents/ 目录下的纯文本知识库',
    files: files.map((f) => {
      const text = fs.readFileSync(path.join(DOCS_DIR, f), 'utf8');
      return { name: f, chars: text.length, lines: text.split('\n').length };
    }),
    retriever: retriever.stats,
  });
});

app.post('/api/chat', async (req, res) => {
  try {
    const body = req.body || {};
    const rawMessages: any[] = Array.isArray(body.messages) ? body.messages : [];
    const history = rawMessages
      .filter((m) => m && typeof m.content === 'string' && (m.role === 'user' || m.role === 'assistant'))
      .slice(-10)
      .map((m) => ({ role: m.role as string, content: (m.content as string).slice(0, 2000) }));
    if (history.length === 0 || history[history.length - 1].role !== 'user') {
      return res.status(400).json({ error: '请求中缺少用户消息 messages' });
    }
    const question = history[history.length - 1].content;

    /* 双闸门（上下文感知） */
    let decision = quickGate(question);
    if (decision === 'unknown') {
      const contextCampus = history.slice(0, -1).some((m) => hasCampusTerm(m.content));
      if (contextCampus) {
        decision = 'campus';
      } else {
        decision = API_KEY
          ? await classifyIntent(question, (sys, user) => callDeepSeek(sys, [{ role: 'user', content: user }]))
          : 'offtopic';
      }
    }
    if (decision === 'offtopic') {
      return res.json({ reply: REFUSAL_TEXT, badge: 'refusal', sources: [], engine: 'none' });
    }

    /* 语义检索 */
    const sr = await retriever.search(question, 3);
    const chunks = sr.chunks;
    const hit = chunks.length > 0 && (sr.scores[0] ?? 0) >= SOURCE_THRESHOLD;

    if (!API_KEY) {
      const fallback = hit
        ? chunks.map((c) => c.text).join('\n\n').slice(0, 600)
        : '知识库暂未收录该问题，建议咨询学校官方渠道。';
      return res.json({ reply: fallback, badge: hit ? 'knowledge' : 'general', sources: sr.sources, engine: sr.engine });
    }

    const system = buildSystemPrompt(chunks);
    const reply = await callDeepSeek(system, history);
    const finalReply = hit ? reply + '\n\n【来源：' + sr.sources.join('、') + '】' : reply;
    return res.json({ reply: finalReply, badge: hit ? 'knowledge' : 'general', sources: sr.sources, engine: sr.engine });
  } catch (err: any) {
    console.error('[chat error]', err?.message);
    return res.status(502).json({ error: '服务器内部错误：' + (err?.message || String(err)) });
  }
});

app.listen(PORT, () => {
  console.log('量大智答已启动: http://localhost:' + PORT);
  console.log('模式:', API_KEY ? 'DeepSeek 在线' : '离线');
  console.log('检索引擎:', retriever.stats.engine);
  // 后台预热嵌入模型（首次请求不卡顿）
  retriever.search('中国计量大学')
    .then(() => console.log('检索引擎预热完成:', JSON.stringify(retriever.stats)))
    .catch(() => console.log('嵌入不可用，降级为 TF-IDF'));
});
