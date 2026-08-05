// Unit switching for the configurator form.
//
// The planner reads every length in whatever unit the form's selector says
// (LENGTH_FIELDS in wheel.js), so the numbers sitting in the inputs only mean
// something together with that selector. Flipping it therefore has to rewrite
// them: a millimetre number left behind after a switch to inches is silently
// inflated 25.4× — a 220 mm bed becomes 5588 mm, clamps to the 2000 mm limit,
// and a 14″ wheel "prints in one piece" on it.
//
// Presets flip the selector too. They carry their own wheel and bore numbers
// and write them afterwards, but they say nothing about the printer envelope
// or the two clearances — those stay the user's, and converting is the only
// way to keep them meaning what the user set.

import { IN, LENGTH_FIELDS } from './wheel.js';

// Form input id ↔ planner param path, one entry per length the planner
// converts. The tests check this against LENGTH_FIELDS, so a new length
// parameter cannot ship without its form field being switched too.
export const LENGTH_INPUTS = Object.freeze([
  { id: 'diameter', path: ['diameter'] },
  { id: 'width', path: ['width'] },
  { id: 'treadDepth', path: ['treadDepth'] },
  { id: 'boreDiameter', path: ['bore', 'diameter'] },
  { id: 'keyWidth', path: ['bore', 'keyWidth'] },
  { id: 'keyDepth', path: ['bore', 'keyDepth'] },
  { id: 'hexAcrossFlats', path: ['bore', 'hexAcrossFlats'] },
  { id: 'flatOffset', path: ['bore', 'flatOffset'] },
  { id: 'boltCircle', path: ['bore', 'boltCircle'] },
  { id: 'boltHoleDia', path: ['bore', 'boltHoleDia'] },
  { id: 'pilotDia', path: ['bore', 'pilotDia'] },
  { id: 'hcCellSize', path: ['honeycomb', 'cellSize'] },
  { id: 'hcWall', path: ['honeycomb', 'wall'] },
  { id: 'hcCornerRadius', path: ['honeycomb', 'cornerRadius'] },
  { id: 'ltStrutWidth', path: ['lattice', 'strutWidth'] },
  { id: 'ltCornerRadius', path: ['lattice', 'cornerRadius'] },
  { id: 'axCellSize', path: ['auxetic', 'cellSize'] },
  { id: 'axWall', path: ['auxetic', 'wall'] },
  { id: 'axCornerRadius', path: ['auxetic', 'cornerRadius'] },
  { id: 'voWall', path: ['voronoi', 'wall'] },
  { id: 'voCornerRadius', path: ['voronoi', 'cornerRadius'] },
  { id: 'printerX', path: ['printer', 'x'] },
  { id: 'printerY', path: ['printer', 'y'] },
  { id: 'printerZ', path: ['printer', 'z'] },
  { id: 'printerMargin', path: ['printer', 'margin'] },
  { id: 'jointClearance', path: ['joint', 'clearance'] },
  { id: 'boreClearance', path: ['boreClearance'] },
]);

// Paths the form does not expose yet would silently keep their old numbers
// across a switch, so fail loudly here rather than in someone's build plan.
const missing = LENGTH_FIELDS.filter(
  (path) => !LENGTH_INPUTS.some((f) => f.path.join('.') === path.join('.'))
);
if (missing.length) {
  throw new Error(`units.js: no form input for length parameter(s) ${missing.map((p) => p.join('.')).join(', ')}`);
}

const mmPer = (units) => (units === 'in' ? IN : 1);

// Decimals kept per unit: 0.1 µm in millimetres, 0.025 µm in inches. Both are
// finer than any printer resolves, and coarse enough to absorb the conversion
// residue — so a value the form can hold survives mm → in → mm exactly
// (2.6 mm comes back as 2.6, not 2.59999).
const DECIMALS = { mm: 4, in: 6 };

// The same physical length, expressed in `to`.
export function convertLength(v, from, to) {
  if (from === to || !Number.isFinite(v) || v === 0) return v;
  const f = 10 ** (DECIMALS[to] ?? 4);
  return Math.round(((v * mmPer(from)) / mmPer(to)) * f) / f;
}

// A millimetre default (DEFAULTS in wheel.js) as the form's current unit.
export const fromMm = (mm, units) => convertLength(mm, 'mm', units);

// Does this input hold a length? The per-web-style tuning groups mix lengths
// with counts and ratios, and the form asks here rather than tracking it
// twice — a field the switch converts is exactly a field whose millimetre
// default has to be converted before it is written.
export const isLengthInput = (id) => LENGTH_INPUTS.some((f) => f.id === id);

// Rewrite every length input so it describes the same physical size in the
// new unit. `store` is { get(id), set(id, value) } — the DOM inputs in the
// app, a plain record in the tests. Blank and non-numeric entries are left
// alone, and so is 0, which means "auto" on several of these fields.
export function convertFormUnits(store, from, to) {
  if (from === to) return;
  for (const { id } of LENGTH_INPUTS) {
    const raw = store.get(id);
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    store.set(id, convertLength(v, from, to));
  }
}
