/**
 * 语义检索引擎（RAG 升级）
 * --------------------------------------------------------------
 * 相比旧版"二元组关键词匹配"，本模块提供：
 *   1. 段落级切块（单块 ≤ 600 字，带文件名 + 章节标题）
 *   2. 语义向量检索（@xenova/transformers · all-MiniLM-L6-v2，本地 ONNX，走 hf-mirror）
 *   3. 模型不可用时自动降级到 TF-IDF 余弦（仍优于关键词二元组）
 *   4. 知识库热更新（fs.watch + 文件名/mtime/size 指纹，免重启）
 *   5. Top-K 召回 + 来源溯源
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Chunk {
  id: string;
  text: string;
  source: string;
  title: string;
  vector: number[];
}

export interface SearchResult {
  chunks: Chunk[];
  sources: string[];
  engine: string;
  scores: number[];
}

const MAX_CHUNK = 600;
const TOP_K = 3;
const MAX_FILE_BYTES = 512 * 1024; // 超大知识库文件直接跳过，防拖垮检索

/* ---------------- 切块 ---------------- */
function splitSections(text: string): { title: string; body: string }[] {
  const lines = text.split(/\r?\n/);
  const sections: { title: string; body: string }[] = [];
  let cur: { title: string; body: string[] } | null = null;
  for (const line of lines) {
    const m = line.match(/^【([^】]+)】/);
    if (m) {
      if (cur) sections.push({ title: cur.title, body: cur.body.join('\n') });
      cur = { title: m[1], body: [] };
    } else if (cur) {
      cur.body.push(line);
    } else {
      cur = { title: '', body: [line] };
    }
  }
  if (cur) sections.push({ title: cur.title, body: cur.body.join('\n') });
  return sections;
}

function chunkBySize(text: string, max: number): string[] {
  const out: string[] = [];
  const paras = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  let buf = '';
  for (const p of paras) {
    if (buf && (buf + '\n' + p).length > max) { out.push(buf.trim()); buf = p; }
    else { buf = buf ? buf + '\n' + p : p; }
    while (buf.length > max) { out.push(buf.slice(0, max)); buf = buf.slice(max); }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

export function chunkDocument(text: string, source: string): Chunk[] {
  const chunks: Chunk[] = [];
  let i = 0;
  for (const sec of splitSections(text)) {
    const prefix = sec.title ? '【' + sec.title + '】\n' : '';
    for (const piece of chunkBySize(sec.body, MAX_CHUNK)) {
      if (!piece.trim()) continue;
      chunks.push({ id: source + '#' + (i++), text: prefix + piece.trim(), source, title: sec.title || '(无标题)', vector: [] });
    }
  }
  return chunks;
}

/* ---------------- 向量运算 ---------------- */
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] || 0, y = b[i] || 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

/* ---------------- 嵌入模型（懒加载，失败即降级） ---------------- */
let extractorPromise: Promise<any> | null = null;
let embeddingFailed = false;

async function getExtractor(): Promise<any> {
  if (embeddingFailed) throw new Error('embedding unavailable');
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const mod: any = await import('@xenova/transformers');
      mod.env.remoteHost = 'https://hf-mirror.com';
      mod.env.allowLocalModels = false;
      return await mod.pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    })();
    extractorPromise.catch(() => { embeddingFailed = true; });
  }
  return extractorPromise;
}

/* ---------------- TF-IDF ---------------- */
function tokenize(text: string): string[] {
  const t: string[] = [];
  const clean = text.replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  for (let i = 0; i < clean.length - 1; i++) t.push(clean.slice(i, i + 2));
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) if (w.length > 1) t.push(w);
  return t;
}

export class Retriever {
  private docsDir: string;
  private chunks: Chunk[] = [];
  private fingerprints = new Map<string, string>();
  private engine = 'none';
  private watcher: fs.FSWatcher | null = null;
  private embeddingsReady = false;
  private tfidfReady = false;
  private vocab: string[] = [];
  private tfidfVectors: number[][] = [];

  constructor(docsDir: string) { this.docsDir = docsDir; }

  private listFiles(): string[] {
    return fs.existsSync(this.docsDir)
      ? fs.readdirSync(this.docsDir).filter((f) => f.endsWith('.txt') || f.endsWith('.md')).sort()
      : [];
  }

  private loadDocuments(): boolean {
    const files = this.listFiles();
    let changed = files.length !== this.fingerprints.size;
    const newFp = new Map<string, string>();
    for (const name of files) {
      const full = path.join(this.docsDir, name);
      let fp: string;
      try { const st = fs.statSync(full); fp = st.mtimeMs + ':' + st.size; } catch { continue; }
      newFp.set(name, fp);
      if (this.fingerprints.get(name) !== fp) changed = true;
    }
    if (!changed) return false;

    const chunks: Chunk[] = [];
    for (const name of files) {
      const full = path.join(this.docsDir, name);
      let text: string;
      try {
        const st = fs.statSync(full);
        if (st.size > MAX_FILE_BYTES) continue;
        const buf = fs.readFileSync(full);
        text = buf.toString('utf8');
        if (text.includes('\ufffd')) continue;
      } catch { continue; }
      chunks.push(...chunkDocument(text, name));
    }
    this.chunks = chunks;
    this.fingerprints = newFp;
    this.embeddingsReady = false;
    this.tfidfReady = false;
    this.tfidfVectors = [];
    this.vocab = [];
    return true;
  }

  async init(): Promise<void> { this.loadDocuments(); this.watch(); }

  watch(): void {
    if (this.watcher || !fs.existsSync(this.docsDir)) return;
    let timer: NodeJS.Timeout | null = null;
    this.watcher = fs.watch(this.docsDir, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { this.loadDocuments(); }, 300);
    });
  }

  get stats() { return { chunks: this.chunks.length, engine: this.engine, ready: this.chunks.length > 0 }; }

  private async ensureEmbeddings(): Promise<void> {
    if (this.embeddingsReady || embeddingFailed) return;
    const extractor = await getExtractor();
    for (const c of this.chunks) {
      const out = await extractor(c.text, { pooling: 'mean', normalize: true });
      c.vector = Array.from(out.data as Float32Array);
    }
    this.embeddingsReady = true;
    this.engine = 'embedding';
  }

  private ensureTfidf(): void {
    if (this.tfidfReady) return;
    const set = new Set<string>();
    for (const c of this.chunks) for (const tok of tokenize(c.text)) set.add(tok);
    this.vocab = Array.from(set).sort();
    const df = new Map<string, number>();
    for (const c of this.chunks) {
      const seen = new Set<string>();
      for (const tok of tokenize(c.text)) if (!seen.has(tok)) { seen.add(tok); df.set(tok, (df.get(tok) || 0) + 1); }
    }
    const N = this.chunks.length || 1;
    const idf = new Map<string, number>();
    for (const [tok, d] of df) idf.set(tok, Math.log((N + 1) / (d + 1)) + 1);
    this.tfidfVectors = this.chunks.map((c) => {
      const tf = new Map<string, number>();
      for (const tok of tokenize(c.text)) tf.set(tok, (tf.get(tok) || 0) + 1);
      const v = new Array<number>(this.vocab.length).fill(0);
      for (const [tok, cnt] of tf) {
        const idx = this.vocab.indexOf(tok);
        if (idx >= 0) v[idx] = cnt * (idf.get(tok) || 1);
      }
      return v;
    });
    this.tfidfReady = true;
    if (this.engine === 'none') this.engine = 'tfidf';
  }

  async search(query: string, topK: number = TOP_K): Promise<SearchResult> {
    this.loadDocuments();
    if (this.chunks.length === 0) return { chunks: [], sources: [], engine: 'none', scores: [] };

    if (!embeddingFailed) {
      try {
        await this.ensureEmbeddings();
        const extractor = await getExtractor();
        const out = await extractor(query, { pooling: 'mean', normalize: true });
        const qv = Array.from(out.data as Float32Array);
        const scored = this.chunks.map((c, i) => ({ i, s: cosine(qv, c.vector) }))
          .sort((a, b) => b.s - a.s).slice(0, topK);
        if (scored.length && scored[0].s > 0) {
          return this.pack(scored.map((x) => this.chunks[x.i]), scored.map((x) => x.s), 'embedding');
        }
      } catch { embeddingFailed = true; }
    }

    this.ensureTfidf();
    const qtf = new Map<string, number>();
    for (const tok of tokenize(query)) qtf.set(tok, (qtf.get(tok) || 0) + 1);
    const qv = new Array<number>(this.vocab.length).fill(0);
    for (const [tok, cnt] of qtf) {
      const idx = this.vocab.indexOf(tok);
      if (idx >= 0) qv[idx] = cnt;
    }
    const scored = this.tfidfVectors.map((v, i) => ({ i, s: cosine(qv, v) }))
      .sort((a, b) => b.s - a.s).slice(0, topK);
    return this.pack(scored.map((x) => this.chunks[x.i]), scored.map((x) => x.s), 'tfidf');
  }

  private pack(chunks: Chunk[], scores: number[], engine: string): SearchResult {
    return { chunks, scores, engine, sources: Array.from(new Set(chunks.map((c) => c.source))) };
  }
}
