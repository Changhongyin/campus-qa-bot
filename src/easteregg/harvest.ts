/** One visible character of the page, captured where and how it is drawn right now. */
export interface Glyph {
  ch: string;
  /** Left edge and alphabetic baseline, in viewport pixels. */
  x: number;
  baseline: number;
  /** Centre of the character box. */
  cx: number;
  cy: number;
  font: string;
  rgb: [number, number, number];
}

export interface Harvest {
  glyphs: Glyph[];
  seal: DOMRect | null;
  scale: DOMRect | null;
}

function parseRgb(value: string): [number, number, number] {
  const match = value.match(/[\d.]+/g);
  return match && match.length >= 3 ? [Number(match[0]), Number(match[1]), Number(match[2])] : [27, 42, 68];
}

/**
 * Reads every visible character inside `root` in reading order, so the canvas can take over
 * drawing them in the same frame the DOM text is hidden. Must run before the page changes.
 */
export function harvest(root: HTMLElement | null): Harvest {
  const empty: Harvest = { glyphs: [], seal: null, scale: null };
  if (!root) return empty;
  const measure = document.createElement('canvas').getContext('2d');
  if (!measure) return empty;

  const glyphs: Glyph[] = [];
  const range = document.createRange();
  const limitTop = -window.innerHeight * 0.5;
  const limitBottom = window.innerHeight * 1.5;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest('.sr-only, .brand-mark') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    const text = node.textContent ?? '';
    if (!parent || !text.trim()) continue;
    const style = getComputedStyle(parent);
    if (style.visibility === 'hidden' || Number(style.opacity) < 0.05) continue;
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    measure.font = font;
    const metrics = measure.measureText('量');
    const ascent = metrics.fontBoundingBoxAscent || parseFloat(style.fontSize) * 0.88;
    const descent = metrics.fontBoundingBoxDescent || parseFloat(style.fontSize) * 0.12;
    const rgb = parseRgb(style.color);

    let offset = 0;
    for (const ch of text) {
      if (ch.trim()) {
        range.setStart(node, offset);
        range.setEnd(node, offset + ch.length);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 && rect.bottom > limitTop && rect.top < limitBottom) {
          glyphs.push({
            ch,
            x: rect.left,
            baseline: rect.top + (rect.height - ascent - descent) / 2 + ascent,
            cx: rect.left + rect.width / 2,
            cy: rect.top + rect.height / 2,
            font,
            rgb,
          });
        }
      }
      offset += ch.length;
    }
  }
  range.detach();

  return {
    glyphs,
    seal: root.querySelector('.brand-mark')?.getBoundingClientRect() ?? null,
    scale: root.querySelector('.landing__scale')?.getBoundingClientRect() ?? null,
  };
}
