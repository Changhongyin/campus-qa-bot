import type { CSSProperties } from 'react';

const MAX_GROUP = 4;
const BREAKABLE = /^[\s\p{P}]+$/u;

interface Segment { segment: string; isWordLike?: boolean }
type SegmenterCtor = new (locale: string, options: { granularity: 'word' }) => { segment: (text: string) => Iterable<Segment> };

function tokens(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (Segmenter) return Array.from(new Segmenter('zh', { granularity: 'word' }).segment(text), (item) => item.segment);
  return Array.from(text);
}

/** Splits copy into short phrase groups; joining the result always returns the original text. */
export function splitFragments(text: string): string[] {
  const groups: string[] = [];
  let current = '';
  for (const token of tokens(text)) {
    if (BREAKABLE.test(token)) { current += token; continue; }
    if (current && (BREAKABLE.test(current.slice(-1)) || Array.from(current + token).length > MAX_GROUP)) {
      groups.push(current);
      current = '';
    }
    current += token;
  }
  if (current) groups.push(current);
  return groups;
}

interface RevealTextProps {
  text: string;
  /** Position of the first fragment in the page-wide left-to-right sequence. */
  order: number;
}

/**
 * Renders copy as staggered fragments for sighted users while screen readers
 * receive the unbroken original text.
 */
export function RevealText({ text, order }: RevealTextProps) {
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {splitFragments(text).map((fragment, index) => {
          const i = order + index;
          // Each fragment drifts on its own period so the page never moves in unison.
          const style = { '--i': i, '--drift-period': `${7 + ((i * 7) % 11) * 0.4}s` } as CSSProperties;
          return <span className="fragment" key={`${i}-${fragment}`} style={style}>{fragment}</span>;
        })}
      </span>
    </>
  );
}
