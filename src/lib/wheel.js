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
// (profile + z-range). Both the KCL generator and the Three.js preview
// consume this same plan, so the preview matches the generated CAD.

export const IN = 25.4;

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
  infill: 'spokes', // solid | spokes | honeycomb | flexweb
  spokeCount: 0, // 0 = auto
  tread: 'lugged', // slick | ribbed | lugged | diamond
  treadDepth: 3.5,
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
  printer: { x: 220, y: 220, z: 250, margin: 10 },
  joint: { clearance: 0.15 }, // per-side dovetail slide clearance
  boreClearance: 0.2,
  segmentsOverride: 0, // 0 = auto
});

const LENGTH_FIELDS = [
  ['diameter'],
  ['width'],
  ['treadDepth'],
  ['bore', 'diameter'],
  ['bore', 'keyWidth'],
  ['bore', 'keyDepth'],
  ['bore', 'hexAcrossFlats'],
  ['bore', 'flatOffset'],
  ['bore', 'boltCircle'],
  ['bore', 'boltHoleDia'],
  ['bore', 'pilotDia'],
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
  p.bore.boltCount = clamp(Math.round(Number(p.bore.boltCount) || 4), 2, 12);

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
  if (!['solid', 'spokes', 'honeycomb', 'flexweb'].includes(p.infill)) p.infill = 'spokes';
  if (!['slick', 'ribbed', 'lugged', 'diamond'].includes(p.tread)) p.tread = 'lugged';
  if (!['plain', 'keyed', 'hex', 'dbore', 'bolt'].includes(p.bore.type)) p.bore.type = 'plain';

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

function rotPt([x, y], aDeg) {
  const c = Math.cos(d2r(aDeg));
  const s = Math.sin(d2r(aDeg));
  return [x * c - y * s, x * s + y * c];
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export function planWheel(input = {}) {
  const { p, warnings } = normalizeParams(input);
  const notes = [];

  const R = p.diameter / 2;
  const W = p.width;
  const treadEff = p.tread === 'slick' ? 0 : p.treadDepth;

  // Radial bands: [bore .. hub ring .. web (infill) .. rim ring .. tread .. R]
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
  // used to be trimmed too, but shaving that razor-thin coaxial sliver is
  // exactly the boolean Zoo's engine rejects — "cannot handle this 3D
  // subtraction yet" — at bolt-pilot radii, so it is modeled away instead.)
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
    if (N === 1) return { w: p.diameter, d: p.diameter };
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
  // Outline (canonical piece frame: sector spans [0°, A°])
  // -------------------------------------------------------------------------
  const jc = p.joint.clearance;
  let outline;
  if (N === 1) {
    outline = { kind: 'circle', r: rnd(R) };
  } else {
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
    segs.push({ kind: 'line', a: P, b: [R, 0] });
    // Outer arc, CCW 0 → A.
    segs.push({ kind: 'arc', a: [R, 0], b: polar(R, A), center: [0, 0], radius: R, ccw: true });
    // Face A (male tenons), walking inward.
    const u = [Math.cos(d2r(A)), Math.sin(d2r(A))];
    const t = [-Math.sin(d2r(A)), Math.cos(d2r(A))]; // out of the piece
    P = polar(R, A);
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
    outline = { kind: 'sector', segs, interior: polar((rHub + R) / 2, A / 2) };
  }

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
    let cr = clamp(bandW / 8, 4, 12); // hex circumradius
    const wall = 2.6;
    let cells = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      cells = [];
      const rowPitch = cr * 1.55 + wall;
      const rows = Math.max(1, Math.round((bandW - wall) / rowPitch));
      for (let i = 0; i < rows; i++) {
        const rc = rWebIn + (bandW / rows) * (i + 0.5);
        const cellHalf = r2d(cr / rc);
        const pitchAng = r2d((cr * Math.sqrt(3) + wall) / rc);
        if (N === 1) {
          const count = Math.max(1, Math.floor(360 / pitchAng));
          const actual = 360 / count;
          const phase = i % 2 ? actual / 2 : 0;
          for (let jj = 0; jj < count; jj++) cells.push({ rc: rnd(rc), ang: rnd(phase + jj * actual, 3) });
        } else {
          // Center the row's cells inside the joint keep-outs.
          const lo = faceMarginAng(rc) + cellHalf;
          const hi = A - faceMarginAng(rc) - cellHalf;
          if (hi <= lo) continue;
          const span = hi - lo;
          const count = 1 + Math.floor(span / pitchAng);
          const stagger = i % 2 ? pitchAng / 2 : 0;
          const start = lo + (span - (count - 1) * pitchAng) / 2 + stagger;
          for (let jj = 0; jj < count; jj++) {
            const ang = start + jj * pitchAng;
            if (ang < lo - 1e-9 || ang > hi + 1e-9) continue;
            cells.push({ rc: rnd(rc), ang: rnd(ang, 3) });
          }
        }
      }
      if (cells.length <= 64) break;
      cr *= 1.28;
    }
    cells.forEach((cell, i) => {
      const pc = polar(cell.rc, cell.ang);
      shared.push({
        id: `hex${i + 1}`,
        shape: 'poly',
        pts: regularPoly(pc[0], pc[1], cr, 6, cell.ang),
        ...zThrough,
      });
    });
    infillInfo = { style: 'honeycomb', cellsPerSegment: cells.length, cellCircumradius: rnd(cr, 1) };
    if (!cells.length) {
      notes.push('Honeycomb cells did not fit; web left solid.');
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
  } else if (infill !== 'solid') {
    infillInfo = { style: 'solid' };
  }

  // Tread cutters.
  const treadInfo = { style: p.tread };
  if (p.tread === 'ribbed' || p.tread === 'diamond') {
    const g = clamp(Math.round(W / 14), 2, 6);
    const gw = 2.4;
    const edge = clamp(W * 0.12, 3, 10);
    for (let i = 0; i < g; i++) {
      const zc = g === 1 ? W / 2 : edge + (i * (W - 2 * edge)) / (g - 1);
      shared.push({
        id: `groove${i + 1}`,
        shape: 'annulus',
        rIn: rnd(R - p.treadDepth * 0.85),
        rOut: rnd(R + 2),
        z0: rnd(zc - gw / 2),
        z1: rnd(zc + gw / 2),
      });
    }
    treadInfo.grooves = g;
  }
  if (p.tread === 'lugged' || p.tread === 'diamond') {
    let count = Math.max(N, Math.round((Math.PI * p.diameter) / 20));
    if (N > 1) count = Math.max(N, Math.round(count / N) * N);
    const pitchLen = (Math.PI * p.diameter) / count;
    const slotW = clamp(pitchLen * 0.32, 2.5, 8);
    const perSeg = N === 1 ? count : count / N;
    for (let j = 0; j < perSeg; j++) {
      const ang = ((j + 0.5) * 360) / count;
      const u = [Math.cos(d2r(ang)), Math.sin(d2r(ang))];
      const t = [-Math.sin(d2r(ang)), Math.cos(d2r(ang))];
      const r0 = R - p.treadDepth;
      const r1 = R + 2;
      const hwS = slotW / 2;
      shared.push({
        id: `lug${j + 1}`,
        shape: 'poly',
        pts: [
          [r0 * u[0] - hwS * t[0], r0 * u[1] - hwS * t[1]],
          [r1 * u[0] - hwS * t[0], r1 * u[1] - hwS * t[1]],
          [r1 * u[0] + hwS * t[0], r1 * u[1] + hwS * t[1]],
          [r0 * u[0] + hwS * t[0], r0 * u[1] + hwS * t[1]],
        ],
        ...zThrough,
      });
    }
    treadInfo.lugsTotal = count;
    treadInfo.lugsPerSegment = perSeg;
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
    const rot = 90 - A / 2;
    const pts = [];
    for (const s of outline.segs) {
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
        ? 'TPU 95A, slow (~25 mm/s), no part cooling for first layers. The modeled flex-web does the springing — slicer infill just fills walls.'
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
