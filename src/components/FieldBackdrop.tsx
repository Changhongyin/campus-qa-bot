import type { CSSProperties, ReactNode } from 'react';

/**
 * Shared decorative frame behind both views: survey grid, edge scales and, around the content,
 * one instrument per zone. Zones (1440x900 stage units) are chosen to stay clear of the landing's
 * reading column and capability sheet at every desktop size; no two motifs share an area.
 *
 *   (edge scales run along the top and left edges, outside every zone)
 *   top band       caliper (left) · balance (middle) · protractor (right)
 *   right edge     plumb line
 *   left margin    two survey marks
 *   bottom band    tide contours (left) · level (middle)
 *   below sheet    optical reticle
 *
 * Every moving part is its own small element, moved by transform/opacity alone.
 */

/** [x, y, width, height] in the 1440x900 stage. */
type Box = [number, number, number, number];

/** Places a piece on the stage, which maps 1440x900 to the viewport like `xMidYMid slice`. */
const at = ([x, y, w, h]: Box, extra?: CSSProperties): CSSProperties => ({
  left: `${(x / 1440) * 100}%`, top: `${(y / 900) * 100}%`, width: `${(w / 1440) * 100}%`, height: `${(h / 900) * 100}%`, ...extra,
});

function Piece({ box, motif, className, style, children }: {
  box: Box; motif: string; className: string; style?: CSSProperties; children: ReactNode;
}) {
  return (
    <svg className={`field__piece ${className}`} data-motif={motif} style={at(box, style)} viewBox={box.join(' ')} focusable="false">
      {children}
    </svg>
  );
}

// Reticle, below the capability sheet: lens, crosshair, a tick every 10° (longer every 30°).
const CX = 1100;
const CY = 772;
const RING = 126;
const RETICLE: Box = [CX - 170, CY - 170, 340, 340];
const ticks = Array.from({ length: 36 }, (_, index) => {
  const angle = (index * 10 * Math.PI) / 180;
  const length = index % 3 === 0 ? 13 : 6;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x1: CX + cos * RING, y1: CY + sin * RING, x2: CX + cos * (RING - length), y2: CY + sin * (RING - length), major: index % 3 === 0 };
});

// Tide contours, the left of the bottom band.
const CONTOUR: Box = [30, 730, 526, 165];
const contours = [
  'M30 772 C 124 746 212 792 310 770 S 472 742 556 762',
  'M30 812 C 134 788 226 830 324 810 S 482 784 556 802',
  'M30 852 C 144 830 242 868 342 850 S 490 826 556 842',
];

// Survey control points down the left margin.
const marks = [[40, 330], [40, 610]];

// Vernier caliper, the left of the top band: beam and scale, fixed and sliding jaws, vernier plate.
const caliperTicks = Array.from({ length: 46 }, (_, i) => `M${200 + i * 8} 70V${i % 5 === 0 ? 58 : 64}`).join('');
const vernierTicks = Array.from({ length: 11 }, (_, i) => `M${410 + i * 7.2} 92V${i % 5 === 0 ? 104 : 99}`).join('');

// Protractor, the right of the top band: a half circle with a tick every 5°, longer every 30°.
const PX = 1195;
const PY = 155;
const PR = 110;
const protractorTicks = Array.from({ length: 37 }, (_, i) => {
  const a = Math.PI - (i * 5 * Math.PI) / 180;
  const len = i % 6 === 0 ? 13 : 6;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return `M${PX + c * PR} ${PY - s * PR}L${PX + c * (PR - len)} ${PY - s * (PR - len)}`;
}).join('');

export function FieldBackdrop() {
  return (
    <div className="field" aria-hidden="true">
      <span className="field__scale field__scale--top" data-motif="scale-top" />
      <span className="field__scale field__scale--left" data-motif="scale-left" />
      <div className="field__stage">
        {contours.map((d, i) => (
          <Piece key={d} box={CONTOUR} motif="contours" className="field__contour" style={{ '--n': i } as CSSProperties}>
            <path d={d} pathLength={1} />
          </Piece>
        ))}

        {marks.map(([x, y], i) => (
          <Piece key={`${x}-${y}`} box={[x - 12, y - 12, 24, 24]} motif={`mark-${i}`} className="field__mark" style={{ '--n': i } as CSSProperties}>
            <path d={`M${x - 9} ${y}H${x + 9}M${x} ${y - 9}V${y + 9}`} />
          </Piece>
        ))}

        <div className="field__reticle" data-motif="reticle" style={at(RETICLE)}>
          <div className="field__reticle-drift">
            <svg className="field__layer" viewBox={RETICLE.join(' ')} focusable="false">
              <circle className="field__lens" cx={CX} cy={CY} r={RING + 18} />
              <circle className="field__lens field__lens--inner" cx={CX} cy={CY} r={RING * 0.46} pathLength={1} />
              <path className="field__cross" d={`M${CX - RING + 20} ${CY}H${CX - 22}M${CX + 22} ${CY}H${CX + RING - 20}M${CX} ${CY - RING + 20}V${CY - 22}M${CX} ${CY + 22}V${CY + RING - 20}`} />
              <path className="field__pointer" d={`M${CX} ${CY - RING - 10}l-5 -9h10z`} />
            </svg>
            <div className="field__ticks-in">
              <svg className="field__layer field__ticks" viewBox={RETICLE.join(' ')} focusable="false">
                {ticks.map((tick) => (
                  <line key={`${tick.x1}-${tick.y1}`} className={tick.major ? 'is-major' : undefined} x1={tick.x1} y1={tick.y1} x2={tick.x2} y2={tick.y2} />
                ))}
              </svg>
            </div>
          </div>
        </div>

        <Piece box={[160, 40, 480, 110]} motif="caliper" className="field__tool field__caliper">
          <path d="M160 70H640V92H160Z" />
          <path d={caliperTicks} />
          <path d="M160 92V140H186L194 92M160 70V52H172V70" />
          <path d="M400 66H490V100H400ZM400 100V132H422L428 100M400 66V50H410V66" />
          <path d={vernierTicks} />
        </Piece>

        <Piece box={[760, 24, 200, 140]} motif="balance" className="field__tool">
          <path d="M860 56V150M828 150H892M842 150L860 138L878 150" />
        </Piece>
        <Piece box={[760, 24, 200, 140]} motif="balance" className="field__tool field__balance">
          <path d="M780 60H940M860 60V52" />
          <circle cx={860} cy={52} r={4} />
          <path d="M780 60L762 116M780 60L798 116M758 116Q780 130 802 116Z" />
          <path d="M940 60L922 116M940 60L958 116M918 116Q940 130 962 116Z" />
        </Piece>

        <Piece box={[1060, 30, 270, 135]} motif="protractor" className="field__tool">
          <path d={`M${PX - PR - 10} ${PY}H${PX + PR + 10}M${PX - PR} ${PY}A${PR} ${PR} 0 0 1 ${PX + PR} ${PY}`} />
          <path d={protractorTicks} />
          <path d={`M${PX - PR * 0.55} ${PY}A${PR * 0.55} ${PR * 0.55} 0 0 1 ${PX + PR * 0.55} ${PY}`} />
          <circle cx={PX} cy={PY} r={3} />
        </Piece>

        <Piece box={[1375, 26, 50, 410]} motif="plumb" className="field__tool field__plumb">
          <path d="M1388 26H1412M1400 26V380" />
          <path d="M1391 380H1409L1400 418Z" />
        </Piece>

        <Piece box={[585, 846, 180, 40]} motif="level" className="field__tool">
          <rect x={595} y={854} width={160} height={24} rx={12} />
          <path d="M663 854V878M687 854V878" />
        </Piece>
        <Piece box={[585, 846, 180, 40]} motif="level" className="field__tool field__bubble">
          <ellipse cx={675} cy={866} rx={11} ry={6} />
        </Piece>
      </div>
    </div>
  );
}
