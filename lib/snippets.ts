/**
 * Verbatim evidence snippets for the SSE `retrieve` thought and the `done` event.
 *
 * Every snippet text is one contiguous substring of a single line of the chunk body,
 * at most 160 characters, centered on the sentence that best matches the question.
 * Nothing is paraphrased, no ellipsis is added, and the section heading is never part of the text.
 */
import type { Chunk } from './retriever.js';
import type { Snippet } from './thoughts.js';

export const SNIPPET_MAX_CHARS = 160;

const SHORT_PASSAGE_CHARS = 60;
const MAX_POSITIONS_PER_TOKEN = 50;
const NO_TITLE_MARK = '(无标题)';
const TERMINATORS = new Set<string>(['。', '！', '？', '；', '!', '?', ';']);
const CLOSERS = new Set<string>(['"', '\u2019', '）', ')', '」', '』', '】', '"', "'"]);
const WEAK_TOKENS = new Set<string>([
  '什么', '怎么', '如何', '哪里', '哪些', '是否', '可以', '请问', '一下',
  '多少', '有没', '没有', '我们', '你们', '学校',
]);

interface Span {
  start: number;
  end: number;
}

/** Character bigrams plus ASCII words, the same idea the retriever uses; weak question words are dropped. */
function queryTokens(question: string): string[] {
  const lowered = question.toLowerCase();
  const all = new Set<string>();
  const clean = lowered.replace(/[^\u4e00-\u9fa5a-z0-9]/g, '');
  for (let i = 0; i < clean.length - 1; i += 1) all.add(clean.slice(i, i + 2));
  for (const word of lowered.split(/[^a-z0-9]+/)) {
    if (word.length > 1) all.add(word);
  }
  const list = Array.from(all);
  const strong = list.filter((token) => !WEAK_TOKENS.has(token));
  return strong.length > 0 ? strong : list;
}

function countHits(text: string, tokens: readonly string[]): number {
  const lowered = text.toLowerCase();
  let hits = 0;
  for (const token of tokens) {
    if (lowered.includes(token)) hits += 1;
  }
  return hits;
}

function trimSpan(line: string, start: number, end: number): Span {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(line.charAt(s))) s += 1;
  while (e > s && /\s/.test(line.charAt(e - 1))) e -= 1;
  return { start: s, end: e };
}

function sentenceSpans(line: string): Span[] {
  const raw: Span[] = [];
  let start = 0;
  let i = 0;
  while (i < line.length) {
    if (TERMINATORS.has(line.charAt(i))) {
      let end = i + 1;
      while (end < line.length && CLOSERS.has(line.charAt(end))) end += 1;
      raw.push({ start, end });
      start = end;
      i = end;
    } else {
      i += 1;
    }
  }
  if (start < line.length) raw.push({ start, end: line.length });

  const spans: Span[] = [];
  for (const span of raw) {
    const trimmed = trimSpan(line, span.start, span.end);
    if (trimmed.end > trimmed.start) spans.push(trimmed);
  }
  return spans;
}

/** For a sentence longer than the limit: the 160-character window holding the most token matches. */
function windowAround(line: string, span: Span, tokens: readonly string[]): Span {
  const sentence = line.slice(span.start, span.end);
  const lowered = sentence.toLowerCase();
  const hay = lowered.length === sentence.length ? lowered : sentence;

  const positions: number[] = [];
  for (const token of tokens) {
    let from = 0;
    let found = 0;
    while (found < MAX_POSITIONS_PER_TOKEN) {
      const at = hay.indexOf(token, from);
      if (at === -1) break;
      positions.push(at);
      found += 1;
      from = at + 1;
    }
  }

  const maxStart = sentence.length - SNIPPET_MAX_CHARS;
  let bestStart = 0;
  if (positions.length > 0 && maxStart > 0) {
    const candidates: number[] = [];
    for (let s = 0; s <= maxStart; s += 8) candidates.push(s);
    if (candidates[candidates.length - 1] !== maxStart) candidates.push(maxStart);
    let bestCount = -1;
    for (const candidate of candidates) {
      let count = 0;
      for (const position of positions) {
        if (position >= candidate && position < candidate + SNIPPET_MAX_CHARS) count += 1;
      }
      if (count > bestCount) {
        bestCount = count;
        bestStart = candidate;
      }
    }
  }

  const absoluteStart = span.start + bestStart;
  return { start: absoluteStart, end: Math.min(span.end, absoluteStart + SNIPPET_MAX_CHARS) };
}

/** Never cut a surrogate pair in half. */
function clampToCodePoints(line: string, start: number, end: number): Span {
  let s = start;
  let e = end;
  const first = line.charCodeAt(s);
  if (first >= 0xdc00 && first <= 0xdfff) s += 1;
  const last = line.charCodeAt(e - 1);
  if (last >= 0xd800 && last <= 0xdbff) e -= 1;
  return { start: s, end: e };
}

function pickPassage(body: string, tokens: readonly string[]): string {
  const lines = body.split('\n');
  const allSpans: Span[][] = [];
  let bestLine = -1;
  let bestIndex = -1;
  let bestScore = -1;

  for (let li = 0; li < lines.length; li += 1) {
    const spans = sentenceSpans(lines[li]);
    allSpans.push(spans);
    for (let si = 0; si < spans.length; si += 1) {
      const score = countHits(lines[li].slice(spans[si].start, spans[si].end), tokens);
      if (score > bestScore) {
        bestScore = score;
        bestLine = li;
        bestIndex = si;
      }
    }
  }
  if (bestLine < 0) return '';

  const line = lines[bestLine];
  const spans = allSpans[bestLine];
  let first = bestIndex;
  let last = bestIndex;
  let start = spans[first].start;
  let end = spans[last].end;
  let range: Span;

  if (end - start > SNIPPET_MAX_CHARS) {
    range = windowAround(line, { start, end }, tokens);
  } else {
    // Widen very short passages with neighbouring sentences of the same line, up to the limit.
    let preferNext = true;
    while (end - start < SHORT_PASSAGE_CHARS) {
      const nextOk = last + 1 < spans.length && spans[last + 1].end - start <= SNIPPET_MAX_CHARS;
      const prevOk = first > 0 && end - spans[first - 1].start <= SNIPPET_MAX_CHARS;
      if (preferNext && nextOk) {
        last += 1;
        end = spans[last].end;
      } else if (prevOk) {
        first -= 1;
        start = spans[first].start;
      } else if (nextOk) {
        last += 1;
        end = spans[last].end;
      } else {
        break;
      }
      preferNext = !preferNext;
    }
    range = { start, end };
  }

  const safe = clampToCodePoints(line, range.start, range.end);
  return line.slice(safe.start, safe.end).trim();
}

/** The chunk text without its generated "【heading】" prefix line. */
function bodyOf(chunk: Chunk): string {
  const hasTitle = chunk.title.length > 0 && chunk.title !== NO_TITLE_MARK;
  const prefix = hasTitle ? '【' + chunk.title + '】\n' : '';
  return prefix.length > 0 && chunk.text.startsWith(prefix) ? chunk.text.slice(prefix.length) : chunk.text;
}

function roundScore(score: number | undefined): number {
  return typeof score === 'number' && Number.isFinite(score) ? Number(score.toFixed(2)) : 0;
}

/**
 * Builds one snippet per chunk. `scores[i]` belongs to `chunks[i]`.
 * Callers pass only chunks that reached the retrieval hit threshold.
 */
export function buildSnippets(
  question: string,
  chunks: readonly Chunk[],
  scores: readonly number[],
): Snippet[] {
  const tokens = queryTokens(question);
  const snippets: Snippet[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const text = pickPassage(bodyOf(chunk), tokens);
    if (text.length === 0) continue;
    const key = chunk.source + '\u0000' + text;
    if (seen.has(key)) continue;
    seen.add(key);
    snippets.push({
      source: chunk.source,
      title: chunk.title === NO_TITLE_MARK ? '' : chunk.title,
      text,
      score: roundScore(scores[i]),
    });
  }
  return snippets;
}
