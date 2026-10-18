/**
 * 量大智答 —— Express 后端（TypeScript）
 * 接入层：helmet + CORS 白名单 + express-rate-limit + 轻量鉴权
 * 核心：SSE chat streaming + 文件上传 + 反馈收集 + 双闸门检索
 */
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertServerConfig } from './lib/config.js';
import { Retriever } from './lib/retriever.js';
import { createChatHandler } from './lib/handlers/chat.js';
import { createUploadHandler } from './lib/handlers/upload.js';
import { createFeedbackHandler } from './lib/handlers/feedback.js';
import { Limiter } from './lib/limiter.js';
import { errorLabel } from './lib/redact.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.join(__dirname, 'documents');

const retriever = new Retriever(DOCS_DIR);
await retriever.init();

const uploadLimiter = new Limiter(config.uploadRateHour, config.uploadRateDay);
const feedbackLimiter = new Limiter(config.uploadRateHour, config.uploadRateDay);

const app = express();
app.use(helmet());
app.use(express.json({ limit: '1mb' }));

/* CORS 白名单（严格限制） */
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
    return cb(null, false);
  },
}));

/* 轻量鉴权（可选：设置了 API_AUTH_KEY 才启用） */
app.use('/api', (req, res, next) => {
  if (!config.authKey) return next();
  if (req.headers['x-api-key'] === config.authKey) return next();
  return res.status(401).json({ error: '未授权：缺少有效的 X-API-Key' });
});

/* 限流（防 CC 攻击） */
const chatLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.rateLimitPerMin,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '请求过于频繁，请稍后再试' },
});
app.use('/api/chat', chatLimiter);

app.use(express.static(path.join(__dirname, 'dist')));

app.get('/api/health', (_req, res) => {
  const mode = config.deepseekApiKey.length > 0 ? 'deepseek' : 'offline';
  res.json({
    ok: true,
    model: config.deepseekModel,
    apiKeyConfigured: Boolean(config.deepseekApiKey),
    authEnabled: Boolean(config.authKey),
    rateLimitPerMin: config.rateLimitPerMin,
    retriever: retriever.stats,
    mode,
    contributions: {
      enabled: config.contributionsEnabled,
      mode: config.contributionMode,
      maxBytes: config.contributionMaxBytes,
    },
    version: '2.0.0',
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
    contributions: {
      files: 0,
    },
  });
});

app.post('/api/chat', createChatHandler({ retriever }));
app.post('/api/upload', createUploadHandler(uploadLimiter));
app.post('/api/feedback', createFeedbackHandler(feedbackLimiter));

/* JSON error handler: stable codes, never a stack trace. */
interface HttpishError {
  status?: number;
  type?: string;
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) {
    res.end();
    return;
  }
  const info = (typeof err === 'object' && err !== null ? err : {}) as HttpishError;
  if (info.type === 'entity.too.large' || info.status === 413) {
    res.status(413).json({ error: '请求内容过大，请精简后重试', code: 'PAYLOAD_TOO_LARGE' });
    return;
  }
  const clientError = typeof info.status === 'number' && info.status >= 400 && info.status < 500;
  if (clientError || info.type === 'entity.parse.failed' || err instanceof SyntaxError) {
    res.status(400).json({ error: '请求格式不正确，请提交合法的 JSON', code: 'BAD_REQUEST' });
    return;
  }
  console.error('[server] request failed: ' + errorLabel(err));
  res.status(500).json({ error: '服务器内部错误，请稍后再试', code: 'INTERNAL' });
});

assertServerConfig();

app.listen(config.port, () => {
  console.log('量大智答已启动: http://localhost:' + config.port);
  console.log('模式:', config.deepseekApiKey ? 'DeepSeek 在线' : '离线');
  console.log('检索引擎:', retriever.stats.engine);
  console.log('贡献功能:', config.contributionsEnabled ? config.contributionMode : '已禁用');
  retriever.search('中国计量大学')
    .then(() => console.log('检索引擎预热完成:', JSON.stringify(retriever.stats)))
    .catch(() => console.log('嵌入不可用，降级为 TF-IDF'));
});
