/**
 * 检索命中率对比：旧版「二元组关键词」 vs 新版「语义向量嵌入」
 * 判据：正确章节标题是否进入 Top-3；用例含「直白提问」与「同义改写」两类
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Retriever, chunkDocument, type Chunk } from '../lib/retriever.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.join(__dirname, '..', 'documents');

// 前 5 条直白，后 5 条同义改写/口语化
const CASES: { q: string; expect: string }[] = [
  { q: '中国计量大学的校训是什么？', expect: '校训' },
  { q: '学校的特色专业有哪些？', expect: '优势与特色专业' },
  { q: '学校有几个校区？在哪里？', expect: '校区与地址' },
  { q: '学校是什么时候创办的？', expect: '历史沿革' },
  { q: '学校有多少本科生和研究生？', expect: '学科建设与师资' },
  { q: '你们学校最牛的专业是啥', expect: '优势与特色专业' },
  { q: '学校本部在哪个园区哪条路', expect: '校区与地址' },
  { q: '精思国计细量民生这句话是哪个学校的', expect: '校训' },
  { q: '贵校啥时候改名叫大学的', expect: '历史沿革' },
  { q: '学校里头一共有多少学生和老师', expect: '学科建设与师资' },
];

function allChunks(): Chunk[] {
  const files = fs.readdirSync(DOCS).filter((f) => f.endsWith('.txt') || f.endsWith('.md')).sort();
  const chunks: Chunk[] = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(DOCS, f), 'utf8');
    if (text.includes('\ufffd')) continue;
    chunks.push(...chunkDocument(text, f));
  }
  return chunks;
}

function bigrams(t: string): Set<string> {
  const s = new Set<string>();
  const c = t.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  for (let i = 0; i < c.length - 1; i++) s.add(c.slice(i, i + 2));
  return s;
}
function bigramTop3(chunks: Chunk[], q: string): Chunk[] {
  const qb = bigrams(q);
  return chunks
    .map((c) => ({ c, s: [...bigrams(c.text)].filter((x) => qb.has(x)).length }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 3)
    .map((x) => x.c);
}
function hit(top: Chunk[], expect: string): boolean {
  return top.some((c) => c.title.includes(expect));
}

const retriever = new Retriever(DOCS);
await retriever.init();
const chunks = allChunks();

let oldHit = 0, newHit = 0;
console.log('用例 | 旧(二元组) | 新(语义)');
console.log('-----|-----------|---------');
for (const c of CASES) {
  const o = hit(bigramTop3(chunks, c.q), c.expect);
  const res = await retriever.search(c.q, 3);
  const n = hit(res.chunks, c.expect);
  if (o) oldHit++;
  if (n) newHit++;
  console.log(c.q.slice(0, 18) + ' | ' + (o ? '命中' : '未命中') + ' | ' + (n ? '命中' : '未命中'));
}
console.log('-----|-----------|---------');
console.log('命中率 | ' + oldHit + '/' + CASES.length + '=' + Math.round(oldHit / CASES.length * 100) + '% | '
  + newHit + '/' + CASES.length + '=' + Math.round(newHit / CASES.length * 100) + '%');
console.log('BENCH_DONE');
process.exit(0);
