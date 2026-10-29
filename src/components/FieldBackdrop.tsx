import type { CSSProperties, ReactNode } from 'react';
import emblem from '../assets/cjlu-emblem.png';

/**
 * Shared decorative frame behind both views: survey grid, contours, edge scales, an optical
 * reticle and a few faint instruments. Every moving part is its own small element so it moves
 * by transform/opacity alone and never repaints the page.
 */

const CX = 1080;
const CY = 360;
const RING = 196;

// One tick per 5°, a longer tick every 30°.
const ticks = Array.from({ length: 72 }, (_, index) => {
  const angle = (index * 5 * Math.PI) / 180;
  const length = index % 6 === 0 ? 16 : 7;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x1: CX + cos * RING, y1: CY + sin * RING, x2: CX + cos * (RING - length), y2: CY + sin * (RING - length), major: index % 6 === 0 };
});

const contours = [
  'M-40 690 C 180 610 360 720 560 650 S 900 520 1120 590 S 1380 700 1500 640',
  'M-40 742 C 200 668 380 772 590 706 S 930 590 1150 650 S 1400 750 1500 700',
  'M-40 796 C 220 730 400 826 620 764 S 960 660 1180 712 S 1420 800 1500 762',
  'M-40 852 C 240 794 430 880 650 824 S 990 732 1210 776 S 1440 852 1500 826',
  'M140 140 C 260 96 380 132 420 196 S 360 316 240 300 S 70 214 140 140 Z',
  'M178 160 C 262 130 346 156 372 202 S 330 282 248 272 S 126 214 178 160 Z',
];
const CONTOUR_BOX: Box[] = [[-60, 500, 1580, 400], [-60, 500, 1580, 400], [-60, 500, 1580, 400], [-60, 500, 1580, 400],
  [40, 60, 420, 290], [40, 60, 420, 290]];

// Survey control points placed on major grid intersections.
const marks = [[240, 480], [720, 120], [1320, 720], [600, 840]];

/** [x, y, width, height] in the 1440x900 stage. */
type Box = [number, number, number, number];

/** Places a piece on the stage, which maps 1440x900 to the viewport like `xMidYMid slice`. */
const at = ([x, y, w, h]: Box, extra?: CSSProperties): CSSProperties => ({
  left: `${(x / 1440) * 100}%`, top: `${(y / 900) * 100}%`, width: `${(w / 1440) * 100}%`, height: `${(h / 900) * 100}%`, ...extra,
});

function Piece({ box, className, style, children }: { box: Box; className: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <svg className={`field__piece ${className}`} style={at(box, style)} viewBox={box.join(' ')} focusable="false">
      {children}
    </svg>
  );
}

// Vernier caliper, bottom left: beam with its scale, fixed and sliding jaws, the vernier plate.
const CAL_X0 = 60;
const CAL_X1 = 500;
const caliperTicks = Array.from({ length: 50 }, (_, i) => {
  const x = CAL_X0 + 40 + i * 8;
  return `M${x} 800V${i % 5 === 0 ? 788 : 794}`;
}).join('');
const vernierTicks = Array.from({ length: 11 }, (_, i) => `M${300 + i * 7.2} 822V${i % 5 === 0 ? 834 : 829}`).join('');

// Protractor, bottom right: a half circle with a tick every 5°, longer every 30°.
const PX = 1285;
const PY = 860;
const PR = 120;
const protractorTicks = Array.from({ length: 37 }, (_, i) => {
  const a = Math.PI - (i * 5 * Math.PI) / 180;
  const len = i % 6 === 0 ? 14 : 6;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return `M${PX + c * PR} ${PY - s * PR}L${PX + c * (PR - len)} ${PY - s * (PR - len)}`;
}).join('');

export function FieldBackdrop() {
  return (
    <div className="field" aria-hidden="true">
      <span className="field__scale field__scale--top" />
      <span className="field__scale field__scale--left" />
      <img className="field__emblem" src={emblem} alt="" draggable={false} />
      <div className="field__stage">
        {contours.map((d, i) => (
          <Piece key={d} box={CONTOUR_BOX[i]} className="field__contour" style={{ '--n': i } as CSSProperties}>
            <path className={i >= 4 ? 'is-loop' : undefined} d={d} pathLength={1} />
          </Piece>
        ))}
        {marks.map(([x, y], i) => (
          <Piece key={`${x}-${y}`} box={[x - 12, y - 12, 24, 24]} className="field__mark" style={{ '--n': i } as CSSProperties}>
            <path d={`M${x - 9} ${y}H${x + 9}M${x} ${y - 9}V${y + 9}`} />
          </Piece>
        ))}

        <div className="field__reticle" style={at([CX - 260, CY - 260, 520, 520])}>
          <div className="field__reticle-drift">
            <svg className="field__layer" viewBox={`${CX - 260} ${CY - 260} 520 520`} focusable="false">
              <circle className="field__lens" cx={CX} cy={CY} r={RING + 18} />
              <circle className="field__lens field__lens--inner" cx={CX} cy={CY} r={RING * 0.46} pathLength={1} />
              <path className="field__cross" d={`M${CX - RING + 24} ${CY}H${CX - 26}M${CX + 26} ${CY}H${CX + RING - 24}M${CX} ${CY - RING + 24}V${CY - 26}M${CX} ${CY + 26}V${CY + RING - 24}`} />
              <path className="field__pointer" d={`M${CX} ${CY - RING - 12}l-6 -11h12z`} />
            </svg>
            <div className="field__ticks-in">
              <svg className="field__layer field__ticks" viewBox={`${CX - 260} ${CY - 260} 520 520`} focusable="false">
                {ticks.map((tick) => (
                  <line key={`${tick.x1}-${tick.y1}`} className={tick.major ? 'is-major' : undefined} x1={tick.x1} y1={tick.y1} x2={tick.x2} y2={tick.y2} />
                ))}
              </svg>
            </div>
          </div>
        </div>

        <Piece box={[40, 770, 480, 110]} className="field__tool field__caliper">
          <path d={`M${CAL_X0} 800H${CAL_X1}V822H${CAL_X0}Z`} />
          <path d={caliperTicks} />
          <path d={`M${CAL_X0} 822V872H${CAL_X0 + 26}L${CAL_X0 + 34} 822M${CAL_X0} 800V782H${CAL_X0 + 12}V800`} />
          <path d="M290 796H380V830H290ZM290 830V862H312L318 830M290 796V780H300V796" />
          <path d={vernierTicks} />
        </Piece>

        <Piece box={[470, 40, 220, 190]} className="field__tool">
          <path d="M580 76V200M548 200H612M562 200L580 186L598 200" />
        </Piece>
        <Piece box={[470, 40, 220, 190]} className="field__tool field__balance">
          <path d="M490 80H670M580 80V72" />
          <circle cx={580} cy={72} r={4} />
          <path d="M490 80L470 146M490 80L510 146M466 146Q490 162 514 146Z" />
          <path d="M670 80L650 146M670 80L690 146M646 146Q670 162 694 146Z" />
        </Piece>

        <Piece box={[1150, 720, 270, 160]} className="field__tool">
          <path d={`M${PX - PR - 10} ${PY}H${PX + PR + 10}M${PX - PR} ${PY}A${PR} ${PR} 0 0 1 ${PX + PR} ${PY}`} />
          <path d={protractorTicks} />
          <path d={`M${PX - PR * 0.55} ${PY}A${PR * 0.55} ${PR * 0.55} 0 0 1 ${PX + PR * 0.55} ${PY}`} />
          <circle cx={PX} cy={PY} r={3} />
        </Piece>

        <Piece box={[1370, 0, 50, 340]} className="field__tool field__plumb">
          <path d="M1395 0V288" />
          <path d="M1386 288H1404L1395 326Z" />
        </Piece>

        <Piece box={[620, 844, 240, 42]} className="field__tool">
          <rect x={630} y={852} width={220} height={24} rx={12} />
          <path d="M724 852V876M756 852V876" />
        </Piece>
        <Piece box={[620, 844, 240, 42]} className="field__tool field__bubble">
          <ellipse cx={740} cy={864} rx={13} ry={7} />
        </Piece>
      </div>
    </div>
  );
}
