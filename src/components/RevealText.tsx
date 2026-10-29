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
  let char = 0;
  return (
    <>
      <span className="sr-only">{text}</span>
      <span aria-hidden="true">
        {splitFragments(text).map((fragment, index) => {
          const i = order + index;
          // The reveal animates the fragment; each character floats in its own span, one phase
          // step after its neighbour, so a single wave travels through the line.
          return (
            <span className="fragment" key={`${i}-${fragment}`} style={{ '--i': i } as CSSProperties}>
              {Array.from(fragment, (glyph, k) => (
                <span className="fragment__float" key={k} style={{ '--c': char++ } as CSSProperties}>{glyph}</span>
              ))}
            </span>
          );
        })}
      </span>
    </>
  );
}
