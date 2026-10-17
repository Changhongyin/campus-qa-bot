/**
 * Pure builders for the visible "thought" events of the SSE stream.
 * No I/O. Every text is zh-CN, at most 48 characters, free of emoji, and only
 * reports facts produced by the current request.
 */

export const THOUGHT_STAGES = ['intent', 'retrieve', 'rank', 'compose'] as const;
export type ThoughtStage = (typeof THOUGHT_STAGES)[number];

export const THOUGHT_MAX_CHARS = 48;

export interface Snippet {
  source: string;
  title: string;
  text: string;
  score: number;
}

export interface RetrieveDetail {
  hits: number;
  sources: string[];
  topScore: number;
}

export interface Thought {
  stage: ThoughtStage;
  text: string;
  ms: number;
  detail?: RetrieveDetail;
  snippets?: Snippet[];
}

export type IntentDecision = 'campus' | 'offtopic' | 'unknown';
/** How the intent was decided: quick rules, earlier conversation context, or the offline fallback. */
export type IntentVia = 'rules' | 'context' | 'fallback';

function fit(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= THOUGHT_MAX_CHARS) return text;
  return chars.slice(0, THOUGHT_MAX_CHARS - 1).join('') + '…';
}

function cleanMs(ms: number): number {
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
}

function cleanScore(score: number): number {
  return Number.isFinite(score) ? Number(score.toFixed(2)) : 0;
}

export function intentThought(input: { decision: IntentDecision; ms: number; via?: IntentVia }): Thought {
  const via = input.via ?? 'rules';
  let text: string;
  if (input.decision === 'unknown') {
    text = '规则初筛已完成，正在确认是否为校园问题';
  } else if (input.decision === 'campus') {
    text = via === 'context' ? '结合上文，识别为校园相关问题' : '已识别为校园相关问题';
  } else {
    text = via === 'fallback' ? '规则未能确认与校园相关' : '识别为与校园无关的问题';
  }
  return { stage: 'intent', text: fit(text), ms: cleanMs(input.ms) };
}

export function retrieveThought(input: {
  hits: number;
  sources: string[];
  topScore: number;
  ms: number;
  snippets?: Snippet[];
}): Thought {
  const hits = Math.max(0, Math.floor(Number.isFinite(input.hits) ? input.hits : 0));
  const topScore = cleanScore(input.topScore);
  const score = topScore.toFixed(2);
  const sources = input.sources.filter((name) => name.length > 0);

  let text: string;
  if (hits === 0) {
    text = '未找到足够相关的资料（最高相似度 ' + score + '）';
  } else {
    const variants = [
      '找到 ' + hits + ' 段相关资料：' + sources.join('、') + '（相似度 ' + score + '）',
      '找到 ' + hits + ' 段相关资料，来自 ' + sources.length + ' 个文件（相似度 ' + score + '）',
      '找到 ' + hits + ' 段相关资料（相似度 ' + score + '）',
    ];
    text = variants.find((variant) => Array.from(variant).length <= THOUGHT_MAX_CHARS) ?? variants[2];
  }

  const thought: Thought = {
    stage: 'retrieve',
    text: fit(text),
    ms: cleanMs(input.ms),
    detail: { hits, sources: [...sources], topScore },
  };
  if (input.snippets && input.snippets.length > 0) thought.snippets = input.snippets;
  return thought;
}

export function rankThought(input: { ms: number }): Thought {
  return { stage: 'rank', text: '已按相关度排序资料', ms: cleanMs(input.ms) };
}

export function composeThought(input: {
  ms: number;
  mode?: 'deepseek' | 'offline';
  refusal?: boolean;
}): Thought {
  let text: string;
  if (input.refusal) {
    text = '不检索资料，直接给出回复';
  } else if (input.mode === 'offline') {
    text = '离线模式：直接整理知识库内容';
  } else {
    text = '开始组织回答';
  }
  return { stage: 'compose', text: fit(text), ms: cleanMs(input.ms) };
}
