// Wheelwright — core geometry planner.
//
// Pure ESM module shared by the Node server and the browser preview.
// Everything is derived parametrically from user input: segment count from
// the printer envelope, dovetail joint sizing from the available material
// bands, infill/tread/hub feature layout, and per-piece deduplication.
//
// All internal math is in millimetres. Angles in degrees unless noted.
//
// The output "plan" contains, per unique piece, a 2D outline (lines + arcs,
// dovetail tenons/pockets integrated) and a list of cutter prisms
// (profile + z-range), plus one tool of revolution for the tire's running
// surface. Both the build-script generator and the Three.js preview consume
// this same plan, so the preview matches the generated CAD.

export const IN = 25.4;

// Web styles the planner knows how to lay out.
const WEB_STYLES = ['solid', 'spokes', 'honeycomb', 'flexweb', 'lattice', 'auxetic', 'graded', 'voronoi'];

// Per-segment void budget for the chart-drawn webs. Every void is a boolean
// tool downstream, so the count has to stay somewhere the kernel (and the
// browser preview's triangulator) is comfortable.
const WEB_CELL_CAP = 120;

const d2r = (d) => (d * Math.PI) / 180;
const r2d = (r) => (r * 180) / Math.PI;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const polar = (r, aDeg) => [r * Math.cos(d2r(aDeg)), r * Math.sin(d2r(aDeg))];
const mod = (a, m) => ((a % m) + m) % m;
const rnd = (v, p = 3) => {
  const f = 10 ** p;
  const x = Math.round(v * f) / f;
  return Object.is(x, -0) ? 0 : x;
};

export const DEFAULTS = Object.freeze({
  units: 'mm', // interpretation of the numeric length fields below
  diameter: 355.6, // 14in airless-cart-wheel demo default
  width: 50,
  material: 'petg', // pla | petg | abs | tpu
  infill: 'spokes', // solid | spokes | honeycomb | flexweb | lattice | auxetic | graded | voronoi
  spokeCount: 0, // 0 = auto
  tread: 'lugged', // slick | ribbed | lugged | diamond | chevron | angled
  treadDepth: 3.5,
  treadCount: 0, // bars around the wheel; 0 = auto from the circumference
  treadAngle: 25, // bar slant off the axis, degrees (angled | chevron)
  ribCount: 0, // circumferential grooves (ribbed | diamond); 0 = auto
  profile: {
    shape: 'flat', // flat | crowned | round
    crownDrop: 0, // mm the tread radius falls from mid-width to each shoulder; 0 = auto
  },
  bore: {
    type: 'keyed', // plain | keyed | hex | dbore | bolt
    diameter: 20,
    keyWidth: 6,
    keyDepth: 2.8,
    hexAcrossFlats: 13,
    flatOffset: 0, // dbore: center→flat distance; 0 = auto (0.75 × radius)
    boltCount: 4,
    boltCircle: 60,
    boltHoleDia: 5.5,
    pilotDia: 12,
  },
  honeycomb: {
    cellSize: 0, // hex across-flats; 0 = auto from the web band width
    wall: 2.6, // material left between neighbouring cells
    orientation: 'radial', // radial (vertex at the rim) | tangential (flat at the rim)
    cellShape: 'hex', // hex | round
    cornerRadius: 0, // hex corner fillet; 0 = sharp, auto-capped at the inradius
    maxCells: 64, // per-segment budget; cells are grown to stay under it
  },
  lattice: {
    rows: 0, // diamond rows across the web band; 0 = auto, 1 = chevron / V-truss
    struts: 0, // struts per family around the wheel; 0 = auto
    strutWidth: 4, // material left between neighbouring cells
    cornerRadius: 1.5, // cell corner fillet; 0 = sharp
  },
  auxetic: {
    rings: 0, // cell rings across the web band; 0 = auto
    cellSize: 0, // cell width at the ring's inner radius; 0 = auto
    wall: 3, // material left between neighbouring cells
    waist: 0.45, // re-entrant pinch: waist width ÷ cell width
    cornerRadius: 1.2, // cell corner fillet; 0 = sharp
  },
  graded: {
    rings: 0, // cell rings across the web band; 0 = auto
    cells: 0, // cells around the innermost ring, for a full turn; 0 = auto
    wall: 2.6, // material left between neighbouring cells
    cellShape: 'hex', // hex | rect | diamond
    grade: 1, // 0 = every ring the same height, 1 = ring height ∝ radius
    swirl: 0, // degrees the cells lean tangentially across the band
    cornerRadius: 1.2, // cell corner fillet; 0 = sharp
  },
  voronoi: {
    cells: 0, // cells per segment; 0 = auto
    wall: 3, // material left between neighbouring cells
    seed: 1, // same seed, same web — the pattern is reproducible
    cornerRadius: 1.2, // cell corner fillet; 0 = sharp
  },
  printer: { x: 220, y: 220, z: 250, margin: 10 },
  joint: { clearance: 0.15 }, // per-side dovetail slide clearance
  boreClearance: 0.2,
  segmentsOverride: 0, // 0 = auto
});

// Every parameter carrying a length unit. The configurator form mirrors this
// list (LENGTH_INPUTS in units.js) so switching units rewrites all of them.
export const LENGTH_FIELDS = [
  ['diameter'],
  ['width'],
  ['treadDepth'],
  ['profile', 'crownDrop'],
  ['bore', 'diameter'],
  ['bore', 'keyWidth'],
  ['bore', 'keyDepth'],
  ['bore', 'hexAcrossFlats'],
  ['bore', 'flatOffset'],
  ['bore', 'boltCircle'],
  ['bore', 'boltHoleDia'],
  ['bore', 'pilotDia'],
  ['honeycomb', 'cellSize'],
  ['honeycomb', 'wall'],
  ['honeycomb', 'cornerRadius'],
  ['lattice', 'strutWidth'],
  ['lattice', 'cornerRadius'],
  ['auxetic', 'cellSize'],
  ['auxetic', 'wall'],
  ['auxetic', 'cornerRadius'],
  ['graded', 'wall'],
  ['graded', 'cornerRadius'],
  ['voronoi', 'wall'],
  ['voronoi', 'cornerRadius'],
  ['printer', 'x'],
  ['printer', 'y'],
  ['printer', 'z'],
  ['printer', 'margin'],
  ['joint', 'clearance'],
  ['boreClearance'],
];

function get(obj, path) {
  return path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function set(obj, path, v) {
  let o = obj;
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
  o[path[path.length - 1]] = v;
}

export function normalizeParams(input = {}) {
  const warnings = [];
  const p = {
    ...structuredClone(DEFAULTS),
    ...structuredClone(input),
    bore: { ...structuredClone(DEFAULTS.bore), ...structuredClone(input.bore || {}) },
    honeycomb: { ...structuredClone(DEFAULTS.honeycomb), ...structuredClone(input.honeycomb || {}) },
    lattice: { ...structuredClone(DEFAULTS.lattice), ...structuredClone(input.lattice || {}) },
    auxetic: { ...structuredClone(DEFAULTS.auxetic), ...structuredClone(input.auxetic || {}) },
    graded: { ...structuredClone(DEFAULTS.graded), ...structuredClone(input.graded || {}) },
    voronoi: { ...structuredClone(DEFAULTS.voronoi), ...structuredClone(input.voronoi || {}) },
    profile: { ...structuredClone(DEFAULTS.profile), ...structuredClone(input.profile || {}) },
    printer: { ...structuredClone(DEFAULTS.printer), ...structuredClone(input.printer || {}) },
    joint: { ...structuredClone(DEFAULTS.joint), ...structuredClone(input.joint || {}) },
  };

  // Coerce numerics (form inputs arrive as strings).
  for (const path of LENGTH_FIELDS) {
    const v = Number(get(p, path));
    set(p, path, Number.isFinite(v) ? v : Number(get(DEFAULTS, path)) || 0);
  }
  p.spokeCount = Math.max(0, Math.round(Number(p.spokeCount) || 0));
  p.segmentsOverride = Math.max(0, Math.round(Number(p.segmentsOverride) || 0));
  p.treadCount = clamp(Math.round(Number(p.treadCount) || 0), 0, 200);
  p.ribCount = clamp(Math.round(Number(p.ribCount) || 0), 0, 12);
  p.treadAngle = clamp(Number(p.treadAngle) || 0, 0, 60);
  p.bore.boltCount = clamp(Math.round(Number(p.bore.boltCount) || 4), 2, 12);
  p.honeycomb.maxCells = clamp(Math.round(Number(p.honeycomb.maxCells) || DEFAULTS.honeycomb.maxCells), 8, 240);
  p.lattice.rows = clamp(Math.round(Number(p.lattice.rows) || 0), 0, 6);
  p.lattice.struts = clamp(Math.round(Number(p.lattice.struts) || 0), 0, 96);
  p.auxetic.rings = clamp(Math.round(Number(p.auxetic.rings) || 0), 0, 6);
  p.auxetic.waist = clamp(Number(p.auxetic.waist) || DEFAULTS.auxetic.waist, 0.1, 0.9);
  p.graded.rings = clamp(Math.round(Number(p.graded.rings) || 0), 0, 8);
  p.graded.cells = clamp(Math.round(Number(p.graded.cells) || 0), 0, 240);
  p.graded.grade = clamp(Number(p.graded.grade) || 0, 0, 1);
  p.graded.swirl = clamp(Number(p.graded.swirl) || 0, -60, 60);
  p.voronoi.cells = clamp(Math.round(Number(p.voronoi.cells) || 0), 0, WEB_CELL_CAP);
  p.voronoi.seed = Math.abs(Math.round(Number(p.voronoi.seed) || 0)) % 100000;

  // Convert to mm.
  if (p.units === 'in') {
    for (const path of LENGTH_FIELDS) set(p, path, get(p, path) * IN);
    p.units = 'mm';
  }

  // Sanity clamps.
  p.diameter = clamp(p.diameter, 30, 1500);
  p.width = clamp(p.width, 6, 400);
  p.treadDepth = clamp(p.treadDepth, 0.8, Math.max(0.8, p.diameter * 0.06));
  p.joint.clearance = clamp(p.joint.clearance, 0.05, 0.6);
  p.boreClearance = clamp(p.boreClearance, 0, 1);
  p.printer.x = clamp(p.printer.x, 40, 2000);
  p.printer.y = clamp(p.printer.y, 40, 2000);
  p.printer.z = clamp(p.printer.z, 20, 2000);
  p.printer.margin = clamp(p.printer.margin, 0, 60);

  if (!['pla', 'petg', 'abs', 'tpu'].includes(p.material)) p.material = 'petg';
  if (!WEB_STYLES.includes(p.infill)) p.infill = 'spokes';
  if (!['slick', 'ribbed', 'lugged', 'diamond', 'chevron', 'angled'].includes(p.tread)) p.tread = 'lugged';
  if (!['flat', 'crowned', 'round'].includes(p.profile.shape)) p.profile.shape = 'flat';
  p.profile.crownDrop = Math.max(0, p.profile.crownDrop);
  if (!['plain', 'keyed', 'hex', 'dbore', 'bolt'].includes(p.bore.type)) p.bore.type = 'plain';
  if (!['radial', 'tangential'].includes(p.honeycomb.orientation)) p.honeycomb.orientation = 'radial';
  if (!['hex', 'round'].includes(p.honeycomb.cellShape)) p.honeycomb.cellShape = 'hex';
  p.honeycomb.cellSize = p.honeycomb.cellSize > 0 ? clamp(p.honeycomb.cellSize, 3, 250) : 0;
  p.honeycomb.wall = clamp(p.honeycomb.wall, 0.8, 25);
  p.honeycomb.cornerRadius = Math.max(0, p.honeycomb.cornerRadius);
  p.lattice.strutWidth = clamp(p.lattice.strutWidth, 1.2, 40);
  p.lattice.cornerRadius = Math.max(0, p.lattice.cornerRadius);
  p.auxetic.cellSize = p.auxetic.cellSize > 0 ? clamp(p.auxetic.cellSize, 3, 250) : 0;
  p.auxetic.wall = clamp(p.auxetic.wall, 0.8, 25);
  p.auxetic.cornerRadius = Math.max(0, p.auxetic.cornerRadius);
  if (!['hex', 'rect', 'diamond'].includes(p.graded.cellShape)) p.graded.cellShape = 'hex';
  p.graded.wall = clamp(p.graded.wall, 0.8, 25);
  p.graded.cornerRadius = Math.max(0, p.graded.cornerRadius);
  p.voronoi.wall = clamp(p.voronoi.wall, 0.8, 25);
  p.voronoi.cornerRadius = Math.max(0, p.voronoi.cornerRadius);

  const rb = p.bore.diameter / 2;
  if (p.bore.type === 'dbore') {
    if (p.bore.flatOffset <= 0 || p.bore.flatOffset >= rb) {
      p.bore.flatOffset = rnd(rb * 0.75);
    }
  }
  if (p.bore.type === 'bolt') {
    // Pilot clearance, plus enough circumference that neighbouring bolt
    // holes keep ≥3 mm of material between them.
    const minBcd = Math.max(
      p.bore.pilotDia + p.bore.boltHoleDia + 8,
      (p.bore.boltHoleDia + 3) / Math.sin(d2r(180 / p.bore.boltCount))
    );
    if (p.bore.boltCircle < minBcd) {
      p.bore.boltCircle = minBcd;
      warnings.push(`Bolt circle was too small for the pilot bore and bolt spacing; increased to ${rnd(minBcd, 1)} mm.`);
    }
  }
  if (p.bore.diameter >= p.diameter * 0.5) {
    p.bore.diameter = p.diameter * 0.3;
    warnings.push('Bore diameter was too large relative to the wheel; reduced to 30% of wheel diameter.');
  }
  return { p, warnings };
}

// ---------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------

function circumcircle(p1, p2, p3) {
  const [ax, ay] = p1;
  const [bx, by] = p2;
  const [cx, cy] = p3;
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = ax * ax + ay * ay;
  const b2 = bx * bx + by * by;
  const c2 = cx * cx + cy * cy;
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d;
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d;
  return { c: [ux, uy], r: Math.hypot(ax - ux, ay - uy) };
}

// Does angular interval [a0,a1] (degrees, a0<a1 in unwrapped form) intersect
// [b0,b1]? Handles wrap-around by testing shifted copies.
function angIntervalsOverlap(a0, a1, b0, b1) {
  for (const s of [-360, 0, 360]) {
    if (a0 + s < b1 && a1 + s > b0) return true;
  }
  return false;
}

function regularPoly(cx, cy, circumR, n, startAngleDeg) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = startAngleDeg + (i * 360) / n;
    pts.push([cx + circumR * Math.cos(d2r(a)), cy + circumR * Math.sin(d2r(a))]);
  }
  return pts;
}

const unit = (v) => {
  const L = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / L, v[1] / L];
};

// Fillet every corner of a CCW convex polygon: straight runs between tangent
// points, CCW corner arcs of radius r. Caller keeps r within what the edges
// can absorb (for a regular hexagon of circumradius cr that is cr·√3/2, where
// the tangent points meet at the edge midpoints and the shape becomes a
// circle). Returned as a closed lines+arcs loop — the 'path' cutter form.
function roundedPolySegs(pts, r) {
  const n = pts.length;
  const corners = pts.map((V, i) => {
    const P = pts[(i + n - 1) % n];
    const Nx = pts[(i + 1) % n];
    const dIn = unit([V[0] - P[0], V[1] - P[1]]);
    const dOut = unit([Nx[0] - V[0], Nx[1] - V[1]]);
    // Exterior turn angle; setback along each edge is r·tan(turn/2).
    const turn = Math.abs(Math.atan2(dIn[0] * dOut[1] - dIn[1] * dOut[0], dIn[0] * dOut[0] + dIn[1] * dOut[1]));
    const t = r * Math.tan(turn / 2);
    const t1 = [V[0] - dIn[0] * t, V[1] - dIn[1] * t];
    return {
      t1,
      t2: [V[0] + dOut[0] * t, V[1] + dOut[1] * t],
      // Center sits one radius along the inward (left-of-travel) normal.
      c: [t1[0] - dIn[1] * r, t1[1] + dIn[0] * r],
    };
  });
  const segs = [];
  for (let i = 0; i < n; i++) {
    const prev = corners[(i + n - 1) % n];
    const cur = corners[i];
    segs.push({ kind: 'line', a: prev.t2.map((v) => rnd(v)), b: cur.t1.map((v) => rnd(v)) });
    segs.push({
      kind: 'arc',
      a: cur.t1.map((v) => rnd(v)),
      b: cur.t2.map((v) => rnd(v)),
      center: cur.c.map((v) => rnd(v)),
      radius: rnd(r),
      ccw: true,
    });
  }
  return segs;
}

// Distance from the origin to segment ab (an edge can pass closer to the
// center than either endpoint).
function segDistToOrigin(a, b) {
  const d = [b[0] - a[0], b[1] - a[1]];
  const dd = d[0] * d[0] + d[1] * d[1] || 1;
  const t = clamp(-(a[0] * d[0] + a[1] * d[1]) / dd, 0, 1);
  return Math.hypot(a[0] + t * d[0], a[1] + t * d[1]);
}

function rotPt([x, y], aDeg) {
  const c = Math.cos(d2r(aDeg));
  const s = Math.sin(d2r(aDeg));
  return [x * c - y * s, x * s + y * c];
}

// ---------------------------------------------------------------------------
// The web chart — the annular web band, unrolled
// ---------------------------------------------------------------------------
// The lattice, auxetic and voronoi webs are all laid out in chart coordinates
// — θ degrees along the sector, t ∈ [0,1] across the band — and mapped back
// out with
//
//     Φ(θ, t) = polar(rWebIn + t·bandW, θ)
//
// Φ is a homeomorphism on the strip and preserves orientation, so cells laid
// out disjoint in the chart come out disjoint in the wheel. That is the same
// guarantee the honeycomb gets from being a true lattice, but it now holds
// for patterns that *curve* with the wheel instead of being a straight grid
// stamped onto an annulus.
//
// What Φ does distort is distance: one degree of θ buys r·π/180 mm of arc,
// more the further out you go. So every wall below is converted to degrees at
// the innermost radius it touches, which makes the number the user typed the
// *minimum* material anywhere along that wall.
function webChart(rWebIn, rWebOut, A, N, dFace) {
  const bandW = rWebOut - rWebIn;
  const rAt = (t) => rWebIn + t * bandW;
  return {
    rWebIn,
    rWebOut,
    bandW,
    A,
    N,
    rAt,
    // Half the angle whose chord at r(t) measures `mm` end to end — i.e. the
    // angular half-width of a `mm`-wide rib centred on a ray.
    halfDeg: (mm, t) => r2d(Math.asin(clamp(mm / 2 / rAt(t), 0, 1))),
    // Angular keep-out from each seam plane at r(t) (0 on one-piece wheels).
    seamDeg: (t) => (N === 1 ? 0 : r2d(Math.asin(clamp(dFace / rAt(t), 0, 1)))),
    xy: (th, t) => polar(rAt(t), th),
  };
}

// Chart edges come out of Φ curved and are emitted as chords, which fall
// inside the curve they replace. On a cell's inner boundary that eats into
// the wall, so the step is chosen to hold the sag under SAG_TOL and every
// wall below is padded by the same amount — belt and braces.
const SAG_TOL = 0.06; // mm

// How many chords a straight chart edge needs so none of them falls more than
// SAG_TOL inside the curve Φ draws for it. The dominant curvature is the
// wheel's own, 1/r, and a chord of length c across curvature κ sags κ·c²/8 —
// so chords stay under √(8·r·SAG_TOL). Length has to count the radial travel
// too: an edge climbing the band is longer, and bends further, than its
// angular sweep alone suggests.
function chartSteps(ch, p0, p1) {
  const arc = Math.abs(p1[0] - p0[0]) * d2r(1) * ch.rAt(Math.max(p0[1], p1[1]));
  const len = Math.hypot(Math.abs(p1[1] - p0[1]) * ch.bandW, arc);
  const maxChord = Math.sqrt(8 * Math.max(ch.rAt(Math.min(p0[1], p1[1])), 1) * SAG_TOL);
  return clamp(Math.ceil(len / maxChord), 1, 96);
}

// Points along a straight chart edge, mapped to XY. Excludes p0, includes p1,
// so concatenating the edges of a closed polygon visits each vertex once.
function chartRun(ch, p0, p1) {
  const n = chartSteps(ch, p0, p1);
  const out = [];
  for (let i = 1; i <= n; i++) {
    const u = i / n;
    out.push(ch.xy(p0[0] + (p1[0] - p0[0]) * u, p0[1] + (p1[1] - p0[1]) * u));
  }
  return out;
}

function chartPolyPoints(ch, poly) {
  const pts = [];
  for (let i = 0; i < poly.length; i++) pts.push(...chartRun(ch, poly[i], poly[(i + 1) % poly.length]));
  return pts;
}

// Round the corners of a closed XY loop. Vertices whose turn is under
// `minTurn` are left alone — those are the sampling of a smooth curve, not a
// corner. A convex corner only ever gives material back, so it is free; a
// reflex corner (the auxetic waist) grows the void instead, and `maxBulge`
// caps how far it may grow so the lattice's wall guarantee survives.
function filletLoop(pts, r, { minTurn = 16, maxBulge = Infinity } = {}) {
  if (!(r > 0.02) || pts.length < 3) return pts;
  const n = pts.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const P = pts[(i + n - 1) % n];
    const V = pts[i];
    const Q = pts[(i + 1) % n];
    const lIn = Math.hypot(V[0] - P[0], V[1] - P[1]);
    const lOut = Math.hypot(Q[0] - V[0], Q[1] - V[1]);
    if (lIn < 1e-9 || lOut < 1e-9) continue;
    const uIn = [(V[0] - P[0]) / lIn, (V[1] - P[1]) / lIn];
    const uOut = [(Q[0] - V[0]) / lOut, (Q[1] - V[1]) / lOut];
    const cz = uIn[0] * uOut[1] - uIn[1] * uOut[0];
    const turn = Math.atan2(Math.abs(cz), uIn[0] * uOut[0] + uIn[1] * uOut[1]);
    if (turn < d2r(minTurn) || turn > Math.PI - 1e-6) {
      out.push(V);
      continue;
    }
    const half = turn / 2;
    // The arc bows past the corner by r·(1/cos(turn/2) − 1); on a reflex
    // corner that bow eats into the neighbouring wall.
    let rr = cz < 0 && Number.isFinite(maxBulge) ? Math.min(r, maxBulge / (1 / Math.cos(half) - 1)) : r;
    // A fillet may not swallow more than half of either neighbouring edge.
    const setback = Math.min(rr * Math.tan(half), 0.49 * Math.min(lIn, lOut));
    if (setback < 1e-3) {
      out.push(V);
      continue;
    }
    rr = setback / Math.tan(half);
    const s = Math.sign(cz);
    const t1 = [V[0] - uIn[0] * setback, V[1] - uIn[1] * setback];
    const c = [t1[0] - s * uIn[1] * rr, t1[1] + s * uIn[0] * rr];
    const a0 = Math.atan2(t1[1] - c[1], t1[0] - c[0]);
    // Same sag budget as the chart edges, against the fillet's own radius.
    const bite = 2 * Math.acos(clamp(1 - SAG_TOL / rr, -1, 1));
    const steps = clamp(Math.ceil(turn / Math.max(bite, 1e-3)), 2, 24);
    for (let k = 0; k <= steps; k++) {
      const a = a0 + s * turn * (k / steps);
      out.push([c[0] + rr * Math.cos(a), c[1] + rr * Math.sin(a)]);
    }
  }
  return out;
}

function pointInLoop(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a[1] > pt[1] !== b[1] > pt[1] && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

// A closed XY point loop as a 'path' cutter. Consecutive duplicates are
// dropped so the emitted loop carries no zero-length entities, and the seed
// seed is checked against the finished loop — a cell whose seed a corner
// fillet ate into is dropped rather than emitted as a loop the kernel cannot
// resolve.
function loopCutter(id, pts, interior, z) {
  const q = [];
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-4;
  for (const raw of pts) {
    const p = [rnd(raw[0]), rnd(raw[1])];
    if (!q.length || !near(q[q.length - 1], p)) q.push(p);
  }
  while (q.length > 2 && near(q[0], q[q.length - 1])) q.pop();
  if (q.length < 3 || !pointInLoop(interior, q)) return null;
  return {
    id,
    shape: 'path',
    segs: q.map((a, i) => ({ kind: 'line', a, b: q[(i + 1) % q.length] })),
    interior: [rnd(interior[0]), rnd(interior[1])],
    ...z,
  };
}

// Convex polygon ∩ half-plane { p : n·p ≥ c } (Sutherland–Hodgman, one edge).
function clipHalf(poly, nx, ny, c) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const da = nx * a[0] + ny * a[1] - c;
    const db = nx * b[0] + ny * b[1] - c;
    if (da >= 0) out.push(a);
    if ((da > 0 && db < 0) || (da < 0 && db > 0)) {
      const u = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
    }
  }
  return out;
}

function polyMoments(pts) {
  let a2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const cr = p[0] * q[1] - q[0] * p[1];
    a2 += cr;
    cx += (p[0] + q[0]) * cr;
    cy += (p[1] + q[1]) * cr;
  }
  if (Math.abs(a2) < 1e-12) return { area: 0, c: pts[0] || [0, 0] };
  return { area: a2 / 2, c: [cx / (3 * a2), cy / (3 * a2)] };
}

// mulberry32 — a tiny deterministic PRNG. The voronoi web must replan to the
// exact same cells on every keystroke and on the server, so nothing here may
// touch Math.random().
function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export function planWheel(input = {}) {
  const { p, warnings } = normalizeParams(input);
  const notes = [];

  const R = p.diameter / 2;
  const W = p.width;
  const halfW = W / 2;
  const BARRED = ['lugged', 'diamond', 'chevron', 'angled'];
  const barred = BARRED.includes(p.tread);
  const ribbed = ['ribbed', 'diamond'].includes(p.tread);
  const treadCut = p.tread === 'slick' ? 0 : p.treadDepth;
  // Groove depth, measured perpendicular to the tread surface. Declared here
  // rather than with the rest of the groove layout because the band model
  // below needs it.
  const ribDepth = ribbed ? p.treadDepth * 0.85 : 0;

  // -------------------------------------------------------------------------
  // Tire cross-section (the crown)
  // -------------------------------------------------------------------------
  // The tread's outer radius across the width follows a circular arc that
  // falls `crownDrop` from the mid-width peak to each shoulder:
  //   flat    — no fall; the cylindrical rim this planner has always made
  //   crowned — a settable fall, like a car tire's shouldered section
  //   round   — the fall equals the half-width, so the section is a true
  //             semicircle: a bicycle tire.
  //
  // The curve is **cut, not drawn**. The piece profile is flat, and a single
  // revolved tool (`tire`, below) takes the crown and every circumferential
  // groove out of it in one pass, so the finished running surface is an exact
  // arc of the section circle.
  //
  // It used to be lofted through a handful of profiles instead, because the
  // hosted KCL engine refused any boolean whose operands carried curved faces.
  // That was not merely more complicated, it was wrong: a ruled loft through
  // uniformly spaced z levels is a bad way to approximate a circle, because a
  // circular section curves hardest at the shoulders — exactly where uniform
  // sampling is thinnest. On the Ø200 × 28 round preset it left the shoulder
  // 2.99 mm off the true arc, more than that tread was deep. A revolve has no
  // such error at any width.
  //
  // The bars are a consequence rather than a special case: their windows are
  // notched into the flat profile at a constant floor radius, and where the
  // crown falls past that floor it simply takes the window with it. So bars
  // stand full-depth at the centreline and fade out towards the shoulders,
  // the way a moulded tire's do.
  const crownWanted = p.profile.shape === 'round' ? halfW : p.profile.shape === 'crowned' ? (p.profile.crownDrop > 0 ? p.profile.crownDrop : clamp(W * 0.12, 1, halfW)) : 0;
  // The crown eats radius before the tread does, so it has to leave a rim
  // band and a web behind it.
  const crownDrop = rnd(clamp(crownWanted, 0, Math.max(0, Math.min(halfW, R * 0.3 - treadCut))), 3);
  if (crownWanted - crownDrop > 0.05) {
    warnings.push(
      `${p.profile.shape === 'round' ? 'A round (semicircular) section' : 'The requested crown'} would have taken ${rnd(crownWanted, 1)} mm off the shoulder radius — more than this wheel can give up; flattened to ${rnd(crownDrop, 1)} mm.`
    );
  }
  // Section arc through the mid-width peak and the two shoulders: half-width
  // h, sagitta d ⇒ radius (h² + d²)/2d. `round` gives d = h and hence ρ = h.
  const crownRadius = crownDrop > 0 ? (halfW ** 2 + crownDrop ** 2) / (2 * crownDrop) : 0;
  const crownAt = (z) =>
    crownDrop > 0 ? R - crownRadius + Math.sqrt(Math.max(0, crownRadius ** 2 - (z - halfW) ** 2)) : R;
  // The same section circle shrunk by `depth`, i.e. the surface a cutter of
  // that depth leaves behind. Concentric with the crown, so the depth it takes
  // is measured perpendicular to the tread — a groove of constant depth, not
  // one that deepens towards the shoulders. On a flat profile it is just an
  // inset cylinder.
  const surfaceR = (z, depth = 0) =>
    crownDrop > 0
      ? R - crownRadius + Math.sqrt(Math.max(0, (crownRadius - depth) ** 2 - (z - halfW) ** 2))
      : R - depth;

  // Radius of the finished running surface at height z: the crown arc, less a
  // groove where one falls. `grooveAt` is filled in once the groove bands are
  // laid out below; until then the crown is the whole story.
  let grooveAt = () => 0;
  const surfAt = (z) => crownAt(z) - grooveAt(z);

  // Radial bands: [bore .. hub ring .. web (infill) .. rim ring .. tread .. R]
  // The crown and the bar windows *overlap* rather than stack: a window floor
  // is flat at R − treadCut, and where the crown falls past it the crown wins.
  // So the rim band sits under whichever of the two is deeper, not under their
  // sum — which is what the lofted crown had to assume, and which cost every
  // crowned wheel a band of radius it never actually used.
  const treadEff = Math.max(treadCut, crownDrop + ribDepth);
  const rimBandT = clamp(R * 0.05, 6, 14);
  const rRimIn = R - treadEff - rimBandT;

  const clr = p.boreClearance;
  const b = p.bore;
  const rbEff = b.diameter / 2 + clr;
  let boreMaxR; // furthest radius any bore feature reaches
  let boreMinR; // closest the bore boundary comes to the center
  switch (b.type) {
    case 'keyed':
      boreMaxR = rbEff + b.keyDepth;
      boreMinR = rbEff;
      break;
    case 'hex':
      boreMaxR = (b.hexAcrossFlats / 2 + clr) / Math.cos(d2r(30));
      boreMinR = b.hexAcrossFlats / 2 + clr;
      break;
    case 'bolt':
      boreMaxR = b.pilotDia / 2 + clr;
      boreMinR = boreMaxR;
      break;
    case 'dbore':
      boreMaxR = rbEff;
      boreMinR = Math.min(rbEff, Math.max(2, b.flatOffset || rbEff * 0.75));
      break;
    default:
      boreMaxR = rbEff;
      boreMinR = rbEff;
  }
  // Bolt and plain hubs bound the bore with a single circle concentric with
  // the wheel, so each sector outline carries its exact arc of that circle
  // (rInner = bore radius) and needs no tip trim. Every other hub shape has
  // features that can cross seam lines, so those segment wedges extend
  // inward past the bore boundary and the bore cutter erases the tips,
  // leaving the exact bore shape in the assembled hub. (Concentric bores
  // used to be trimmed too, but shaving a razor-thin coaxial sliver at
  // bolt-pilot radii is a boolean worth not asking for — the old hosted
  // engine rejected it outright — so it is modeled away instead.)
  const boreConcentric = b.type === 'bolt' || b.type === 'plain';
  const rInner = boreConcentric
    ? Math.max(0.8, boreMinR)
    : Math.max(0.8, Math.min(Math.max(1.2, boreMinR - 1), boreMinR - 0.15));

  const hubWall = clamp(boreMaxR * 0.4, 5, 12);
  let rHub = Math.max(boreMaxR + hubWall, R * 0.13, 16);
  if (b.type === 'bolt') {
    rHub = Math.max(rHub, b.boltCircle / 2 + b.boltHoleDia / 2 + 4);
  }

  let infill = p.infill;
  let solidDisk = false;
  if (rHub > rRimIn - 8) {
    if (infill !== 'solid') {
      notes.push('Web band too narrow for structural infill on this wheel; using solid web.');
    }
    infill = 'solid';
    if (rHub >= rRimIn) {
      rHub = Math.max(boreMaxR + 2, rRimIn);
      solidDisk = true;
    }
  }

  // -------------------------------------------------------------------------
  // Dovetail joints (apply when the wheel is segmented)
  // -------------------------------------------------------------------------
  const joints = [];
  const mkJoint = (r, band, tag) => {
    const hh = clamp(band * 0.35, 0, 6); // trapezoid head half-width (radial)
    if (hh < 1.6) return null;
    return {
      r: rnd(r),
      hn: rnd(hh * 0.62), // neck half-width at the face
      hh: rnd(hh),
      d: rnd(clamp(hh * 1.15, 2.5, 7)), // tangential depth of the tenon
      tag,
    };
  };
  const rimJoint = mkJoint(rRimIn + rimBandT / 2, rimBandT, 'rim');
  if (rimJoint) joints.push(rimJoint);
  else warnings.push('Rim band too thin for a dovetail; segments will rely on adhesive only at the rim.');

  if (!solidDisk) {
    let gaps;
    if (b.type === 'bolt') {
      const bcr = b.boltCircle / 2;
      const hr = b.boltHoleDia / 2;
      gaps = [
        [boreMaxR + 1.2, bcr - hr - 1.5],
        [bcr + hr + 1.5, rHub - 0.8],
      ];
    } else {
      gaps = [[boreMaxR + 1.2, rHub - 0.8]];
    }
    let best = null;
    for (const [g0, g1] of gaps) {
      const band = g1 - g0;
      if (band >= 4.5 && (!best || band > best.band)) best = { g0, g1, band };
    }
    if (best) {
      const j = mkJoint((best.g0 + best.g1) / 2, best.band, 'hub');
      if (j) joints.push(j);
    } else {
      notes.push('Hub ring too tight for a dovetail; hub joint omitted (rim joint + adhesive carry the load).');
    }
  }
  if (infill === 'solid' && rRimIn - rHub > 45) {
    const j = mkJoint((rRimIn + rHub) / 2, 16, 'web');
    if (j) joints.push(j);
  }
  joints.sort((a, z) => a.r - z.r);
  const jointOut = joints.reduce((m, j) => Math.max(m, j.d), 0);

  // -------------------------------------------------------------------------
  // Segment count solver
  // -------------------------------------------------------------------------
  const ux = p.printer.x - p.printer.margin;
  const uy = p.printer.y - p.printer.margin;
  const uz = p.printer.z;
  const wholeFits = p.diameter <= ux && p.diameter <= uy;

  const segBBox = (N) => {
    if (N === 1) return { w: rnd(p.diameter, 1), d: rnd(p.diameter, 1) };
    const alpha = Math.PI / N;
    const w = 2 * (R * Math.sin(alpha) + jointOut);
    const d = R - rInner * Math.cos(alpha) + jointOut;
    return { w: rnd(w, 1), d: rnd(d, 1) };
  };
  const fitsXY = (bb) => (bb.w <= ux && bb.d <= uy) || (bb.w <= uy && bb.d <= ux);

  // Bore feature angular placement + symmetry, used for dedupe and for
  // preferring segment counts that yield fewer unique pieces.
  const boreSym = { plain: 0, keyed: 360, hex: 60, dbore: 360, bolt: 0 }[b.type];

  // Bolt-circle placement. The half-pitch phase keeps the pattern symmetric
  // about each piece's mid-angle — but when N/gcd(N, boltCount) is even that
  // exact phase puts holes exactly on seams (the assembled wheel would get
  // half-open holes). Relative to the seams the holes form a lattice of
  // pitch 360·g/(N·boltCount); rotating the whole pattern by half that pitch
  // centres it between seams, the largest clearance this N allows. The
  // rotation applies only to the on-seam cases: for every other N the
  // half-pitch phase is already lattice-centred.
  const gcd = (a, c) => (c ? gcd(c, a % c) : a);
  const boltR = b.boltCircle / 2;
  const boltHoleR = b.boltHoleDia / 2 + clr / 2;
  const boltPhaseFor = (n) => {
    const p0 = 360 / b.boltCount / 2;
    if (n <= 1) return p0;
    const g = gcd(n, b.boltCount);
    return (n / g) % 2 === 0 ? p0 + (180 * g) / (n * b.boltCount) : p0;
  };
  const boltAnglesFor = (n) => {
    const ph = boltPhaseFor(n);
    return Array.from({ length: b.boltCount }, (_, j) => mod(ph + (j * 360) / b.boltCount, 360));
  };
  // Millimetres between the closest bolt-hole edge and its nearest seam plane
  // (negative = the hole crosses the seam).
  const boltSeamClearMm = (n) => {
    if (b.type !== 'bolt' || n <= 1) return Infinity;
    const An = 360 / n;
    let worst = Infinity;
    for (const ang of boltAnglesFor(n)) {
      const dAng = Math.min(mod(ang, An), An - mod(ang, An));
      worst = Math.min(worst, boltR * Math.sin(d2r(dAng)) - boltHoleR);
    }
    return worst;
  };

  const featureSigForPiece = (k, N) => {
    const A = 360 / N;
    const sig = { bore: null, key: null, bolts: [] };
    const w0 = k * A;
    const w1 = (k + 1) * A;
    if (b.type === 'hex') {
      sig.bore = { t: 'hex', rot: rnd(mod(-w0, 60), 2) };
    } else if (b.type === 'dbore') {
      const flatDir = N > 1 ? A / 2 : 90;
      const gamma = r2d(Math.acos(clamp(b.flatOffset / rbEff, -1, 1)));
      const pad = r2d(2 / rbEff);
      if (angIntervalsOverlap(w0 - pad, w1 + pad, flatDir - gamma, flatDir + gamma)) {
        sig.bore = { t: 'd', rot: rnd(mod(flatDir - w0, 360), 2) };
      } else {
        sig.bore = { t: 'round' };
      }
    } else {
      sig.bore = { t: 'round' };
    }
    if (b.type === 'keyed') {
      const keyDir = N > 1 ? A / 2 : 90;
      const half = r2d((b.keyWidth / 2 + 2) / rbEff);
      if (angIntervalsOverlap(w0, w1, keyDir - half, keyDir + half)) {
        sig.key = rnd(mod(keyDir - w0, 360), 2);
      }
    }
    if (b.type === 'bolt') {
      for (const ang of boltAnglesFor(N)) {
        if (ang >= mod(w0, 360) - 1e-9 && ang < mod(w0, 360) + A - 1e-9) {
          sig.bolts.push(rnd(mod(ang - w0, 360), 2));
        } else if (N === 1) {
          sig.bolts.push(rnd(ang, 2));
        }
      }
      sig.bolts.sort((x, y) => x - y);
    }
    return JSON.stringify(sig);
  };

  const uniqueCount = (N) => {
    const seen = new Set();
    for (let k = 0; k < N; k++) seen.add(featureSigForPiece(k, N));
    return seen.size;
  };

  let N;
  if (p.segmentsOverride >= 1) {
    N = clamp(p.segmentsOverride, 1, 16);
    const bb = segBBox(N);
    if (N === 1 ? !(wholeFits && W <= uz) : !(fitsXY(bb) && W <= uz)) {
      warnings.push(`Requested segment count ${N} does not fit the printer envelope (piece ≈ ${bb.w} × ${bb.d} mm).`);
    }
  } else if (wholeFits) {
    N = 1;
  } else {
    let nMin = 0;
    for (let n = 2; n <= 16; n++) {
      if (fitsXY(segBBox(n))) {
        nMin = n;
        break;
      }
    }
    if (!nMin) {
      N = 16;
      warnings.push('Even 16 segments do not fit this printer envelope; generated anyway at 16 — reduce diameter or use a larger printer.');
    } else {
      // Prefer counts that keep every bolt hole a solid wall's distance from
      // the seams; among those, minimize unique pieces.
      const seamOk = (n) => boltSeamClearMm(n) >= 1;
      let best = 0;
      let bestU = Infinity;
      for (let n = nMin; n <= Math.min(16, nMin + 4); n++) {
        if (!seamOk(n)) continue;
        const u = uniqueCount(n);
        if (u < bestU) {
          best = n;
          bestU = u;
        }
      }
      if (!best) {
        // Nothing near the minimum clears the seams; scan further out.
        for (let n = nMin + 5; n <= 16; n++) {
          if (fitsXY(segBBox(n)) && seamOk(n)) {
            best = n;
            break;
          }
        }
      }
      if (!best) {
        best = nMin;
        bestU = uniqueCount(nMin);
        for (let n = nMin + 1; n <= Math.min(16, nMin + 4); n++) {
          const u = uniqueCount(n);
          if (u < bestU) {
            best = n;
            bestU = u;
          }
        }
      }
      N = best;
      if (N !== nMin) {
        notes.push(
          seamOk(nMin)
            ? `Chose ${N} segments (over minimum ${nMin}) so pieces come out identical for this hub type.`
            : `Chose ${N} segments (over minimum ${nMin}) so bolt holes clear the segment seams.`
        );
      }
    }
  }
  const A = 360 / N;
  if (N === 1) joints.length = 0; // one-piece wheels have no seams
  const jointOutN = joints.reduce((m, j) => Math.max(m, j.d), 0);
  if (W > uz) {
    warnings.push(`Wheel width ${rnd(W, 1)} mm exceeds printer Z height ${uz} mm — reduce width or use a taller printer.`);
  }
  // Residual bolt/seam conflicts survive only when the segment count was
  // forced (override) or no fitting count clears the pattern.
  if (b.type === 'bolt' && boltSeamClearMm(N) < 0.6) {
    warnings.push(
      'A bolt hole falls on or nearly touches a segment seam at this segment count; use a segment count that shares a factor with the bolt count (e.g. equal to it), or enlarge the bolt circle.'
    );
  }

  // -------------------------------------------------------------------------
  // Tread pattern
  // -------------------------------------------------------------------------
  // Bars are described by the *windows* between them — the notches cut into
  // the crown arc — because that is what the piece profile has to carry.
  // Material left between neighbouring windows is the bar itself. Drawing
  // them into the profile instead of subtracting a prism per bar is what
  // makes a lugged wheel exportable: the old one-boolean-per-lug scheme took
  // ~80 s on the demo wheel and fell over ("Batch edit result is not valid",
  // engine hangups) on anything busier.
  const treadInfo = { style: p.tread, crown: p.profile.shape };

  // Circumferential grooves. They are bands of the revolved tire tool: a
  // groove floor is the crown arc offset inward by `ribDepth`, which is a
  // constant depth measured perpendicular to the tread surface — what a
  // moulded groove actually is. Since the whole tire is one tool whatever it
  // carries, groove count costs nothing, and a crowned profile takes as many
  // as a flat one. (It used to cap crowned wheels at two, because each groove
  // was a parabolic dip in the section curve and each dip cost three more
  // profiles to loft through.)
  const ribHalfW = 1.2;
  const ribZ = [];
  if (ribbed) {
    const g = clamp(p.ribCount > 0 ? p.ribCount : Math.round(W / 14), 1, 6);
    if (p.ribCount > 0 && g !== p.ribCount) {
      notes.push(`Rib count reduced ${p.ribCount} → ${g} to keep the grooves clear of the wheel's edges.`);
    }
    const edge = clamp(W * 0.12, 3, 10);
    for (let i = 0; i < g; i++) ribZ.push(rnd(g === 1 ? halfW : edge + (i * (W - 2 * edge)) / (g - 1), 4));
    treadInfo.ribs = g;
    treadInfo.ribDepth = rnd(ribDepth, 2);
  }
  // Groove bands as [z0, z1], clipped to the wheel and merged where they touch
  // — the tire profile walks them in order and must never double back.
  const ribBands = [];
  for (const zc of ribZ) {
    const band = [clamp(zc - ribHalfW, 0, W), clamp(zc + ribHalfW, 0, W)];
    if (band[1] - band[0] < 1e-6) continue;
    const last = ribBands[ribBands.length - 1];
    if (last && band[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], band[1]);
    else ribBands.push(band);
  }
  grooveAt = (z) => (ribBands.some(([a, b]) => z >= a - 1e-9 && z <= b + 1e-9) ? ribDepth : 0);

  let barCount = 0;
  let barsPerSeg = 0;
  let barHalf = 0; // angular half-width of one window, degrees
  let barPitch = 0; // degrees between window centres
  let barShift = 0; // degrees the window centre travels over a half-width
  if (barred && treadCut > 0) {
    // Slant the user asked for, as degrees of rotation across a half-width.
    const wantShift = ['angled', 'chevron'].includes(p.tread) && p.treadAngle > 0 ? r2d((Math.tan(d2r(p.treadAngle)) * halfW) / R) : 0;
    // Window half-width and the room a bar has to lean, for a given count.
    const slotFor = (cnt) => clamp(((Math.PI * p.diameter) / cnt) * 0.32, 2.5, 8);
    // The window is widest in angle at the smallest radius it reaches.
    const halfFor = (cnt) => r2d(Math.asin(clamp(slotFor(cnt) / 2 / Math.max(R - treadCut, 1), 0, 1)));
    const roomFor = (cnt) => (360 / cnt) * 0.45 - halfFor(cnt);
    // How far a window centre actually strays from its nominal angle. An
    // angled bar leans one way across the whole width; a chevron's two arms
    // each cover half of it, so the same bar angle costs half the excursion.
    const strayOf = (shift) => (p.tread === 'chevron' ? shift * 0.5 : shift);

    barCount = p.treadCount > 0 ? p.treadCount : Math.max(N, Math.round((Math.PI * p.diameter) / 20));
    if (N > 1) barCount = Math.max(N, Math.round(barCount / N) * N);
    if (p.treadCount > 0 && barCount !== p.treadCount) {
      notes.push(`Tread bar count adjusted ${p.treadCount} → ${barCount} so the pattern repeats per segment.`);
    }
    if (wantShift > 0 && p.treadCount === 0) {
      // A bar can only lean as far as its own pitch cell allows. Rather than
      // keep the count and flatten the tread to nothing, an auto count spaces
      // the bars out until the angle the user asked for actually fits.
      const step = N > 1 ? N : 1;
      const floorCount = Math.max(N, step, 4);
      while (barCount - step >= floorCount && strayOf(wantShift) > roomFor(barCount)) barCount -= step;
    }
    barPitch = 360 / barCount;
    barHalf = halfFor(barCount);
    barsPerSeg = N === 1 ? barCount : barCount / N;
    if (wantShift > 0) {
      barShift = wantShift;
      // A window may never leave its own pitch cell. Bars would otherwise
      // merge — and a window that ran off the end of a sector would change the
      // profile's entity count from level to level, which a slanted tread's
      // loft cannot raise a surface between.
      const maxShift = Math.max(0, roomFor(barCount) / (strayOf(1) || 1));
      if (barShift > maxShift + 1e-9) {
        barShift = maxShift;
        const got = barShift > 0 ? rnd(r2d(Math.atan((d2r(barShift) * R) / halfW)), 1) : 0;
        notes.push(`Tread angle reduced ${rnd(p.treadAngle, 1)}° → ${got}° — a steeper slant would run the bars into each other at ${barCount} bars.`);
      }
    }
    treadInfo.bars = barCount;
    treadInfo.barsPerSegment = barsPerSeg;
    treadInfo.barWidth = rnd((Math.PI * p.diameter) / barCount - slotFor(barCount), 1);
    if (barShift) treadInfo.barAngle = rnd(r2d(Math.atan((d2r(barShift) * R) / halfW)), 1);
  }
  // Window centre offset at height z. `barShift` is the tangential travel of
  // one bar across a half-width, so an angled bar sweeps ±barShift over the
  // full width while a chevron sweeps that much per arm — leading at the
  // centreline, trailing at both shoulders.
  const barPhase = (z) => {
    if (!barShift) return 0;
    const u = (2 * z) / W - 1;
    return p.tread === 'chevron' ? barShift * (0.5 - Math.abs(u)) : barShift * u;
  };

  // -------------------------------------------------------------------------
  // Sections (canonical piece frame: sector spans [0°, A°])
  // -------------------------------------------------------------------------
  // One z level extrudes; several loft. The only thing that still varies the
  // profile with height is a *slanted* tread — the crown and the grooves left
  // the profile for the revolved tire tool, so every straight-barred wheel is
  // a single prism now, crowned or not.
  const crowned = crownDrop > 0;

  // How far past the finished radius the blank is drawn, when a tire tool is
  // going to trim it back.
  //
  // The tool's inner surface *is* the finished surface, so a blank drawn at
  // exactly R meets it tangentially along the mid-width circle — where the
  // crown is at full radius — and coincides with it outright on a flat,
  // grooved tread. OpenCascade's boolean handles neither: measured on a
  // Ø355.6 crowned wheel with a slanted tread, the cut left the blank's
  // 813 972.2 mm³ untouched at every seam angle. Lifting the blank clear makes
  // the tool cross it transversally at every height instead, which is the same
  // reason prismatic cutters overshoot the piece in Z.
  //
  // 0.05 mm: five hundred times the kernel's tolerance, a twentieth of the
  // planner's own grid, and gone from the finished solid — the tire cuts it
  // all away. The footprint quoted to the user is measured without it.
  const rimOver = crowned || ribBands.length ? 0.05 : 0;

  const zSet = new Set([0, W]);
  if (barShift && p.tread === 'chevron') zSet.add(rnd(halfW, 4));
  const zLevels = barShift ? [...zSet].sort((x, y) => x - y) : [0];

  // Outer boundary of one section, walking CCW from `from` to `to` degrees.
  // Windows never reach either end (see the maxShift clamp above), so the
  // boundary always starts and ends on the crown radius and the sector faces
  // can meet it without knowing anything about the tread.
  const outerAt = (z, from, to, over = rimOver) => {
    const Ro = R + over;
    const Ri = R - treadCut;
    const segs = [];
    const ph = barPhase(z);
    // A zero-sweep arc is a degenerate entity the engine rejects, and the ring
    // case opens exactly on a window edge, so every arc is length-checked.
    const arcTo = (r, a0, a1) => {
      if (a1 - a0 > 1e-7) segs.push({ kind: 'arc', a: polar(r, a0), b: polar(r, a1), center: [0, 0], radius: rnd(r), ccw: true });
    };
    let a = from;
    if (barCount) {
      const j0 = Math.ceil((from - ph) / barPitch - 0.5);
      const j1 = Math.floor((to - ph) / barPitch - 0.5);
      for (let j = j0; j <= j1; j++) {
        const c = ph + (j + 0.5) * barPitch;
        const a0 = Math.max(c - barHalf, a);
        const a1 = Math.min(c + barHalf, to);
        if (a1 - a0 < 1e-6) continue;
        arcTo(Ro, a, a0);
        segs.push({ kind: 'line', a: polar(Ro, a0), b: polar(Ri, a0) });
        arcTo(Ri, a0, a1);
        segs.push({ kind: 'line', a: polar(Ri, a1), b: polar(Ro, a1) });
        a = a1;
      }
    }
    arcTo(Ro, a, to);
    return segs.map((s) => ({ ...s, a: s.a.map((v) => rnd(v)), b: s.b.map((v) => rnd(v)) }));
  };

  // A point solid in every section: the rim band, under the deepest tread
  // valley any section reaches and over the web. The region seed has to hold
  // for all of them — the sketch now carries the bore and every web void as
  // loops, so a seed that lands in a void resolves to the wrong face.
  const seedPt = polar(rRimIn + rimBandT / 2, N === 1 ? 90 : A / 2);

  const jc = p.joint.clearance;
  const sectionAt = (z, over = rimOver) => {
    if (N === 1) {
      if (!barCount) return { z: rnd(z, 4), kind: 'circle', r: rnd(R + over), interior: seedPt.map((v) => rnd(v)) };
      // Start the ring on the first window's leading edge so the wrap-around
      // gap is one ordinary arc — a full-turn arc with coincident ends is
      // degenerate and the engine rejects it.
      const start = barPhase(z) + 0.5 * barPitch - barHalf;
      return { z: rnd(z, 4), kind: 'ring', segs: outerAt(z, start, start + 360, over), interior: seedPt.map((v) => rnd(v)) };
    }
    const Ro = R + over;
    const segs = [];
    const asc = [...joints];
    const desc = [...joints].reverse();
    let P = [rInner, 0];
    // Face 0 (female pockets), walking outward along the +X axis.
    for (const j of asc) {
      const hn = j.hn + jc;
      const hh = j.hh + jc;
      const dd = j.d + jc;
      const n1 = [j.r - hn, 0];
      const h1 = [j.r - hh, dd];
      const h2 = [j.r + hh, dd];
      const n2 = [j.r + hn, 0];
      segs.push({ kind: 'line', a: P, b: n1 });
      segs.push({ kind: 'line', a: n1, b: h1 });
      segs.push({ kind: 'line', a: h1, b: h2 });
      segs.push({ kind: 'line', a: h2, b: n2 });
      P = n2;
    }
    segs.push({ kind: 'line', a: P, b: [rnd(Ro), 0] });
    // Outer boundary, CCW 0 → A: the crown arc for this height with the tread
    // windows notched into it.
    segs.push(...outerAt(z, 0, A, over));
    // Face A (male tenons), walking inward.
    const u = [Math.cos(d2r(A)), Math.sin(d2r(A))];
    const t = [-Math.sin(d2r(A)), Math.cos(d2r(A))]; // out of the piece
    P = polar(Ro, A).map((v) => rnd(v));
    for (const j of desc) {
      const n2 = [j.r + j.hn, 0];
      const h2 = [j.r + j.hh, j.d];
      const h1 = [j.r - j.hh, j.d];
      const n1 = [j.r - j.hn, 0];
      const tx = ([rr, dd]) => [rr * u[0] + dd * t[0], rr * u[1] + dd * t[1]];
      const pn2 = tx(n2);
      const ph2 = tx(h2);
      const ph1 = tx(h1);
      const pn1 = tx(n1);
      segs.push({ kind: 'line', a: P, b: pn2 });
      segs.push({ kind: 'line', a: pn2, b: ph2 });
      segs.push({ kind: 'line', a: ph2, b: ph1 });
      segs.push({ kind: 'line', a: ph1, b: pn1 });
      P = pn1;
    }
    segs.push({ kind: 'line', a: P, b: polar(rInner, A) });
    // Inner arc, drawn A → 0 (clockwise as walked).
    segs.push({ kind: 'arc', a: polar(rInner, A), b: [rInner, 0], center: [0, 0], radius: rInner, ccw: false });
    return { z: rnd(z, 4), kind: 'sector', segs, interior: seedPt.map((v) => rnd(v)) };
  };

  const sections = zLevels.map(sectionAt);
  // The mid-width section is the widest one: it is the piece's silhouette, so
  // it drives the print footprint and everything the preview draws flat.
  const outline = sections.reduce((best, s) => (Math.abs(s.z - halfW) < Math.abs(best.z - halfW) ? s : best), sections[0]);

  // Angular keep-out from each radial face, at a given radius.
  const faceMarginAng = (r) => (N === 1 ? 0 : r2d((jointOutN + 2.5) / Math.max(r, 1)));

  // -------------------------------------------------------------------------
  // Shared cutters (identical for every piece): infill pockets + tread
  // -------------------------------------------------------------------------
  const shared = [];
  const zThrough = { z0: -1, z1: W + 1 };
  const rWebIn = rHub + 0.5;
  const rWebOut = rRimIn - 0.5;
  const bandW = rWebOut - rWebIn;
  let infillInfo = { style: infill };

  if (infill === 'spokes' && bandW > 8) {
    const targetTotal = p.spokeCount > 0 ? p.spokeCount : clamp(Math.round(p.diameter / 45), 4, 12);
    const m = Math.max(1, Math.round(targetTotal / N));
    const total = m * N;
    if (p.spokeCount > 0 && total !== p.spokeCount) {
      notes.push(`Spoke count adjusted ${p.spokeCount} → ${total} so the pattern repeats per segment.`);
    }
    // Constant-width ribs: gap boundaries are lines parallel to each rib's
    // centerline ray, offset by half the rib width (or by the joint keep-out
    // along the two segment faces). Corners land exactly on the web circles.
    const spokeT = clamp(bandW * 0.14, 4, 14);
    const cWeb = N > 1 ? jointOut + 2.5 : spokeT / 2;
    const pitchA = A / m;
    let placed = 0;
    for (let j = 0; j < m; j++) {
      const thL = j * pitchA;
      const thR = (j + 1) * pitchA;
      const oL = N > 1 && j === 0 ? cWeb : spokeT / 2;
      const oR = N > 1 && j === m - 1 ? cWeb : spokeT / 2;
      if (oL >= rWebIn - 1 || oR >= rWebIn - 1) break;
      const sInL = Math.sqrt(rWebIn ** 2 - oL ** 2);
      const sOutL = Math.sqrt(rWebOut ** 2 - oL ** 2);
      const sInR = Math.sqrt(rWebIn ** 2 - oR ** 2);
      const sOutR = Math.sqrt(rWebOut ** 2 - oR ** 2);
      const uL = [Math.cos(d2r(thL)), Math.sin(d2r(thL))];
      const tL = [-Math.sin(d2r(thL)), Math.cos(d2r(thL))];
      const uR = [Math.cos(d2r(thR)), Math.sin(d2r(thR))];
      const tR = [-Math.sin(d2r(thR)), Math.cos(d2r(thR))];
      const pA = [sInL * uL[0] + oL * tL[0], sInL * uL[1] + oL * tL[1]];
      const pB = [sOutL * uL[0] + oL * tL[0], sOutL * uL[1] + oL * tL[1]];
      const pC = [sOutR * uR[0] - oR * tR[0], sOutR * uR[1] - oR * tR[1]];
      const pD = [sInR * uR[0] - oR * tR[0], sInR * uR[1] - oR * tR[1]];
      const angA = r2d(Math.atan2(pA[1], pA[0]));
      const angD = r2d(Math.atan2(pD[1], pD[0]));
      if (mod(angD - angA, 360) < 3) continue;
      shared.push({
        id: `spoke${j + 1}`,
        shape: 'path',
        segs: [
          { kind: 'line', a: pA, b: pB },
          { kind: 'arc', a: pB, b: pC, center: [0, 0], radius: rWebOut, ccw: true },
          { kind: 'line', a: pC, b: pD },
          { kind: 'arc', a: pD, b: pA, center: [0, 0], radius: rWebIn, ccw: false },
        ],
        interior: polar((rWebIn + rWebOut) / 2, angA + mod(angD - angA, 360) / 2),
        ...zThrough,
      });
      placed++;
    }
    if (placed) {
      infillInfo = { style: 'spokes', totalSpokes: total, perSegment: placed, ribWidth: rnd(spokeT, 1) };
    } else {
      notes.push('Spoke gaps did not clear the joint keep-outs; web left solid.');
      infillInfo = { style: 'solid' };
    }
  } else if (infill === 'honeycomb' && bandW > 14) {
    // Hex cells on a true honeycomb lattice, aligned to the piece bisector:
    // uniform `wall` between every pair of neighbouring cells by
    // construction. A cell is kept only when it fits entirely inside the web
    // band and clear of the seam keep-outs. Cell size, wall, lattice
    // orientation, corner rounding and the per-segment budget are all user
    // parameters (p.honeycomb); every one of them is a property of the
    // lattice, so the no-overlap guarantee holds for any combination.
    // (Per-row polar placement used to re-pitch and re-centre every row, so
    // the half-pitch stagger drifted out of phase and staggered rows
    // overlapped — cells merged into open voids in the CAD and broke the
    // preview triangulation.)
    const GROW = 1.28; // cell-size step taken when the count is over budget
    const hc = p.honeycomb;
    const wall = hc.wall;
    // Requested cell size is the across-flats width (how honeycomb infill is
    // normally quoted); the lattice math wants the circumradius.
    const reqCr = hc.cellSize > 0 ? hc.cellSize / Math.sqrt(3) : clamp(bandW / 8, 4, 12);
    let cr = reqCr;
    const dFace = jointOutN + 2.5; // straight-line keep-out from each seam plane
    const bis = A / 2;
    const eR = [Math.cos(d2r(bis)), Math.sin(d2r(bis))]; // lattice axis along the bisector
    const eT = [-eR[1], eR[0]];
    // Lattice frame: cells are pointy along the row-step axis eB and packed
    // along eA. 'radial' steps rows outward (a vertex faces the rim);
    // 'tangential' swaps the axes, turning the whole lattice 30° so a flat
    // faces the rim instead. Uniform walls hold either way — the stagger and
    // the pitches travel with the axes.
    const tangential = hc.orientation === 'tangential';
    const eA = tangential ? eR : eT;
    const eB = tangential ? eT : eR;
    const cellAng = bis + (tangential ? 30 : 0); // vertex direction = eB (mod 60°)
    const sinA = Math.sin(d2r(A));
    const cosA = Math.cos(d2r(A));
    const rMid = (rWebIn + rWebOut) / 2;
    const fits = (pts) => {
      for (const [x, y] of pts) {
        if (x * x + y * y > rWebOut * rWebOut) return false;
        // Signed distances to the seam planes through faces 0 and A.
        if (N > 1 && (y < dFace || sinA * x - cosA * y < dFace)) return false;
      }
      for (let i = 0; i < pts.length; i++) {
        if (segDistToOrigin(pts[i], pts[(i + 1) % pts.length]) < rWebIn) return false;
      }
      return true;
    };
    // Skip growth passes that are certain to be over budget: a hex lattice
    // site occupies pitchA × pitchB, so the sector's web area estimates the
    // cell count for a size (3 mm cells on a 1.5 m wheel are tens of
    // thousands of candidates per pass, and this replans on every keystroke).
    // The jump is quantised to whole GROW steps and held two steps short of
    // the estimate, so it can only ever land on a size the loop below would
    // have walked through anyway — the outcome is the plain loop's, faster.
    const webArea = 0.5 * d2r(A) * (rWebOut ** 2 - rWebIn ** 2);
    const siteArea = (cr * Math.sqrt(3) + wall) * (cr * 1.5 + (wall * Math.sqrt(3)) / 2);
    const skip = Math.floor(Math.log(Math.max(1, webArea / siteArea / hc.maxCells)) / (2 * Math.log(GROW))) - 2;
    if (skip > 0) cr *= GROW ** skip;
    let cells = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      cells = [];
      const pitchA = cr * Math.sqrt(3) + wall; // across-flats + wall
      const pitchB = cr * 1.5 + (wall * Math.sqrt(3)) / 2;
      const reach = rMid + rWebOut + cr; // lattice origin sits at rMid, cells within rWebOut
      const bMax = Math.ceil(reach / pitchB);
      const aMax = Math.ceil(reach / pitchA);
      const corner = []; // cell-local vertex offsets, same for every cell
      for (let k = 0; k < 6; k++) corner.push(polar(cr, cellAng + k * 60));
      for (let j = -bMax; j <= bMax; j++) {
        const v = j * pitchB;
        for (let i = -aMax; i <= aMax; i++) {
          const u = (i + (j & 1 ? 0.5 : 0)) * pitchA;
          const cx = rMid * eR[0] + u * eA[0] + v * eB[0];
          const cy = rMid * eR[1] + u * eA[1] + v * eB[1];
          const rc = Math.hypot(cx, cy);
          if (rc > rWebOut + cr || rc < rWebIn - cr) continue; // cheap ring reject
          const pts = corner.map((o) => [cx + o[0], cy + o[1]]);
          if (fits(pts)) cells.push({ c: [cx, cy], pts });
        }
      }
      if (cells.length <= hc.maxCells) break;
      cr *= GROW;
    }
    if (cells.length > hc.maxCells) {
      notes.push(`Honeycomb hit the ${hc.maxCells}-cell budget; extra cells dropped — raise the budget or the cell size.`);
      cells = cells.slice(0, hc.maxCells);
    } else if (hc.cellSize > 0 && cr > reqCr + 1e-9) {
      notes.push(
        `Honeycomb cell size grown ${rnd(hc.cellSize, 1)} → ${rnd(cr * Math.sqrt(3), 1)} mm across flats to stay within the ${hc.maxCells}-cell budget.`
      );
    }
    // A round cell is the fillet taken to its limit — the hex's inscribed
    // circle — so both shapes share one lattice and one wall guarantee.
    const cellIn = (cr * Math.sqrt(3)) / 2; // inradius = half the across-flats width
    const fillet = hc.cellShape === 'round' ? cellIn : clamp(hc.cornerRadius, 0, cellIn);
    const round = fillet >= cellIn - 1e-6;
    cells.forEach((cell, i) => {
      const id = `hex${i + 1}`;
      const c = [rnd(cell.c[0]), rnd(cell.c[1])];
      if (round) {
        shared.push({ id, shape: 'circle', c, r: rnd(cellIn), ...zThrough });
      } else if (fillet > 0.05) {
        shared.push({ id, shape: 'path', segs: roundedPolySegs(cell.pts, fillet), interior: c, ...zThrough });
      } else {
        shared.push({ id, shape: 'poly', pts: cell.pts.map((q) => [rnd(q[0]), rnd(q[1])]), ...zThrough });
      }
    });
    infillInfo = {
      style: 'honeycomb',
      cellsPerSegment: cells.length,
      cellCircumradius: rnd(cr, 1),
      cellAcrossFlats: rnd(cr * Math.sqrt(3), 1),
      cellShape: round ? 'round' : fillet > 0.05 ? 'rounded hex' : 'hex',
      cornerRadius: round ? rnd(cellIn, 2) : rnd(fillet, 2),
      wall: rnd(wall, 2),
      orientation: hc.orientation,
    };
    if (cells.length) {
      if (hc.cornerRadius > cellIn + 1e-9 && hc.cellShape !== 'round') {
        notes.push(`Honeycomb corner radius capped at ${rnd(cellIn, 2)} mm (half the cell's across-flats width) — cells are round.`);
      }
      if (wall < 1.2) {
        notes.push(`Honeycomb wall ${rnd(wall, 2)} mm is under three 0.4 mm extrusions; expect a fragile web on a stock nozzle.`);
      }
    } else {
      notes.push(
        hc.cellSize > 0
          ? `Honeycomb cells did not fit (${rnd(hc.cellSize, 1)} mm across flats + ${rnd(wall, 2)} mm wall in a ${rnd(bandW, 1)} mm web); web left solid.`
          : 'Honeycomb cells did not fit; web left solid.'
      );
      infillInfo = { style: 'solid' };
    }
  } else if (infill === 'flexweb' && bandW > 12) {
    // Curved-spoke slots (airless-tire look). Slot inner ends anchor on an
    // enlarged hub ring so slot width stays sane at small radii; each slot is
    // two concentric arcs (offset ± half-width around a circumcircle through
    // inner point, outer point and a leaning midpoint) with straight end caps.
    const rI0 = Math.max(rWebIn + 1, R * 0.2);
    const rO0 = rWebOut - 1;
    const rm = (rI0 + rO0) / 2;
    const flexBand = rO0 - rI0;
    let slotsTotal = clamp(Math.round((2 * Math.PI * rm) / clamp(flexBand * 0.5, 20, 70)), 6, 20);
    slotsTotal = Math.max(N, Math.round(slotsTotal / N) * N);
    const perSeg = slotsTotal / N;
    const sweep0 = clamp((0.85 * 360) / slotsTotal, 10, 35);
    let placed = 0;
    for (let j = 0; j < perSeg; j++) {
      const mid = (j + 0.5) * (A / perSeg);
      let ok = false;
      let trySweep = sweep0;
      let hw = Math.min(clamp(flexBand * 0.08, 1.6, 6), rI0 * 0.22);
      for (let att = 0; att < 3 && !ok; att++) {
        const aI = mid - trySweep / 2;
        const aO = mid + trySweep / 2;
        const I = polar(rI0, aI);
        const O = polar(rO0, aO);
        const M = polar(rm, mid + trySweep * 0.06);
        const cc = circumcircle(I, O, M);
        if (!cc) break;
        // Slot angle grows monotonically with radius, so the angular extreme
        // at each face is the endpoint nearest it — check each at its own
        // radius with its own width padding.
        const padI = r2d((hw + 1) / rI0);
        const padO = r2d((hw + 1) / rO0);
        if (N > 1 && (aI - padI < faceMarginAng(rI0) || aO + padO > A - faceMarginAng(rO0))) {
          trySweep *= 0.7;
          if (att === 1) hw *= 0.7;
          continue;
        }
        ok = true;
        const uI = [(I[0] - cc.c[0]) / cc.r, (I[1] - cc.c[1]) / cc.r];
        const uO = [(O[0] - cc.c[0]) / cc.r, (O[1] - cc.c[1]) / cc.r];
        const Ip = [cc.c[0] + uI[0] * (cc.r + hw), cc.c[1] + uI[1] * (cc.r + hw)];
        const Im = [cc.c[0] + uI[0] * (cc.r - hw), cc.c[1] + uI[1] * (cc.r - hw)];
        const Op = [cc.c[0] + uO[0] * (cc.r + hw), cc.c[1] + uO[1] * (cc.r + hw)];
        const Om = [cc.c[0] + uO[0] * (cc.r - hw), cc.c[1] + uO[1] * (cc.r - hw)];
        const cross = (I[0] - cc.c[0]) * (O[1] - cc.c[1]) - (I[1] - cc.c[1]) * (O[0] - cc.c[0]);
        const ccwDir = cross > 0;
        // Interior probe: the centerline point midway along the slot.
        const midChord = [(I[0] + O[0]) / 2, (I[1] + O[1]) / 2];
        const mcLen = Math.hypot(midChord[0] - cc.c[0], midChord[1] - cc.c[1]) || 1;
        const interior = [
          cc.c[0] + ((midChord[0] - cc.c[0]) / mcLen) * cc.r,
          cc.c[1] + ((midChord[1] - cc.c[1]) / mcLen) * cc.r,
        ];
        shared.push({
          id: `web${j + 1}`,
          shape: 'path',
          segs: [
            { kind: 'line', a: Im, b: Ip },
            { kind: 'arc', a: Ip, b: Op, center: cc.c, radius: cc.r + hw, ccw: ccwDir },
            { kind: 'line', a: Op, b: Om },
            { kind: 'arc', a: Om, b: Im, center: cc.c, radius: cc.r - hw, ccw: !ccwDir },
          ],
          interior,
          ...zThrough,
        });
        placed++;
      }
    }
    infillInfo = placed
      ? { style: 'flexweb', slotsTotal: placed * N, perSegment: placed }
      : { style: 'solid' };
    if (!placed) notes.push('Flex-web slots did not clear the joint keep-outs; web left solid.');
  } else if (infill === 'lattice' && bandW > 12) {
    // Interlaced criss-cross web — the look most airless tires wear. Two
    // mirrored families of struts sweep the band, one leaning with the
    // rotation and one against it, and every void is a diamond slung between
    // four of them. In chart coordinates the families are just two pencils of
    // straight lines,
    //
    //     family A: θ = c + L·t        family B: θ = c − L·t
    //
    // which cross on rows+1 evenly spaced levels t = n/rows; the diamond
    // centred on each crossing spans one strut pitch P in θ and two levels in
    // t. Two rows and up weave. One row degenerates to triangles alternating
    // apex-in and apex-out — a chevron / V-truss.
    const lt = p.lattice;
    const ch = webChart(rWebIn, rWebOut, A, N, jointOutN + 2.5);
    const rMid = (rWebIn + rWebOut) / 2;
    // Squarish cells want the diamond's arc width k·P to match its radial
    // height 2·bandW/rows, which lands on struts = rows·π·rMid/bandW. The
    // count then snaps to a multiple of N so the pattern repeats per segment.
    const rows = lt.rows > 0 ? lt.rows : clamp(Math.round(bandW / 32), 2, 6);
    const square = (rows * Math.PI * rMid) / bandW;
    const snapN = (v) => Math.max(N, Math.round(v / N) * N);
    let struts = snapN(lt.struts > 0 ? lt.struts : square);
    // A strut that leans far enough over swallows the cells it is meant to
    // bound (its arc footprint is strutWidth/cos φ), so the lean is capped at
    // 70° from radial where it is steepest — at the rim.
    const leanFloor = Math.max(N, N * Math.ceil((rows * Math.PI * rWebOut) / (Math.tan(d2r(70)) * bandW) / N));
    if (struts < leanFloor) {
      if (lt.struts > 0) notes.push(`Lattice strut count raised ${lt.struts} → ${leanFloor} so the outer struts do not lie over flat.`);
      struts = leanFloor;
    }
    const budget = Math.max(N, N * Math.floor(WEB_CELL_CAP / (rows + 1)));
    if (struts > budget) {
      notes.push(`Lattice thinned to ${budget / N} strut${budget / N === 1 ? '' : 's'} per segment and family to stay inside the ${WEB_CELL_CAP}-void budget.`);
      struts = budget;
    }
    const P = 360 / struts;
    const L = (rows * P) / 2; // total lean of one strut across the band
    const perSeg = Math.max(1, Math.round(struts / N));
    const tPad = Math.min(0.35, lt.strutWidth / 2 / bandW);
    const bounded = N > 1;
    // A strut leaning φ off radial shows strutWidth/cos φ of arc, so that is
    // the tangential bite the cells either side have to give up for the
    // material between them to come out strutWidth thick measured across it.
    // φ grows with radius: tan φ = r·L / bandW, with L in radians. Two useful
    // consequences fall out — the wall between side-by-side cells is exactly
    // strutWidth, and the neck between the cells above and below a crossing
    // works out to strutWidth/sin φ, which is never the tighter of the two.
    // Both edges of a strut are chorded, and offset tangentially rather than
    // along the true normal, so the allowance is two sags rather than one.
    const hw = (lt.strutWidth + 2 * SAG_TOL) / 2;
    const leanAt = (t) => Math.atan((ch.rAt(t) * d2r(L)) / bandW);
    const wDeg = (t) => r2d(Math.asin(clamp(hw / Math.cos(leanAt(t)) / ch.rAt(t), 0, 1)));
    const cells = [];
    for (let n = 0; n <= rows; n++) {
      const tc = n / rows;
      // Levels stagger by half a pitch, alternating between two column
      // phases; folding the stagger into one pitch keeps the run centred on
      // the sector however high the level climbs. A segmented wheel then
      // walks one column past each seam, so the cells straddling a joint come
      // out as its matching halves and anything fully outside closes to
      // nothing below.
      const phase = mod((0.5 + n / 2) * P, P);
      for (let i = bounded ? -1 : 0; i < (bounded ? perSeg + 1 : perSeg); i++) {
        const thc = phase + i * P;
        // For every t the cell is one interval in θ — the gap left between
        // the struts bounding it. No arrangement bookkeeping, and no way for
        // the loop to fold or self-intersect.
        const left = (t) => {
          const v = thc - P / 2 + L * Math.abs(t - tc) + wDeg(t);
          return bounded ? Math.max(v, ch.seamDeg(t)) : v;
        };
        const right = (t) => {
          const v = thc + P / 2 - L * Math.abs(t - tc) - wDeg(t);
          return bounded ? Math.min(v, A - ch.seamDeg(t)) : v;
        };
        const openMm = (t) => d2r(right(t) - left(t)) * ch.rAt(t);
        const tSeed = clamp(tc, tPad, 1 - tPad);
        if (openMm(tSeed) < 2.5) continue;
        // right − left is concave in t, so the cell is a single run: bisect
        // out to where it pinches shut, or stop at the band edge.
        const edgeAt = (limit) => {
          if (openMm(limit) > 0) return limit;
          let lo = tSeed;
          let hi = limit;
          for (let it = 0; it < 22; it++) {
            const m = (lo + hi) / 2;
            if (openMm(m) > 0) lo = m;
            else hi = m;
          }
          return lo;
        };
        const tLo = edgeAt(tPad);
        const tHi = edgeAt(1 - tPad);
        if (tHi - tLo < 1e-4) continue;
        const ts = [tLo];
        const walk = (a, z) => {
          const k = chartSteps(ch, [thc + L * a, a], [thc + L * z, z]);
          for (let q = 1; q <= k; q++) ts.push(a + ((z - a) * q) / k);
        };
        if (tc > tLo + 1e-6 && tc < tHi - 1e-6) {
          walk(tLo, tc); // keep the crossing level: that is where the cell kinks
          walk(tc, tHi);
        } else {
          walk(tLo, tHi);
        }
        const chart = [];
        const along = (t, th0, th1) => {
          const k = chartSteps(ch, [th0, t], [th1, t]);
          for (let q = 0; q <= k; q++) chart.push([th0 + ((th1 - th0) * q) / k, t]);
        };
        along(tLo, left(tLo), right(tLo)); // inner edge, walked CCW
        for (let q = 1; q < ts.length; q++) chart.push([right(ts[q]), ts[q]]);
        along(tHi, right(tHi), left(tHi)); // outer edge
        for (let q = ts.length - 2; q >= 1; q--) chart.push([left(ts[q]), ts[q]]);
        const pts = filletLoop(
          chart.map(([th, t]) => ch.xy(th, t)),
          lt.cornerRadius
        );
        const tMid = (tLo + tHi) / 2;
        const cut = loopCutter(`lat${cells.length + 1}`, pts, ch.xy((left(tMid) + right(tMid)) / 2, tMid), zThrough);
        if (cut) cells.push(cut);
      }
    }
    if (cells.length) {
      shared.push(...cells);
      infillInfo = {
        style: 'lattice',
        rows,
        strutsTotal: struts,
        strutsPerSegment: perSeg,
        cellsPerSegment: cells.length,
        strutWidth: rnd(lt.strutWidth, 2),
        lean: rnd(L, 1),
        cornerRadius: rnd(lt.cornerRadius, 2),
      };
      if (lt.strutWidth < 1.6) {
        notes.push(`Lattice struts are ${rnd(lt.strutWidth, 2)} mm — under four 0.4 mm extrusions; expect a fragile web on a stock nozzle.`);
      }
    } else {
      notes.push('Lattice cells did not clear the joint keep-outs; web left solid.');
      infillInfo = { style: 'solid' };
    }
  } else if (infill === 'auxetic' && bandW > 14) {
    // Auxetic (re-entrant) honeycomb. Each void is a hexagon whose two waist
    // vertices are pulled back *inside* the cell, so under load the ribs fold
    // rather than stretch and the web draws inward as it is squeezed — a
    // negative Poisson's ratio, which is why the pattern keeps turning up in
    // airless-tire research. Cells sit on concentric rings in the chart,
    // brick-staggered ring to ring, so the lattice curves with the wheel.
    //
    // Walls hold by construction. Rings are pitched cellHeight + wall apart,
    // so any two cells in different rings differ in radius by at least `wall`.
    // Within a ring the angular pitch leaves a gap subtending a `wall` chord
    // at the ring's *inner* radius, and for two points at angular separation
    // g with radii ≥ ρ the distance bottoms out at 2ρ·sin(g/2) — so the
    // tightest point on that wall is the one that was measured.
    const ax = p.auxetic;
    const ch = webChart(rWebIn, rWebOut, A, N, jointOutN + 2.5);
    const wall = ax.wall + SAG_TOL;
    let rings = ax.rings > 0 ? ax.rings : clamp(Math.round(bandW / 26), 1, 5);
    while (rings > 1 && bandW / rings - wall < 4) rings--;
    const cellH = bandW / rings - wall;
    const bt = cellH / 2 / bandW;
    // Cell width is read at a ring's mid radius, but a ring close to the hub
    // has so little circumference that the asked-for width would eat a third
    // of the turn — that reads as a few lobes, not a honeycomb.
    const MAX_PITCH = 30; // deg — at least a dozen cells around any full ring
    let skipped = 0;
    let narrowed = false;
    const build = (grow) => {
      skipped = 0;
      narrowed = false;
      // Every ring shares one angular pitch and one run — shared columns are
      // what let the half-pitch stagger read as a brick bond instead of
      // drifting into a beat pattern — and both come from the *outermost*
      // ring, which has the most room. Inner rings then hold the same cell
      // count and simply narrow with the radius; one too tight against the
      // seams to carry that run is left solid rather than breaking the bond.
      const tcOut = (rings - 0.5) / rings;
      const want = (ax.cellSize > 0 ? ax.cellSize : cellH * 0.95) * grow;
      const wide = 2 * ch.halfDeg(want + wall, tcOut);
      let pit = Math.min(wide, MAX_PITCH);
      narrowed = pit < wide - 1e-9;
      if (!(pit > 0.05)) return [];
      let cols;
      if (N === 1) {
        cols = Math.max(3, Math.round(360 / pit));
        pit = 360 / cols;
      } else {
        cols = Math.floor((A - 2 * ch.seamDeg(tcOut - bt)) / pit + 1e-9);
        if (cols < 1) return [];
      }
      // Centring the run on the sector puts it at the same angles in every
      // ring, whatever each ring's own keep-out costs it.
      const run = cols * pit;
      const start = A / 2 - run / 2;
      const out = [];
      for (let j = 0; j < rings; j++) {
        const tc = (j + 0.5) / rings;
        const tIn = tc - bt;
        const alpha = pit / 2 - ch.halfDeg(wall, tIn);
        if (alpha <= 0.05) {
          skipped++;
          continue;
        }
        // Staggered rings carry one cell fewer so they stay inside the run.
        const cnt = N === 1 ? cols : j % 2 ? cols - 1 : cols;
        // A ring pinched by the seams keeps the columns that clear them and
        // drops the rest — the bond survives, the ring just runs shorter.
        const lo = N === 1 ? -Infinity : ch.seamDeg(tIn);
        const hi = N === 1 ? Infinity : A - lo;
        const centres = [];
        for (let i = 0; i < cnt; i++) {
          const thc = N === 1 ? (j % 2 ? pit / 2 : 0) + i * pit : start + (j % 2 ? i + 1 : i + 0.5) * pit;
          if (thc - alpha >= lo - 1e-9 && thc + alpha <= hi + 1e-9) centres.push(thc);
        }
        if (!centres.length) {
          skipped++;
          continue;
        }
        const beta = ax.waist * alpha;
        // A rounded waist bows outward into the wall. The cell has α − β of
        // angular slack there, so the fillet may spend a fraction of it.
        const bulge = 0.45 * d2r(alpha - beta) * ch.rAt(tc);
        for (const thc of centres) {
          const poly = [
            [thc + alpha, tc + bt],
            [thc - alpha, tc + bt],
            [thc - beta, tc], // re-entrant waist
            [thc - alpha, tc - bt],
            [thc + alpha, tc - bt],
            [thc + beta, tc], // re-entrant waist
          ];
          const pts = filletLoop(chartPolyPoints(ch, poly), ax.cornerRadius, { maxBulge: bulge });
          const cut = loopCutter(`aux${out.length + 1}`, pts, ch.xy(thc, tc), zThrough);
          if (cut) out.push(cut);
        }
      }
      return out;
    };
    let grow = 1;
    let cells = build(grow);
    for (let attempt = 0; attempt < 8 && cells.length > WEB_CELL_CAP; attempt++) {
      grow *= 1.3;
      cells = build(grow);
    }
    if (cells.length) {
      shared.push(...cells);
      const cellW = (ax.cellSize > 0 ? ax.cellSize : cellH * 0.95) * grow;
      infillInfo = {
        style: 'auxetic',
        rings,
        cellsPerSegment: cells.length,
        cellWidth: rnd(cellW, 1),
        cellHeight: rnd(cellH, 1),
        waist: rnd(ax.waist, 2),
        wall: rnd(ax.wall, 2),
        cornerRadius: rnd(ax.cornerRadius, 2),
      };
      if (grow > 1) {
        notes.push(`Auxetic cells widened to ${rnd(cellW, 1)} mm to stay inside the ${WEB_CELL_CAP}-void budget.`);
      }
      if (skipped) {
        notes.push(`${skipped} auxetic ring${skipped === 1 ? '' : 's'} near the hub had no room for the pattern clear of the seams; left solid.`);
      }
      if (narrowed) {
        notes.push('Auxetic cells were narrowed — the full width would have taken too big a bite out of the wheel.');
      }
      if (ax.wall < 1.2) {
        notes.push(`Auxetic wall ${rnd(ax.wall, 2)} mm is under three 0.4 mm extrusions; expect a fragile web on a stock nozzle.`);
      }
    } else {
      notes.push('Auxetic cells did not fit the web band clear of the seams; web left solid.');
      infillInfo = { style: 'solid' };
    }
  } else if (infill === 'graded' && bandW > 14) {
    // Graded rings — the regular airless-tire web: concentric rings of cells
    // that grow with the radius, small around the hub and large at the rim.
    // Every ring shares one angular pitch, so a cell is as wide as its own
    // radius makes it; `grade` spaces the ring boundaries geometrically so
    // the height grows with the width and each cell comes out a scaled copy
    // of the one inside it. `cellShape` opens or closes the cell's waist —
    // straight-sided rect, pointed diamond, or the hexagon in between — and
    // `swirl` leans the whole stack tangentially for a turbine web.
    //
    // Walls hold by construction, the same two ways the auxetic's do. Ring
    // boundaries are pitched a full `wall` apart radially, so two cells in
    // different rings can never come closer than that. Within a ring the
    // angular gap subtends a `wall` chord at the ring's *inner* radius, and
    // two points at angular separation g with radii ≥ ρ are 2ρ·sin(g/2)
    // apart at worst — so the tightest point on that wall is the one that was
    // measured. Swirl is a shear of the chart: at any given t it moves every
    // cell of a ring by the same amount, which leaves both gaps alone.
    const gr = p.graded;
    const ch = webChart(rWebIn, rWebOut, A, N, jointOutN + 2.5);
    const wall = gr.wall + SAG_TOL;
    // Ring boundaries in t. Linear spacing gives every ring the same height;
    // geometric spacing (one ratio q per ring) makes each ring's height
    // proportional to its radius. `grade` blends the two — both are strictly
    // increasing in k, so every blend of them is too.
    const ringBounds = (n) => {
      const q = (rWebOut / rWebIn) ** (1 / n);
      const out = [];
      for (let k = 0; k <= n; k++) {
        const lin = rWebIn + (bandW * k) / n;
        const r = lin + (rWebIn * q ** k - lin) * gr.grade;
        out.push((r - rWebIn) / bandW);
      }
      return out;
    };
    // Auto ring count. The band width sets the floor, the way it does for
    // every other web: ~26 mm of band per ring keeps cells a sensible size on
    // the wheel. Grading then asks for more, because each ring is a fixed
    // factor larger than the last and a band that spans a big range of radii
    // needs the extra rings to keep that step under ~1.4x — past which the
    // cells grow too fast to read as one pattern.
    const byBand = bandW / 26;
    const byRatio = Math.log(rWebOut / rWebIn) / Math.log(1.4);
    let rings = gr.rings > 0 ? gr.rings : clamp(Math.round(Math.max(byBand, byRatio * gr.grade)), 1, 6);
    // The innermost ring is always the shallowest; drop rings until it has
    // real height left once its two half-walls are taken off.
    while (rings > 1 && (ringBounds(rings)[1] - ringBounds(rings)[0]) * bandW - wall < 4) rings--;
    const bnds = ringBounds(rings);
    const MAX_PITCH = 30; // deg — at least a dozen cells around any full ring
    // Half-width at a cell's flat ends, as a fraction of its half-width at the
    // waist: 1 keeps the sides straight, 0 pulls the ends to a point.
    const endFrac = { hex: 0.55, rect: 1, diamond: 0 }[gr.cellShape];
    let skipped = 0;
    let narrowed = false;
    let pitch = 0;
    let widths = [];
    const build = (grow) => {
      skipped = 0;
      narrowed = false;
      widths = [];
      // One pitch for the whole web, read off the ring in the middle of the
      // band: cells come out square there, and everything inboard and
      // outboard of it inherits the pitch and simply takes the width its own
      // radius buys. (Reading it off the innermost ring instead makes the
      // number hostage to the tightest, least representative ring on the
      // wheel — and with uniform rings, absurd.)
      const mid = Math.floor(rings / 2);
      const t0 = bnds[mid] + wall / 2 / bandW;
      const t1 = bnds[mid + 1] - wall / 2 / bandW;
      const size = ((t1 - t0) * bandW * 1.15 + wall) * grow; // ≈ square cells there
      let want = gr.cells > 0 ? (360 / gr.cells) * grow : 2 * ch.halfDeg(size, (t0 + t1) / 2);
      narrowed = want > MAX_PITCH;
      want = Math.min(want, MAX_PITCH);
      if (!(want > 0.05)) return [];
      pitch = want;
      const out = [];
      for (let j = 0; j < rings; j++) {
        const tIn = bnds[j] + wall / 2 / bandW;
        const tOut = bnds[j + 1] - wall / 2 / bandW;
        const tc = (tIn + tOut) / 2;
        // A ring runs from seam keep-out to seam keep-out, and the keep-out is
        // an angle that shrinks as the radius grows — so the run a ring has to
        // play with is its own, several times wider at the rim than at the
        // hub. Each ring therefore takes the whole number of cells nearest the
        // shared pitch and stretches to fill: the pattern still grows with the
        // radius, but no ring leaves most of a cell's width standing solid
        // beside the joint.
        //
        // Swirl leans each cell off radial by that many degrees — measured on
        // the wheel, so the lean reads the same at every radius. Leaning about
        // the ring's own mid radius holds a cell's excursion to half its
        // height, and the run gives that excursion back at both ends, so a
        // swirled ring simply carries fewer cells rather than losing them to
        // the seam.
        const exc = r2d((Math.abs(Math.tan(d2r(gr.swirl))) * (tOut - tIn) * bandW) / 2 / ch.rAt(tc));
        const off = (t) => r2d((Math.tan(d2r(gr.swirl)) * (t - tc) * bandW) / ch.rAt(tc));
        const seam = N === 1 ? 0 : ch.seamDeg(tIn);
        const lo = seam + exc;
        const run = N === 1 ? 360 : A - 2 * lo;
        let cols = N === 1 ? Math.max(6, Math.round(run / want)) : Math.round(run / want);
        if (cols >= 1 && run / cols > 1.35 * want) cols++; // one fat cell → two ordinary ones
        if (cols < 1 || (tOut - tIn) * bandW < 3) {
          skipped++;
          continue;
        }
        const pit = run / cols;
        const alpha = pit / 2 - ch.halfDeg(wall, tIn);
        if (alpha <= 0.05) {
          skipped++;
          continue;
        }
        // Rings brick-stagger, so the radial walls of one ring sit over the
        // middle of the cells in the next — the bond that makes the web read
        // as a comb rather than a stack of grilles. A ring with a single cell
        // has nothing to stagger against and would only lose it.
        const stag = j % 2 === 1 && cols > 1;
        const oLo = Math.min(off(tIn), off(tOut)) - alpha;
        const oHi = Math.max(off(tIn), off(tOut)) + alpha;
        const centres = [];
        // A staggered ring on a segmented wheel carries one cell fewer: the
        // half-cell the shift pushes over each seam cannot be cut, so the
        // joint rib simply runs wider on those rings.
        for (let i = 0; i < (stag && N > 1 ? cols - 1 : cols); i++) {
          const thc = N === 1 ? (i + (stag ? 0.5 : 0)) * pit : lo + (stag ? i + 1 : i + 0.5) * pit;
          if (N === 1 || (thc + oLo >= seam - 1e-9 && thc + oHi <= A - seam + 1e-9)) centres.push(thc);
        }
        if (!centres.length) {
          skipped++;
          continue;
        }
        // A cell narrower than a nozzle pass or two is noise, not a pattern.
        const cellW = 2 * ch.rAt(tc) * Math.sin(d2r(alpha));
        if (cellW < 3) {
          skipped++;
          continue;
        }
        if (!widths.length) pitch = pit; // the count reported is the innermost ring's
        widths.push(cellW);
        const aEnd = endFrac * alpha;
        for (const thc of centres) {
          const th = (t) => thc + off(t);
          // Walked as one cycle: outer end, out to the waist, inner end, back.
          // A rect has no waist to visit and a diamond has no end to flatten,
          // so each drops the vertices it does not have rather than emitting
          // one twice over.
          const poly = [];
          if (aEnd > 1e-6) poly.push([th(tOut) - aEnd, tOut], [th(tOut) + aEnd, tOut]);
          else poly.push([th(tOut), tOut]);
          if (aEnd < alpha - 1e-6) poly.push([th(tc) + alpha, tc]);
          if (aEnd > 1e-6) poly.push([th(tIn) + aEnd, tIn], [th(tIn) - aEnd, tIn]);
          else poly.push([th(tIn), tIn]);
          if (aEnd < alpha - 1e-6) poly.push([th(tc) - alpha, tc]);
          // Every corner is convex, so a fillet only ever hands material back.
          const pts = filletLoop(chartPolyPoints(ch, poly), gr.cornerRadius);
          const cut = loopCutter(`grd${out.length + 1}`, pts, ch.xy(th(tc), tc), zThrough);
          if (cut) out.push(cut);
        }
      }
      return out;
    };
    let grow = 1;
    let cells = build(grow);
    const overBudget = cells.length > WEB_CELL_CAP;
    // Cell count runs as 1/pitch, so the factor that lands on the budget can
    // be read straight off the overshoot instead of crept up on.
    for (let attempt = 0; attempt < 8 && cells.length > WEB_CELL_CAP; attempt++) {
      grow *= Math.max(1.3, (cells.length / WEB_CELL_CAP) * 1.05);
      cells = build(grow);
    }
    if (cells.length) {
      shared.push(...cells);
      infillInfo = {
        style: 'graded',
        rings: rings - skipped,
        cellsPerSegment: cells.length,
        cellsPerTurn: Math.round(360 / pitch),
        cellShape: gr.cellShape,
        innerCell: rnd(widths[0], 1),
        outerCell: rnd(widths[widths.length - 1], 1),
        wall: rnd(gr.wall, 2),
        grade: rnd(gr.grade, 2),
        swirl: rnd(gr.swirl, 1),
        cornerRadius: rnd(gr.cornerRadius, 2),
      };
      if (gr.rings > 0 && rings !== gr.rings) {
        notes.push(`Graded rings reduced ${gr.rings} → ${rings} so the innermost ring keeps a printable cell height.`);
      }
      if (overBudget) {
        notes.push(`Graded cells widened to ${rnd(widths[0], 1)} mm at the hub to stay inside the ${WEB_CELL_CAP}-void budget.`);
      } else if (narrowed) {
        notes.push(`Graded cells were capped at ${MAX_PITCH}° of arc — the width asked for would have taken too big a bite out of the wheel.`);
      }
      if (skipped) {
        notes.push(`${skipped} graded ring${skipped === 1 ? '' : 's'} had no room for the pattern clear of the seams; left solid.`);
      }
      if (gr.wall < 1.2) {
        notes.push(`Graded wall ${rnd(gr.wall, 2)} mm is under three 0.4 mm extrusions; expect a fragile web on a stock nozzle.`);
      }
    } else {
      notes.push('Graded cells did not fit the web band clear of the seams; web left solid.');
      infillInfo = { style: 'solid' };
    }
  } else if (infill === 'voronoi' && bandW > 14) {
    // Organic web: a seeded Voronoi tessellation of the unrolled band, every
    // cell pulled back by half a wall so the material left between neighbours
    // measures `wall`. Seeds start on a jittered grid and take two rounds of
    // Lloyd relaxation, which evens the cells out without making them look
    // machined. The PRNG is seeded from the parameter and nothing here touches
    // Math.random(), so a given seed always replans to the same web.
    const vo = p.voronoi;
    const dFace = jointOutN + 2.5;
    const ch = webChart(rWebIn, rWebOut, A, N, dFace);
    const rMid = (rWebIn + rWebOut) / 2;
    const kArc = (Math.PI * rMid) / 180; // mm of arc per degree of θ, at rMid
    // Work coordinates (s, y) are the chart scaled to millimetres at the mid
    // radius, so everything below is plain straight-line convex geometry; the
    // metric correction rides on each inset instead.
    const yLo = vo.wall / 2;
    const yHi = bandW - vo.wall / 2;
    const period = 360 * kArc;
    const sMax = A * kArc;
    // Seam keep-out is a straight-line distance from the seam plane, so in s
    // it is dFace·rMid/r — widest at the hub. Sampling it as a polyline gives
    // a convex domain that stays inside the true keep-out (the chords of a
    // convex boundary fall on the safe side).
    const sSeam = (y) => (N === 1 ? 0 : r2d(Math.asin(clamp(dFace / (rWebIn + y), 0, 1))) * kArc);
    const LEVELS = 4;
    const yAt = (i) => yLo + ((yHi - yLo) * i) / (LEVELS - 1);
    const domain = () => {
      if (N === 1) return [[-period, yLo], [2 * period, yLo], [2 * period, yHi], [-period, yHi]];
      const poly = [];
      for (let i = 0; i < LEVELS; i++) poly.push([sMax - sSeam(yAt(i)), yAt(i)]); // right, walking out
      for (let i = LEVELS - 1; i >= 0; i--) poly.push([sSeam(yAt(i)), yAt(i)]); // left, walking back
      return poly;
    };
    const dom = domain();
    // One-piece wheels get an unbounded domain (the ghost seeds a turn away
    // are what close their cells), so the seedable area is the strip itself.
    const usable = N === 1 ? period * (yHi - yLo) : polyMoments(dom).area;
    if (yHi - yLo < 6 || usable < 400) {
      notes.push('Web band is too tight against the segment seams for a voronoi web; left solid.');
      infillInfo = { style: 'solid' };
    } else {
      const span = N === 1 ? period : sMax - 2 * sSeam(yAt(0));
      const target = clamp(Math.min(bandW, span) * 0.45, 9, 45);
      const auto = clamp(Math.round(usable / (target * target)), 3, 40);
      const n = clamp(vo.cells > 0 ? vo.cells : auto, 1, WEB_CELL_CAP);
      // Jittered grid: even coverage without the tell-tale regularity of one.
      const rand = mulberry32(vo.seed * 2654435761 + 12345);
      const boxW = N === 1 ? period : sMax - 2 * sSeam(yHi);
      const boxH = yHi - yLo;
      const gRows = Math.max(1, Math.round(Math.sqrt((n * boxH) / boxW)));
      const gCols = Math.max(1, Math.ceil(n / gRows));
      let seeds = [];
      for (let r0 = 0; r0 < gRows && seeds.length < n; r0++) {
        for (let c0 = 0; c0 < gCols && seeds.length < n; c0++) {
          const y = yLo + ((r0 + 0.5 + (rand() - 0.5) * 0.7) * boxH) / gRows;
          const s = (N === 1 ? 0 : sSeam(yHi)) + ((c0 + 0.5 + (rand() - 0.5) * 0.7) * boxW) / gCols;
          // Rows near the hub lose width to the seam keep-out; fold their
          // seeds back inside so no cell starts life empty.
          seeds.push([N === 1 ? s : clamp(s, sSeam(y), sMax - sSeam(y)), y]);
        }
      }
      // A cell is the domain cut back by the bisector against every other
      // seed. One-piece wheels wrap, so each seed also competes with its own
      // copies a full turn away.
      const shifts = N === 1 ? [-period, 0, period] : [0];
      const cellOf = (i, pts) => {
        let poly = dom;
        for (let j = 0; j < pts.length && poly.length > 2; j++) {
          for (const sh of shifts) {
            if (j === i && sh === 0) continue;
            const nx = pts[i][0] - (pts[j][0] + sh);
            const ny = pts[i][1] - pts[j][1];
            const len = Math.hypot(nx, ny);
            if (len < 1e-9) continue;
            const mx = (pts[i][0] + pts[j][0] + sh) / 2;
            const my = (pts[i][1] + pts[j][1]) / 2;
            poly = clipHalf(poly, nx / len, ny / len, (nx * mx + ny * my) / len);
          }
        }
        return poly;
      };
      for (let it = 0; it < 2; it++) {
        seeds = seeds.map((s, i) => {
          const m = polyMoments(cellOf(i, seeds));
          if (Math.abs(m.area) < 1e-6) return s;
          return [N === 1 ? mod(m.c[0], period) : m.c[0], clamp(m.c[1], yLo, yHi)];
        });
      }
      const cells = [];
      for (let i = 0; i < seeds.length; i++) {
        const raw = cellOf(i, seeds);
        if (raw.length < 3) continue;
        // Pull every edge back so the material left against its neighbour
        // measures a full wall. Φ stretches the work plane by g = r/rMid
        // tangentially and 1 radially, so two chart-parallel lines h apart
        // come out g·h/|M·u| apart (u = the edge direction) — invert that for
        // h. Both owners of a shared edge run the same numbers off the same
        // edge, so the two half-walls add up exactly.
        let poly = raw;
        for (let e = 0; e < raw.length && poly.length > 2; e++) {
          const q0 = raw[e];
          const q1 = raw[(e + 1) % raw.length];
          const len = Math.hypot(q1[0] - q0[0], q1[1] - q0[1]);
          if (len < 1e-9) continue;
          const nx = -(q1[1] - q0[1]) / len; // inward normal of a CCW loop
          const ny = (q1[0] - q0[0]) / len;
          const g = (rWebIn + Math.min(q0[1], q1[1])) / rMid; // tightest along the edge
          const h = ((vo.wall + SAG_TOL) / 2 / g) * Math.hypot(nx, g * ny);
          poly = clipHalf(poly, nx, ny, nx * q0[0] + ny * q0[1] + h);
        }
        if (poly.length < 3) continue;
        const m = polyMoments(poly);
        if (Math.abs(m.area) < 8) continue; // too small to be worth a boolean
        const pts = filletLoop(
          chartPolyPoints(ch, poly.map(([s, y]) => [s / kArc, y / bandW])),
          vo.cornerRadius
        );
        const cut = loopCutter(`vor${cells.length + 1}`, pts, ch.xy(m.c[0] / kArc, m.c[1] / bandW), zThrough);
        if (cut) cells.push(cut);
      }
      if (cells.length) {
        shared.push(...cells);
        infillInfo = {
          style: 'voronoi',
          cellsPerSegment: cells.length,
          seed: vo.seed,
          wall: rnd(vo.wall, 2),
          cornerRadius: rnd(vo.cornerRadius, 2),
        };
        if (vo.wall < 1.2) {
          notes.push(`Voronoi wall ${rnd(vo.wall, 2)} mm is under three 0.4 mm extrusions; expect a fragile web on a stock nozzle.`);
        }
      } else {
        notes.push('Voronoi cells came out smaller than the wall allows; web left solid.');
        infillInfo = { style: 'solid' };
      }
    }
  } else if (infill !== 'solid') {
    notes.push(`Web band is only ${rnd(bandW, 1)} mm wide — too narrow for the ${infill} pattern; left solid.`);
    infillInfo = { style: 'solid' };
  }

  // Tread. The bars live in the section profiles (see outerAt above) and cost
  // nothing to build.
  //
  // The running surface — the crown and every circumferential groove — is one
  // revolved tool. Its profile is drawn in the (r, z) half-plane and swept
  // about the wheel axis, so the crown comes out as an exact arc of the
  // section circle and a groove floor as that same arc offset inward. One
  // tool however many grooves there are, and no approximation anywhere.
  //
  // A flat, ungrooved tread needs no tool at all: the piece profile already
  // *is* the finished surface, so those wheels stay a single prism.
  if (crowned || ribBands.length) {
    // Walk the width as alternating [z0, z1, depth] runs: crown, groove,
    // crown, … Each run is one entity; the step between two runs is the
    // groove's wall.
    const runs = [];
    let at = 0;
    for (const [a, b] of ribBands) {
      if (a - at > 1e-6) runs.push([at, a, 0]);
      runs.push([Math.max(a, at), b, ribDepth]);
      at = b;
    }
    if (W - at > 1e-6) runs.push([at, W, 0]);

    const zLo = -1;
    const zHi = W + 1;
    // How far out the tool's back face sits. It only has to clear the blank,
    // but *comfortably*: at mid-width the crown is at full radius, so a back
    // face close in leaves a razor-thin ring of tool there and the boolean
    // stops cutting cleanly. Measured on the Ø200 round tire, the result crept
    // from 623 792 mm³ at R + 0.2 down to a stable 620 530 by R + 2 — the thin
    // tool was under-cutting, not the thick one over-cutting.
    const rOut = rnd(R + 2);
    const crownC = [rnd(R - crownRadius), rnd(halfW)];
    const rz = (r, z) => [rnd(r), rnd(z, 4)];
    const segs = [];
    let prev = null;
    for (const [za, zb, depth] of runs) {
      const pa = rz(surfaceR(za, depth), za);
      const pb = rz(surfaceR(zb, depth), zb);
      // The radial step into or out of a groove.
      if (prev) segs.push({ kind: 'line', a: prev, b: pa });
      segs.push(
        crowned
          ? { kind: 'arc', a: pa, b: pb, center: crownC, radius: rnd(crownRadius - depth), ccw: true }
          : { kind: 'line', a: pa, b: pb }
      );
      prev = pb;
    }
    const first = segs[0].a;
    const last = prev;
    // Where the full revolution's seam falls, in degrees.
    //
    // A revolved solid's seam is a real edge of it, and OpenCascade's boolean
    // silently does *nothing* when that seam lies in the same plane as a
    // planar face of the body — no error, no warning, the blank simply comes
    // back untouched. Measured on a Ø355.6 crowned sector: 825 058.7 mm³
    // before the cut and 825 058.7 after, and 807 048.9 with the seam moved
    // anywhere else at all.
    //
    // So it is parked where this piece has no radial face. A segmented wheel
    // has two, at 0° and A°, and the roomiest spot is the far side of the
    // wheel from them. A one-piece wheel has none except the walls of its
    // tread windows, so the seam goes down the middle of a bar. (A *slanted*
    // wall sweeps as it crosses the width and so can only ever touch the seam
    // along a line, which is harmless — it is the coplanar case that bites.)
    const seam = mod(N > 1 ? (A + 360) / 2 : barCount ? barPhase(0) : 0, 360);
    // Close the loop out past the rim and beyond both faces, so no face of the
    // tool is ever coplanar with a face of the piece.
    shared.push({
      id: 'tire',
      shape: 'revolve',
      seam: rnd(seam, 4),
      segs: [
        { kind: 'line', a: rz(first[0], zLo), b: first },
        ...segs,
        { kind: 'line', a: last, b: rz(last[0], zHi) },
        { kind: 'line', a: rz(last[0], zHi), b: rz(rOut, zHi) },
        { kind: 'line', a: rz(rOut, zHi), b: rz(rOut, zLo) },
        { kind: 'line', a: rz(rOut, zLo), b: rz(first[0], zLo) },
      ],
    });
  }

  // -------------------------------------------------------------------------
  // Per-piece cutters (bore, keyway, bolts) in canonical frame + dedupe
  // -------------------------------------------------------------------------
  const pieceCutters = (k) => {
    const cut = [];
    const rot = -k * A; // canonical frame rotation of global features
    if (b.type === 'hex') {
      const crHex = (b.hexAcrossFlats / 2 + clr) / Math.cos(d2r(30));
      cut.push({ id: 'bore', shape: 'poly', pts: regularPoly(0, 0, crHex, 6, mod(rot, 60)), ...zThrough });
    } else if (b.type === 'dbore') {
      const flatDir = N > 1 ? A / 2 : 90;
      const gamma = r2d(Math.acos(clamp(b.flatOffset / rbEff, -1, 1)));
      const pad = r2d(2 / rbEff);
      const w0 = k * A;
      const w1 = (k + 1) * A;
      if (angIntervalsOverlap(w0 - pad, w1 + pad, flatDir - gamma, flatDir + gamma)) {
        const fd = flatDir + rot;
        const e1 = polar(rbEff, fd - gamma);
        const e2 = polar(rbEff, fd + gamma);
        cut.push({
          id: 'bore',
          shape: 'path',
          segs: [
            { kind: 'arc', a: e2, b: e1, center: [0, 0], radius: rbEff, ccw: true }, // major arc
            { kind: 'line', a: e1, b: e2 }, // the flat
          ],
          interior: [0, 0],
          ...zThrough,
        });
      } else {
        cut.push({ id: 'bore', shape: 'circle', c: [0, 0], r: rnd(rbEff), ...zThrough });
      }
    } else {
      // Bolt hubs centre on the pilot bore; bore.diameter is not used there.
      const rCenter = b.type === 'bolt' ? b.pilotDia / 2 + clr : rbEff;
      // Segmented concentric bores live in the outline (rInner above); only
      // one-piece wheels need the through-hole cutter.
      if (!boreConcentric || N === 1) {
        cut.push({ id: 'bore', shape: 'circle', c: [0, 0], r: rnd(rCenter), ...zThrough });
      }
    }
    if (b.type === 'keyed') {
      const keyDir = N > 1 ? A / 2 : 90;
      const half = r2d((b.keyWidth / 2 + 2) / rbEff);
      if (N === 1 || angIntervalsOverlap(k * A, (k + 1) * A, keyDir - half, keyDir + half)) {
        const ang = keyDir + rot;
        const u = [Math.cos(d2r(ang)), Math.sin(d2r(ang))];
        const t = [-Math.sin(d2r(ang)), Math.cos(d2r(ang))];
        const r0 = rbEff - 1;
        const r1 = rbEff + b.keyDepth;
        const hwK = b.keyWidth / 2 + clr;
        cut.push({
          id: 'keyway',
          shape: 'poly',
          pts: [
            [r0 * u[0] - hwK * t[0], r0 * u[1] - hwK * t[1]],
            [r1 * u[0] - hwK * t[0], r1 * u[1] - hwK * t[1]],
            [r1 * u[0] + hwK * t[0], r1 * u[1] + hwK * t[1]],
            [r0 * u[0] + hwK * t[0], r0 * u[1] + hwK * t[1]],
          ],
          ...zThrough,
        });
      }
    }
    if (b.type === 'bolt') {
      let bi = 0;
      for (const ang of boltAnglesFor(N)) {
        const inWindow = N === 1 || (ang >= mod(k * A, 360) - 1e-9 && ang < mod(k * A, 360) + A - 1e-9);
        if (inWindow) {
          cut.push({ id: `bolt${++bi}`, shape: 'circle', c: polar(boltR, ang + rot).map((v) => rnd(v)), r: rnd(boltHoleR), ...zThrough });
        }
      }
    }
    return cut;
  };

  const sigToPiece = new Map();
  const pieces = [];
  for (let k = 0; k < N; k++) {
    const sig = featureSigForPiece(k, N);
    if (!sigToPiece.has(sig)) {
      const label = String.fromCharCode(65 + sigToPiece.size);
      sigToPiece.set(sig, { label, count: 0, ks: [], cutters: [...pieceCutters(k), ...shared] });
    }
    const up = sigToPiece.get(sig);
    up.count++;
    up.ks.push(k);
    pieces.push({ k, label: up.label });
  }
  const uniquePieces = [...sigToPiece.values()];

  // -------------------------------------------------------------------------
  // Bounding box of a piece (canonical outline rotated print-flat symmetric)
  // -------------------------------------------------------------------------
  let bbox;
  if (N === 1) {
    bbox = { w: rnd(p.diameter, 1), d: rnd(p.diameter, 1), rotForPrint: 0 };
  } else {
    // Measured off a section drawn at the true radius: the blank carries a
    // small radial overshoot that the tire tool cuts away, and the number
    // quoted here is the piece that comes out.
    const measured = rimOver ? sectionAt(outline.z, 0) : outline;
    const rot = 90 - A / 2;
    const pts = [];
    for (const s of measured.segs) {
      pts.push(rotPt(s.a, rot), rotPt(s.b, rot));
      if (s.kind === 'arc') {
        // arc extremes at axis-aligned angles
        const a0 = r2d(Math.atan2(s.a[1], s.a[0]));
        const a1 = r2d(Math.atan2(s.b[1], s.b[0]));
        const lo = Math.min(mod(a0, 360), mod(a1, 360));
        const hi = Math.max(mod(a0, 360), mod(a1, 360));
        for (let q = 0; q <= 360; q += 90) {
          if (q >= lo && q <= hi) pts.push(rotPt(polar(s.radius, q), rot));
        }
      }
    }
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    bbox = {
      w: rnd(Math.max(...xs) - Math.min(...xs), 1),
      d: rnd(Math.max(...ys) - Math.min(...ys), 1),
      rotForPrint: rnd(rot, 1),
    };
  }
  const pieceFits = N === 1 ? wholeFits && W <= uz : fitsXY(bbox) && W <= uz;

  // -------------------------------------------------------------------------
  // Recommendations
  // -------------------------------------------------------------------------
  const glue = {
    tpu: {
      name: 'Flexible contact adhesive (E6000 / Shoe Goo class)',
      why: 'TPU flexes — rigid glue lines crack. A flexible adhesive moves with the joint.',
      tips: 'Scuff mating faces, clean with IPA, thin bead in each dovetail pocket and on both faces, slide together, wipe squeeze-out, cure 24 h.',
    },
    pla: {
      name: 'Flexible polyurethane construction adhesive (e.g., Loctite PL Premium class)',
      why: 'A wheel sees shock and vibration; slightly flexible PU survives impacts that brittle CA lines will not. Use 2-part epoxy instead if you want maximum stiffness.',
      tips: 'Thin bead in each dovetail pocket and along both faces, slide together, clamp lightly, wipe squeeze-out, cure 24 h.',
    },
    petg: {
      name: 'Flexible polyurethane construction adhesive (e.g., Loctite PL Premium class)',
      why: 'PETG bonds poorly with CA; PU grips it well and tolerates flex and vibration.',
      tips: 'Scuff faces with 120-grit, clean with IPA, thin bead in pockets and faces, slide, wipe, cure 24 h.',
    },
    abs: {
      name: 'Acetone solvent weld (or flexible PU where impact matters)',
      why: 'Acetone welds ABS into a near-monolithic part — strongest option. PU stays flexible if the wheel takes hard impacts.',
      tips: 'Brush acetone on both faces, slide together immediately, hold 60 s, full strength in 24 h.',
    },
  }[p.material];

  const printRec = {
    orientation: 'Pieces are generated lying flat — print them exactly as exported.',
    walls: p.material === 'tpu' ? 3 : 4,
    infillPct: p.material === 'tpu' ? 18 : 30,
    infillPattern: 'gyroid',
    note:
      p.material === 'tpu'
        ? `TPU 95A, slow (~25 mm/s), no part cooling for first layers. The modeled ${['flexweb', 'lattice', 'auxetic'].includes(infillInfo.style) ? `${infillInfo.style} web does the springing` : 'web carries the load'} — slicer infill just fills walls.`
        : 'The structural pattern is modeled in the part; slicer infill only fills the solid ribs.',
  };

  return {
    params: p,
    radii: {
      R: rnd(R),
      rRimIn: rnd(rRimIn),
      rimBandT: rnd(rimBandT),
      rHub: rnd(rHub),
      rInner: rnd(rInner),
      boreMaxR: rnd(boreMaxR),
      rWebIn: rnd(rWebIn),
      rWebOut: rnd(rWebOut),
      treadEff: rnd(treadEff),
    },
    W: rnd(W),
    N,
    segAngle: rnd(A, 4),
    solidDisk,
    joints,
    jointClearance: jc,
    profile: {
      shape: crowned ? p.profile.shape : 'flat',
      crownDrop: rnd(crownDrop, 2),
      // 1e-3, the same grid every other coordinate is on: the revolved
      // cutter is built from this curve and `tireSurfaceAt` re-derives it,
      // so a display rounding here would put the preview and the CAD on
      // measurably different arcs.
      crownRadius: rnd(crownRadius, 3),
      shoulderR: rnd(R - crownDrop, 2),
      // Enough to reconstruct the running surface anywhere across the width;
      // `tireSurfaceAt` below is the only thing that should.
      grooves: ribBands.map(([a, b]) => [rnd(a, 4), rnd(b, 4)]),
      grooveDepth: rnd(ribDepth, 3),
    },
    sections,
    outline,
    pieces,
    uniquePieces,
    infillInfo,
    treadInfo,
    bbox,
    fit: {
      usable: { x: rnd(ux, 1), y: rnd(uy, 1), z: rnd(uz, 1) },
      wholeFits,
      pieceFits,
    },
    glue,
    printRec,
    warnings,
    notes,
  };
}

// Radius of the finished running surface at height z: the crown arc, less a
// groove where one falls.
//
// The revolved tire tool cuts exactly this curve, and the preview has to draw
// exactly the same one — so there is one implementation of it and both sides
// call it. (It lives here rather than in the planner's closure because the
// browser needs it too, and `wheel.js` is the module both runtimes share.)
export function tireSurfaceAt(plan) {
  const R = plan.radii.R;
  const halfW = plan.W / 2;
  const { crownDrop, crownRadius, grooves = [], grooveDepth = 0 } = plan.profile;
  return (z) => {
    const d = grooves.some(([a, b]) => z >= a - 1e-9 && z <= b + 1e-9) ? grooveDepth : 0;
    return crownDrop > 0
      ? R - crownRadius + Math.sqrt(Math.max(0, (crownRadius - d) ** 2 - (z - halfW) ** 2))
      : R - d;
  };
}

// Heights at which a renderer should sample the running surface.
//
// Equal *arc angle*, not equal height: a circular section curves hardest at
// the shoulders, so uniform-in-z sampling puts its coarsest facets exactly
// where the curve needs them finest. That is what made the lofted crown this
// replaces 2.99 mm wrong at the shoulder of the Ø200 round preset — the CAD no
// longer samples the curve at all, but a triangle mesh still has to.
export function tireLevels(plan, n = 40) {
  const W = plan.W;
  const halfW = W / 2;
  const { crownDrop, crownRadius, grooves = [] } = plan.profile;
  const zs = new Set([0, W, ...plan.sections.map((s) => s.z)]);
  // Every groove gets a level just *outside* each wall as well as on it.
  //
  // On the wall alone is not enough, and the failure is quiet: a level exactly
  // on a boundary counts as inside the groove, so two neighbouring grooves'
  // facing walls are both at groove depth and the ring between them is
  // interpolated at groove depth too — the land between the grooves simply
  // disappears. On a Ø355.6 × 50 tread with three grooves that lost 17 % of
  // the piece from the preview.
  const eps = 1e-3;
  for (const [a, b] of grooves) {
    for (const z of [a - eps, a, b, b + eps]) zs.add(rnd(clamp(z, 0, W), 4));
  }
  if (crownDrop > 0) {
    const phi = Math.asin(clamp(halfW / crownRadius, -1, 1));
    for (let i = 0; i <= n; i++) {
      zs.add(rnd(clamp(halfW + crownRadius * Math.sin(-phi + (2 * phi * i) / n), 0, W), 4));
    }
  }
  return [...zs].sort((a, b) => a - b);
}
