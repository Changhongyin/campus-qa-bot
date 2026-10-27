import type { Role } from '../types';

// 24 ticks around the seal ring, a longer one every 90°.
const sealTicks = Array.from({ length: 24 }, (_, index) => {
  const angle = (index * 15 * Math.PI) / 180;
  const inner = index % 6 === 0 ? 12.2 : 13.6;
  return { x1: 18 + Math.cos(angle) * 15.5, y1: 18 + Math.sin(angle) * 15.5, x2: 18 + Math.cos(angle) * inner, y2: 18 + Math.sin(angle) * inner };
});

/**
 * Message identity: the user is a stamped measurement tag, the assistant a small
 * precision-instrument seal (calibrated ring with a pointer). Decorative only.
 */
export function MessageMark({ role }: { role: Role }) {
  if (role === 'user') return <span className="message__avatar message__avatar--tag" aria-hidden="true">我</span>;
  return (
    <span className="message__avatar message__avatar--seal" aria-hidden="true">
      <svg className="seal" viewBox="0 0 36 36" focusable="false">
        <circle className="seal__ring" cx="18" cy="18" r="16.5" />
        {sealTicks.map((tick) => <line key={`${tick.x1}-${tick.y1}`} className="seal__tick" x1={tick.x1} y1={tick.y1} x2={tick.x2} y2={tick.y2} />)}
        <path className="seal__pointer" d="M18 1.5l-2.4 -3h4.8z" transform="translate(0 3)" />
      </svg>
      <span className="seal__glyph">量</span>
    </span>
  );
}
