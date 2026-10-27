/** Shared decorative frame behind both views: survey grid, contours, edge scales and an optical reticle. */

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

// Survey control points placed on major grid intersections.
const marks = [[240, 480], [720, 120], [1320, 720], [600, 840]];

export function FieldBackdrop() {
  return (
    <div className="field" aria-hidden="true">
      <span className="field__scale field__scale--top" />
      <span className="field__scale field__scale--left" />
      <svg className="field__art" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice" focusable="false">
        <g className="field__contours">
          {contours.map((d) => <path key={d} d={d} pathLength={1} />)}
        </g>
        <g className="field__marks">
          {marks.map(([x, y]) => <path key={`${x}-${y}`} d={`M${x - 9} ${y}H${x + 9}M${x} ${y - 9}V${y + 9}`} />)}
        </g>
        <g className="field__reticle">
          <circle className="field__lens" cx={CX} cy={CY} r={RING + 18} />
          <circle className="field__lens field__lens--inner" cx={CX} cy={CY} r={RING * 0.46} pathLength={1} />
          <path className="field__cross" d={`M${CX - RING + 24} ${CY}H${CX - 26}M${CX + 26} ${CY}H${CX + RING - 24}M${CX} ${CY - RING + 24}V${CY - 26}M${CX} ${CY + 26}V${CY + RING - 24}`} />
          <g className="field__ticks">
            {ticks.map((tick) => (
              <line key={`${tick.x1}-${tick.y1}`} className={tick.major ? 'is-major' : undefined} x1={tick.x1} y1={tick.y1} x2={tick.x2} y2={tick.y2} />
            ))}
            <path className="field__pointer" d={`M${CX} ${CY - RING - 12}l-6 -11h12z`} />
          </g>
        </g>
      </svg>
    </div>
  );
}
