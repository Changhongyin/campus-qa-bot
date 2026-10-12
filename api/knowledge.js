import { KNOWLEDGE_BASE } from '../lib/qa.mjs';

export default function handler(_req, res) {
  res.json({
    datastore: 'local-text-files',
    note: '本项目未使用数据库，数据源为 documents/ 目录下的纯文本知识库',
    totalChars: KNOWLEDGE_BASE.length,
    content: KNOWLEDGE_BASE,
  });
}
