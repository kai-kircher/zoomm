import test from 'node:test';
import assert from 'node:assert/strict';
import { planWheel, normalizeParams, IN } from '../src/lib/wheel.js';
import { generateKcl } from '../src/lib/kclgen.js';

test('unit conversion: inches convert to mm', () => {
  const { p } = normalizeParams({ units: 'in', diameter: 14, width: 2 });
  assert.ok(Math.abs(p.diameter - 14 * IN) < 1e-9);
  assert.ok(Math.abs(p.width - 2 * IN) < 1e-9);
  assert.equal(p.units, 'mm');
});

test('small wheel prints in one piece', () => {
  const plan = planWheel({ diameter: 120, width: 30, bore: { type: 'plain', diameter: 8 } });
  assert.equal(plan.N, 1);
  assert.equal(plan.joints.length, 0);
  // Default tread is lugged, so the rim is a ring with the bars notched into
  // it; a slick one-piece wheel is a plain circle.
  assert.equal(plan.outline.kind, 'ring');
  assert.equal(planWheel({ diameter: 120, width: 30, tread: 'slick', bore: { type: 'plain', diameter: 8 } }).outline.kind, 'circle');
  assert.equal(plan.uniquePieces.length, 1);
  assert.ok(plan.fit.pieceFits);
});

test('14in wheel on 220mm printer splits into segments that fit', () => {
  const plan = planWheel({});
  assert.ok(plan.N >= 2, 'must be segmented');
  assert.ok(plan.fit.pieceFits, 'segments must fit the printer');
  assert.ok(plan.bbox.w <= plan.fit.usable.x || plan.bbox.w <= plan.fit.usable.y);
  assert.ok(plan.joints.length >= 1, 'segmented wheels need dovetails');
});

test('keyed hub dedupes to two unique pieces', () => {
  const plan = planWheel({});
  assert.ok(plan.N > 2);
  assert.equal(plan.uniquePieces.length, 2);
  const counts = plan.uniquePieces.map((u) => u.count).sort((a, b) => a - b);
  assert.equal(counts[0], 1); // exactly one piece carries the keyway
  assert.equal(counts.reduce((a, b) => a + b, 0), plan.N);
});

test('plain hub gives identical pieces', () => {
  const plan = planWheel({ diameter: 400, bore: { type: 'plain', diameter: 20 } });
  assert.ok(plan.N > 1);
  assert.equal(plan.uniquePieces.length, 1);
});

test('sector outline is a closed continuous loop', () => {
  const plan = planWheel({});
  const segs = plan.outline.segs;
  for (let i = 0; i < segs.length; i++) {
    const cur = segs[i];
    const nxt = segs[(i + 1) % segs.length];
    const dx = cur.b[0] - nxt.a[0];
    const dy = cur.b[1] - nxt.a[1];
    assert.ok(Math.hypot(dx, dy) < 1e-6, `segment ${i} does not connect to ${i + 1}`);
  }
  // inner arc + 2 face lines + 4 lines per dovetail per face, then the outer
  // boundary: one arc per gap between tread bars plus 4 entities per bar
  // window (arc in, wall down, floor arc, wall up).
  const bars = plan.treadInfo.barsPerSegment || 0;
  const expected = 3 + plan.joints.length * 8 + (4 * bars + 1);
  assert.equal(segs.length, expected);
});

test('tread bars are notched into the profile, never subtracted', () => {
  for (const tread of ['lugged', 'chevron', 'angled', 'diamond']) {
    const plan = planWheel({ tread });
    const ids = plan.uniquePieces.flatMap((u) => u.cutters.map((c) => c.id));
    assert.ok(!ids.some((id) => /^lug|^bar/.test(id)), `${tread}: no bar cutters`);
    assert.ok(plan.treadInfo.bars > 0, `${tread}: bars counted`);
    // Every section must dip to the bar floor and rise to the crown.
    for (const sec of plan.sections) {
      const radii = sec.segs.filter((s) => s.kind === 'arc' && s.center[0] === 0 && s.center[1] === 0).map((s) => s.radius);
      const rMax = Math.max(...radii);
      assert.ok(radii.some((r) => Math.abs(r - (rMax - plan.params.treadDepth)) < 1e-6), `${tread}: bar floor present`);
    }
  }
});

test('crowned and round profiles fall away to the shoulders', () => {
  const flat = planWheel({ tread: 'slick' });
  assert.equal(flat.sections.length, 1);
  assert.equal(flat.profile.crownDrop, 0);

  const crowned = planWheel({ tread: 'slick', profile: { shape: 'crowned', crownDrop: 6 } });
  assert.ok(crowned.sections.length > 1, 'a crown needs several sections to loft through');
  assert.equal(crowned.profile.crownDrop, 6);
  const rAt = (s) => (s.kind === 'circle' ? s.r : Math.max(...s.segs.filter((g) => g.kind === 'arc' && g.center[0] === 0).map((g) => g.radius)));
  const mid = crowned.sections.find((s) => Math.abs(s.z - crowned.W / 2) < 1e-6);
  assert.ok(Math.abs(rAt(mid) - crowned.radii.R) < 0.01, 'peak radius at mid-width');
  for (const s of [crowned.sections[0], crowned.sections[crowned.sections.length - 1]]) {
    assert.ok(Math.abs(rAt(s) - (crowned.radii.R - 6)) < 0.01, 'shoulders sit a full crown drop in');
  }

  // A round section is the crown taken to the half-width: a semicircle.
  const round = planWheel({ diameter: 200, width: 28, tread: 'slick', profile: { shape: 'round' } });
  assert.equal(round.profile.crownDrop, 14);
  assert.ok(Math.abs(round.profile.crownRadius - 14) < 0.05, 'section radius equals the half-width');
});

test('an auto bar count spaces bars out to grant the angle asked for', () => {
  for (const treadAngle of [15, 30, 45]) {
    const plan = planWheel({ tread: 'chevron', treadAngle });
    assert.equal(plan.treadInfo.barAngle, treadAngle, `${treadAngle}° delivered as asked`);
    assert.ok(!plan.notes.some((n) => /Tread angle reduced/.test(n)));
  }
});

test('a pinned bar count caps the slant instead, and sections stay congruent', () => {
  const plan = planWheel({ tread: 'chevron', treadAngle: 60, treadCount: 60 });
  assert.equal(plan.treadInfo.bars, 60, 'the pinned count wins');
  assert.ok(plan.treadInfo.barAngle < 60, 'the slant gives way instead');
  assert.ok(plan.notes.some((n) => /Tread angle reduced/.test(n)));
  for (const p of [plan, planWheel({ tread: 'angled', treadAngle: 40, profile: { shape: 'crowned' } })]) {
    const counts = new Set(p.sections.map((s) => s.segs.length));
    assert.equal(counts.size, 1, 'every section must have the same entity count for the loft');
  }
});

test('dovetail pockets are larger than tenons by the clearance', () => {
  const plan = planWheel({});
  const j = plan.joints[0];
  const segs = plan.outline.segs;
  // First pocket slant on face 0 runs from y=0 to y=d+clearance
  const pocketDepth = Math.max(...segs.filter((s) => s.kind === 'line').map((s) => Math.max(s.a[1], s.b[1])));
  // tenon depth appears beyond face A; just check the pocket depth value
  const somePocket = segs.find((s) => Math.abs(s.b[1] - (j.d + plan.jointClearance)) < 1e-6 && s.a[1] === 0);
  assert.ok(somePocket, 'pocket depth must include clearance');
});

test('through cutters span the full width with overshoot', () => {
  const plan = planWheel({});
  for (const u of plan.uniquePieces) {
    for (const c of u.cutters) {
      if (c.shape === 'annulus') {
        assert.ok(c.z0 >= 0 && c.z1 <= plan.W, 'grooves stay inside the width');
      } else {
        assert.ok(c.z0 < 0 && c.z1 > plan.W, `cutter ${c.id} must overshoot`);
      }
    }
  }
});

test('bolt count divisible by segments yields identical pieces', () => {
  const plan = planWheel({
    diameter: 300,
    segmentsOverride: 4,
    bore: { type: 'bolt', boltCount: 4, boltCircle: 60, boltHoleDia: 5.5, pilotDia: 12 },
  });
  assert.equal(plan.N, 4);
  assert.equal(plan.uniquePieces.length, 1);
  const bolts = plan.uniquePieces[0].cutters.filter((c) => c.id.startsWith('bolt'));
  assert.equal(bolts.length, 1); // one bolt hole per segment
});

test('bar pattern repeats per segment', () => {
  const plan = planWheel({ tread: 'lugged' });
  assert.equal(plan.treadInfo.bars % plan.N, 0);
  assert.equal(plan.treadInfo.bars / plan.N, plan.treadInfo.barsPerSegment);
});

test('oversized wheel on tiny printer warns', () => {
  const plan = planWheel({ diameter: 600, printer: { x: 150, y: 150, z: 150, margin: 10 } });
  assert.ok(plan.warnings.some((w) => /do not fit|exceeds/i.test(w)));
  assert.ok(!plan.fit.pieceFits);
});

test('tpu flexweb produces slots', () => {
  const plan = planWheel({ diameter: 260, width: 60, material: 'tpu', infill: 'flexweb', tread: 'slick', bore: { type: 'hex', hexAcrossFlats: 13 } });
  assert.equal(plan.infillInfo.style, 'flexweb');
  assert.ok(plan.infillInfo.slotsTotal >= plan.N);
});

test('honeycomb cell count is bounded', () => {
  const plan = planWheel({ diameter: 500, width: 60, infill: 'honeycomb', printer: { x: 300, y: 300, z: 300, margin: 10 } });
  if (plan.infillInfo.style === 'honeycomb') {
    assert.ok(plan.infillInfo.cellsPerSegment <= 64);
  }
});

test('honeycomb budget is a parameter, and cells grow to respect it', () => {
  const base = { diameter: 500, width: 60, infill: 'honeycomb', printer: { x: 300, y: 300, z: 300, margin: 10 } };
  const small = planWheel({ ...base, honeycomb: { maxCells: 12 } });
  const big = planWheel({ ...base, honeycomb: { maxCells: 200 } });
  assert.equal(small.infillInfo.style, 'honeycomb');
  assert.ok(small.infillInfo.cellsPerSegment <= 12, `${small.infillInfo.cellsPerSegment} cells within a 12-cell budget`);
  assert.ok(big.infillInfo.cellsPerSegment > small.infillInfo.cellsPerSegment, 'a bigger budget keeps more, smaller cells');
  assert.ok(big.infillInfo.cellAcrossFlats < small.infillInfo.cellAcrossFlats);
});

test('honeycomb cell size and wall are honoured, and an over-budget size is grown with a note', () => {
  const fits = planWheel({ diameter: 400, width: 60, infill: 'honeycomb', honeycomb: { cellSize: 24, wall: 4 }, printer: { x: 300, y: 300, z: 300, margin: 10 } });
  assert.equal(fits.infillInfo.cellAcrossFlats, 24);
  assert.equal(fits.infillInfo.wall, 4);
  const cells = fits.uniquePieces[0].cutters.filter((c) => c.id.startsWith('hex'));
  assert.ok(cells.length > 1);
  for (const c of cells) {
    // Across-flats of a regular hexagon = 2 × the vertex-to-center distance × cos30.
    const ctr = c.pts.reduce((s, q) => [s[0] + q[0] / 6, s[1] + q[1] / 6], [0, 0]);
    for (const q of c.pts) {
      const af = 2 * Math.hypot(q[0] - ctr[0], q[1] - ctr[1]) * Math.cos(Math.PI / 6);
      assert.ok(Math.abs(af - 24) < 0.02, `cell measures ${af.toFixed(2)} mm across flats`);
    }
  }
  // Congruent, identically oriented hexes: a centre spacing of across-flats +
  // wall is exactly a `wall` gap between the nearest pair.
  const ctrs = cells.map((c) => c.pts.reduce((s, q) => [s[0] + q[0] / 6, s[1] + q[1] / 6], [0, 0]));
  let closest = Infinity;
  for (let i = 0; i < ctrs.length; i++) {
    for (let j = i + 1; j < ctrs.length; j++) closest = Math.min(closest, Math.hypot(ctrs[i][0] - ctrs[j][0], ctrs[i][1] - ctrs[j][1]));
  }
  assert.ok(closest >= 24 + 4 - 0.01, `nearest cells ${closest.toFixed(2)} mm apart, need ${24 + 4}`);

  const grown = planWheel({ diameter: 400, width: 60, infill: 'honeycomb', honeycomb: { cellSize: 4, maxCells: 20 }, printer: { x: 300, y: 300, z: 300, margin: 10 } });
  assert.ok(grown.infillInfo.cellsPerSegment <= 20);
  assert.ok(grown.infillInfo.cellAcrossFlats > 4);
  assert.ok(grown.notes.some((n) => /cell size grown/i.test(n)), 'the size change is reported');
});

test('honeycomb cell size and wall follow the unit setting', () => {
  const inMm = { diameter: 400, width: 60, treadDepth: 3.5, infill: 'honeycomb', bore: { type: 'plain', diameter: 20 }, printer: { x: 300, y: 300, z: 300, margin: 10 } };
  const toIn = (v) => v / IN;
  const mm = planWheel({ ...inMm, honeycomb: { cellSize: 25.4, wall: 2.54 } });
  const inch = planWheel({
    units: 'in',
    diameter: toIn(inMm.diameter),
    width: toIn(inMm.width),
    treadDepth: toIn(inMm.treadDepth),
    infill: 'honeycomb',
    bore: { type: 'plain', diameter: toIn(20) },
    printer: { x: toIn(300), y: toIn(300), z: toIn(300), margin: toIn(10) },
    honeycomb: { cellSize: 1, wall: 0.1 },
  });
  assert.equal(inch.infillInfo.cellAcrossFlats, mm.infillInfo.cellAcrossFlats);
  assert.equal(inch.infillInfo.cellsPerSegment, mm.infillInfo.cellsPerSegment);
});

test('round cells are the hex inscribed circle; corner radius is capped there', () => {
  const base = { diameter: 400, width: 60, infill: 'honeycomb', printer: { x: 300, y: 300, z: 300, margin: 10 } };
  const hex = planWheel({ ...base, honeycomb: { cellSize: 20 } });
  const round = planWheel({ ...base, honeycomb: { cellSize: 20, cellShape: 'round' } });
  const capped = planWheel({ ...base, honeycomb: { cellSize: 20, cornerRadius: 999 } });

  // Same lattice, so the round option only changes the cell outline.
  assert.equal(round.infillInfo.cellsPerSegment, hex.infillInfo.cellsPerSegment);
  assert.equal(round.infillInfo.cellShape, 'round');
  assert.equal(capped.infillInfo.cellShape, 'round');
  assert.ok(capped.notes.some((n) => /corner radius capped/i.test(n)));

  const circles = round.uniquePieces[0].cutters.filter((c) => c.id.startsWith('hex'));
  assert.equal(circles.length, round.infillInfo.cellsPerSegment);
  for (const c of circles) {
    assert.equal(c.shape, 'circle');
    assert.ok(Math.abs(c.r - 10) < 0.01, `round cell Ø${(2 * c.r).toFixed(2)} = the 20 mm across-flats width`);
    const r = Math.hypot(c.c[0], c.c[1]);
    assert.ok(r - c.r >= round.radii.rWebIn - 0.01 && r + c.r <= round.radii.rWebOut + 0.01, 'round cell stays in the web band');
  }
});

test('rounded hex corners stay inside the sharp cell', () => {
  const plan = planWheel({ diameter: 400, width: 60, infill: 'honeycomb', honeycomb: { cellSize: 20, cornerRadius: 3 }, printer: { x: 300, y: 300, z: 300, margin: 10 } });
  assert.equal(plan.infillInfo.cellShape, 'rounded hex');
  assert.equal(plan.infillInfo.cornerRadius, 3);
  const cells = plan.uniquePieces[0].cutters.filter((c) => c.id.startsWith('hex'));
  assert.ok(cells.length > 1);
  const circumradius = 20 / Math.sqrt(3);
  for (const c of cells) {
    assert.equal(c.shape, 'path');
    assert.equal(c.segs.length, 12, 'six edges and six corner arcs');
    for (let i = 0; i < c.segs.length; i++) {
      const s = c.segs[i];
      const nxt = c.segs[(i + 1) % c.segs.length];
      assert.ok(Math.hypot(s.b[0] - nxt.a[0], s.b[1] - nxt.a[1]) < 1e-3, 'the cell loop is closed');
      if (s.kind === 'arc') {
        assert.equal(s.radius, 3);
        for (const q of [s.a, s.b]) {
          assert.ok(Math.abs(Math.hypot(q[0] - s.center[0], q[1] - s.center[1]) - 3) < 5e-3, 'arc endpoints sit on the fillet');
        }
      }
      // Every point of a filleted cell lies within the sharp hexagon it came from.
      for (const q of [s.a, s.b]) {
        const d = Math.hypot(q[0] - c.interior[0], q[1] - c.interior[1]);
        assert.ok(d <= circumradius + 1e-3, `point ${d.toFixed(2)} mm from centre exceeds the ${circumradius.toFixed(2)} mm cell`);
        const r = Math.hypot(q[0], q[1]);
        assert.ok(r >= plan.radii.rWebIn - 0.01 && r <= plan.radii.rWebOut + 0.01, 'rounded cell stays in the web band');
      }
    }
  }
});

// Convex-polygon separation (SAT): overlapping hex cells merged into open
// voids in the CAD and broke the preview triangulation.
function polysOverlap(p1, p2) {
  for (const pts of [p1, p2]) {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      const ax = [a[1] - b[1], b[0] - a[0]];
      const proj = (poly) => poly.map((p) => p[0] * ax[0] + p[1] * ax[1]);
      const q1 = proj(p1);
      const q2 = proj(p2);
      if (Math.max(...q1) < Math.min(...q2) || Math.max(...q2) < Math.min(...q1)) return false;
    }
  }
  return true;
}

test('honeycomb cells never overlap and stay inside the web band', () => {
  const cases = [
    { infill: 'honeycomb' },
    { diameter: 200, infill: 'honeycomb' },
    { diameter: 500, width: 60, infill: 'honeycomb', printer: { x: 300, y: 300, z: 300, margin: 10 } },
    { diameter: 300, infill: 'honeycomb', segmentsOverride: 2 },
    { diameter: 700, infill: 'honeycomb', segmentsOverride: 16 },
    { diameter: 400, infill: 'honeycomb', bore: { type: 'bolt', boltCount: 5, boltCircle: 80 } },
    // Every honeycomb knob rides the same lattice, so the guarantee must hold
    // for tuned cells too.
    { diameter: 400, infill: 'honeycomb', honeycomb: { orientation: 'tangential' } },
    { diameter: 300, infill: 'honeycomb', segmentsOverride: 2, honeycomb: { orientation: 'tangential' } },
    { diameter: 400, infill: 'honeycomb', honeycomb: { cellSize: 12, wall: 1.6 } },
    { diameter: 400, infill: 'honeycomb', honeycomb: { cellSize: 30, wall: 8, orientation: 'tangential' } },
    { diameter: 500, width: 60, infill: 'honeycomb', honeycomb: { cellSize: 6, maxCells: 120 }, printer: { x: 300, y: 300, z: 300, margin: 10 } },
  ];
  for (const input of cases) {
    const plan = planWheel(input);
    if (plan.infillInfo.style !== 'honeycomb') continue;
    const hexes = plan.uniquePieces[0].cutters.filter((c) => c.id.startsWith('hex'));
    assert.ok(hexes.length > 0);
    for (let i = 0; i < hexes.length; i++) {
      for (let j = i + 1; j < hexes.length; j++) {
        assert.ok(!polysOverlap(hexes[i].pts, hexes[j].pts), `cells ${hexes[i].id} and ${hexes[j].id} overlap (N=${plan.N})`);
      }
      for (const p of hexes[i].pts) {
        const r = Math.hypot(p[0], p[1]);
        assert.ok(r >= plan.radii.rWebIn - 1e-6 && r <= plan.radii.rWebOut + 1e-6, `${hexes[i].id} leaves the web band (r=${r.toFixed(2)})`);
        if (plan.N > 1) {
          const A = (plan.segAngle * Math.PI) / 180;
          assert.ok(p[1] >= -1e-6 && Math.sin(A) * p[0] - Math.cos(A) * p[1] >= -1e-6, `${hexes[i].id} crosses a seam plane`);
        }
      }
    }
  }
});

// --- chart-drawn webs: lattice, auxetic, voronoi ---------------------------
//
// All three are laid out in the unrolled web band and mapped back through
// Φ(θ, t) = polar(rWebIn + t·bandW, θ). Φ is injective on the strip, so cells
// that are disjoint in the chart stay disjoint on the wheel — but only the
// finished millimetre geometry proves the walls survive the mapping, the
// chording and the corner fillets. These tests measure the emitted loops.

const CELL_PREFIX = { lattice: 'lat', auxetic: 'aux', voronoi: 'vor' };
const cellsOf = (plan) => {
  const pre = CELL_PREFIX[plan.infillInfo.style];
  return pre ? plan.uniquePieces[0].cutters.filter((c) => c.id.startsWith(pre)) : [];
};
const loopOf = (cell) => cell.segs.map((s) => s.a);

// Minimum distance between two segments.
function segGap(p, q, a, b) {
  const toSeg = (u, v, w) => {
    const dx = w[0] - v[0];
    const dy = w[1] - v[1];
    const t = clamp01(((u[0] - v[0]) * dx + (u[1] - v[1]) * dy) / (dx * dx + dy * dy || 1));
    return Math.hypot(u[0] - v[0] - t * dx, u[1] - v[1] - t * dy);
  };
  return Math.min(toSeg(p, a, b), toSeg(q, a, b), toSeg(a, p, q), toSeg(b, p, q));
}
const clamp01 = (v) => Math.min(1, Math.max(0, v));

function segsCross(p, q, a, b) {
  const side = (u, v, w) => Math.sign((v[0] - u[0]) * (w[1] - u[1]) - (v[1] - u[1]) * (w[0] - u[0]));
  const [o1, o2, o3, o4] = [side(p, q, a), side(p, q, b), side(a, b, p), side(a, b, q)];
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

function pointInLoop(pt, loop) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if (a[1] > pt[1] !== b[1] > pt[1] && pt[0] < ((b[0] - a[0]) * (pt[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

const bbox = (loop) =>
  loop.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [
    Infinity,
    Infinity,
    -Infinity,
    -Infinity,
  ]);

// Every guarantee the chart webs make, measured on the emitted loops.
function assertWebIsSound(plan, wall, label) {
  const cells = cellsOf(plan);
  assert.ok(cells.length > 0, `${label}: web produced cells`);
  const A = (plan.segAngle * Math.PI) / 180;
  const { rWebIn, rWebOut } = plan.radii;

  for (const c of cells) {
    const loop = loopOf(c);
    assert.ok(loop.length >= 3, `${label}/${c.id}: loop is a real polygon`);
    assert.ok(pointInLoop(c.interior, loop), `${label}/${c.id}: region seed lies inside its loop`);
    for (const p of loop) {
      const r = Math.hypot(p[0], p[1]);
      assert.ok(r >= rWebIn - 0.02 && r <= rWebOut + 0.02, `${label}/${c.id}: stays in the web band (r=${r.toFixed(2)})`);
      if (plan.N > 1) {
        assert.ok(p[1] >= -0.02, `${label}/${c.id}: clears the θ=0 seam`);
        assert.ok(Math.sin(A) * p[0] - Math.cos(A) * p[1] >= -0.02, `${label}/${c.id}: clears the far seam`);
      }
    }
    // A self-intersecting loop is KCL the engine cannot region().
    for (let i = 0; i < loop.length; i++) {
      for (let j = i + 2; j < loop.length; j++) {
        if (i === 0 && j === loop.length - 1) continue;
        assert.ok(
          !segsCross(loop[i], loop[(i + 1) % loop.length], loop[j], loop[(j + 1) % loop.length]),
          `${label}/${c.id}: loop does not cross itself`
        );
      }
    }
  }

  const boxes = cells.map((c) => bbox(loopOf(c)));
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      const [ax0, ay0, ax1, ay1] = boxes[i];
      const [bx0, by0, bx1, by1] = boxes[j];
      if (ax0 - bx1 > wall || bx0 - ax1 > wall || ay0 - by1 > wall || by0 - ay1 > wall) continue;
      const P = loopOf(cells[i]);
      const Q = loopOf(cells[j]);
      assert.ok(!pointInLoop(P[0], Q) && !pointInLoop(Q[0], P), `${label}: ${cells[i].id} and ${cells[j].id} do not nest`);
      let gap = Infinity;
      for (let a = 0; a < P.length; a++) {
        for (let b = 0; b < Q.length; b++) {
          gap = Math.min(gap, segGap(P[a], P[(a + 1) % P.length], Q[b], Q[(b + 1) % Q.length]));
        }
      }
      assert.ok(gap >= wall - 0.02, `${label}: ${cells[i].id}/${cells[j].id} leave ${gap.toFixed(2)} mm, need ${wall}`);
    }
  }
  return cells;
}

const BIG_BED = { x: 300, y: 300, z: 300, margin: 10 };
const WEB_CASES = [
  ['lattice, defaults', 4, { infill: 'lattice' }],
  ['lattice, chevron truss', 4, { infill: 'lattice', lattice: { rows: 1 } }],
  ['lattice, six rows', 4, { infill: 'lattice', lattice: { rows: 6 } }],
  ['lattice, fat struts', 8, { infill: 'lattice', lattice: { strutWidth: 8 } }],
  ['lattice, sharp corners', 4, { infill: 'lattice', lattice: { cornerRadius: 0 } }],
  ['lattice, absurd fillet', 4, { diameter: 400, infill: 'lattice', lattice: { cornerRadius: 40 }, printer: BIG_BED }],
  ['lattice, dense struts', 4, { diameter: 400, infill: 'lattice', lattice: { struts: 24 }, printer: BIG_BED }],
  ['lattice, one piece', 4, { diameter: 160, width: 45, infill: 'lattice', tread: 'slick', bore: { type: 'bolt' } }],
  ['lattice, two segments', 4, { diameter: 300, infill: 'lattice', segmentsOverride: 2 }],
  ['lattice, sixteen segments', 4, { diameter: 700, infill: 'lattice', segmentsOverride: 16 }],
  ['auxetic, defaults', 3, { infill: 'auxetic' }],
  ['auxetic, one ring', 3, { infill: 'auxetic', auxetic: { rings: 1 } }],
  ['auxetic, six rings', 3, { infill: 'auxetic', auxetic: { rings: 6 } }],
  ['auxetic, deep waist', 3, { infill: 'auxetic', auxetic: { waist: 0.1 } }],
  ['auxetic, shallow waist', 3, { infill: 'auxetic', auxetic: { waist: 0.9 } }],
  ['auxetic, thick wall', 6, { infill: 'auxetic', auxetic: { wall: 6 } }],
  ['auxetic, sharp corners', 3, { infill: 'auxetic', auxetic: { cornerRadius: 0 } }],
  ['auxetic, absurd fillet', 3, { infill: 'auxetic', auxetic: { cornerRadius: 40 } }],
  ['auxetic, small cells', 3, { diameter: 400, infill: 'auxetic', auxetic: { cellSize: 10 }, printer: BIG_BED }],
  ['auxetic, one piece', 3, { diameter: 160, width: 45, infill: 'auxetic', tread: 'slick', bore: { type: 'bolt' } }],
  ['auxetic, sixteen segments', 3, { diameter: 700, infill: 'auxetic', segmentsOverride: 16 }],
  ['voronoi, defaults', 3, { infill: 'voronoi' }],
  ['voronoi, another seed', 3, { infill: 'voronoi', voronoi: { seed: 99 } }],
  ['voronoi, few cells', 3, { infill: 'voronoi', voronoi: { cells: 8 } }],
  ['voronoi, many cells', 3, { infill: 'voronoi', voronoi: { cells: 60 } }],
  ['voronoi, thick wall', 6, { infill: 'voronoi', voronoi: { wall: 6 } }],
  ['voronoi, sharp corners', 3, { infill: 'voronoi', voronoi: { cornerRadius: 0 } }],
  ['voronoi, absurd fillet', 3, { infill: 'voronoi', voronoi: { cornerRadius: 40 } }],
  ['voronoi, one piece', 3, { diameter: 160, width: 45, infill: 'voronoi', tread: 'slick', bore: { type: 'bolt' } }],
  ['voronoi, two segments', 3, { diameter: 300, infill: 'voronoi', segmentsOverride: 2 }],
  ['voronoi, sixteen segments', 3, { diameter: 700, infill: 'voronoi', segmentsOverride: 16 }],
];

for (const [label, wall, cfg] of WEB_CASES) {
  test(`chart web holds its wall and never overlaps: ${label}`, () => {
    const plan = planWheel(cfg);
    assert.ok(CELL_PREFIX[plan.infillInfo.style], `${label} produced a ${plan.infillInfo.style} web`);
    assertWebIsSound(plan, wall, label);
  });
}

test('lattice: one row is a chevron truss, more rows weave', () => {
  const base = { diameter: 300, width: 50, infill: 'lattice', tread: 'slick', segmentsOverride: 4 };
  const chevron = planWheel({ ...base, lattice: { rows: 1 } });
  const woven = planWheel({ ...base, lattice: { rows: 4 } });
  assert.equal(chevron.infillInfo.rows, 1);
  assert.equal(woven.infillInfo.rows, 4);
  assert.ok(woven.infillInfo.cellsPerSegment > chevron.infillInfo.cellsPerSegment, 'more rows cut more voids');
  // A chevron's voids are all half-diamonds cut off by the band, so every one
  // of them touches the hub ring or the rim ring. A woven lattice has whole
  // diamonds floating clear of both.
  const touches = (plan) => {
    // Cells stop half a strut short of each ring, so "on a ring" means within
    // that inset.
    const pad = plan.infillInfo.strutWidth / 2 + 0.5;
    return cellsOf(plan).map((c) => {
      const rs = loopOf(c).map((p) => Math.hypot(p[0], p[1]));
      return Math.min(...rs) < plan.radii.rWebIn + pad || Math.max(...rs) > plan.radii.rWebOut - pad;
    });
  };
  assert.ok(touches(chevron).every(Boolean), 'every chevron void lands on a ring');
  assert.ok(touches(woven).some((t) => !t), 'a woven lattice floats diamonds between the rings');
  // Struts lean further the more rows they cross.
  assert.ok(woven.infillInfo.lean > chevron.infillInfo.lean);
});

test('lattice struts are the requested thickness measured across the strut', () => {
  // Tangentially a leaning strut is wider than it is thick; the parameter is
  // the thickness, so a steeper lattice must eat more arc to deliver it.
  const shallow = planWheel({ diameter: 400, infill: 'lattice', lattice: { rows: 1, strutWidth: 5 }, printer: BIG_BED });
  const steep = planWheel({ diameter: 400, infill: 'lattice', lattice: { rows: 5, strutWidth: 5 }, printer: BIG_BED });
  assert.ok(steep.infillInfo.lean > shallow.infillInfo.lean);
  for (const plan of [shallow, steep]) assertWebIsSound(plan, 5, `lean ${plan.infillInfo.lean}`);
});

test('auxetic cells are re-entrant: the waist pinches inside the cell edges', () => {
  for (const waist of [0.25, 0.45, 0.7]) {
    const plan = planWheel({ diameter: 400, width: 60, infill: 'auxetic', tread: 'slick', auxetic: { rings: 3, cellSize: 16, cornerRadius: 0, waist }, printer: BIG_BED });
    assert.equal(plan.infillInfo.style, 'auxetic');
    assert.equal(plan.infillInfo.waist, waist);
    for (const c of cellsOf(plan)) {
      const mid = Math.atan2(c.interior[1], c.interior[0]);
      const rMid = Math.hypot(c.interior[0], c.interior[1]);
      let edge = 0; // widest half-angle, at the cell's inner and outer edges
      let neck = Infinity; // narrowest, at mid radius
      for (const p of loopOf(c)) {
        const off = Math.abs(Math.atan2(p[1], p[0]) - mid);
        edge = Math.max(edge, off);
        if (Math.abs(Math.hypot(p[0], p[1]) - rMid) < 0.05) neck = Math.min(neck, off);
      }
      assert.ok(neck < edge - 1e-6, 'the waist sits inside the cell edges — the cell is re-entrant');
      assert.ok(Math.abs(neck / edge - waist) < 0.02, `waist ratio ${(neck / edge).toFixed(3)} tracks the ${waist} asked for`);
    }
  }
});

test('voronoi is reproducible from its seed and genuinely reseeds', () => {
  const cfg = (seed) => ({ diameter: 400, width: 60, infill: 'voronoi', tread: 'slick', voronoi: { seed, cells: 18 }, printer: BIG_BED });
  const a = planWheel(cfg(4));
  const again = planWheel(cfg(4));
  const other = planWheel(cfg(5));
  const shape = (plan) => JSON.stringify(cellsOf(plan).map((c) => c.segs.map((s) => s.a)));
  assert.equal(shape(a), shape(again), 'the same seed replans to the exact same web');
  assert.notEqual(shape(a), shape(other), 'a different seed lays out a different web');
  assert.equal(a.infillInfo.seed, 4);
  // Organic, not a grid: cell areas should genuinely vary.
  const areas = cellsOf(a).map((c) => {
    const loop = loopOf(c);
    let s = 0;
    for (let i = 0; i < loop.length; i++) {
      const p = loop[i];
      const q = loop[(i + 1) % loop.length];
      s += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(s) / 2;
  });
  assert.ok(Math.max(...areas) > Math.min(...areas) * 1.3, 'cells are not all the same size');
});

test('every chart web repeats per segment, so pieces still dedupe', () => {
  for (const infill of ['lattice', 'auxetic', 'voronoi']) {
    // A plain bore has no hub features, so the web is the only thing that
    // could make two pieces differ.
    const plan = planWheel({ diameter: 400, width: 60, infill, tread: 'slick', bore: { type: 'plain', diameter: 20 } });
    assert.ok(plan.N > 1, `${infill} case must be segmented`);
    assert.equal(plan.uniquePieces.length, 1, `${infill}: every segment prints from one file`);
    assert.equal(plan.uniquePieces[0].count, plan.N);
  }
});

test('a web band too narrow for the pattern falls back to solid and says so', () => {
  for (const infill of ['lattice', 'auxetic', 'voronoi']) {
    // Big bolt circle + small wheel leaves almost nothing between hub and rim.
    const plan = planWheel({ diameter: 150, width: 30, infill, tread: 'slick', bore: { type: 'bolt', boltCount: 4, boltCircle: 100, boltHoleDia: 6, pilotDia: 20 } });
    assert.ok(plan.radii.rWebOut - plan.radii.rWebIn < 12, 'the repro really does squeeze the web band');
    assert.equal(plan.infillInfo.style, 'solid', `${infill} gives up rather than half-cutting the rings`);
    assert.ok(plan.notes.some((n) => /solid/i.test(n)), `${infill} explains itself in the build notes`);
  }
});

// --- bolt holes vs segment seams -------------------------------------------

// Reassemble the full wheel's bolt holes: every bolt cutter of every piece,
// rotated from the piece's canonical frame back into the wheel frame.
function assembledBoltHoles(plan) {
  const byLabel = new Map(plan.uniquePieces.map((u) => [u.label, u]));
  const holes = [];
  for (const piece of plan.pieces) {
    for (const c of byLabel.get(piece.label).cutters) {
      if (!c.id.startsWith('bolt')) continue;
      const ang = ((Math.atan2(c.c[1], c.c[0]) * 180) / Math.PI + piece.k * plan.segAngle + 720) % 360;
      holes.push({ ang, r: Math.hypot(c.c[0], c.c[1]), holeR: c.r });
    }
  }
  return holes.sort((a, z) => a.ang - z.ang);
}

// Millimetres from the closest hole edge to its nearest seam plane.
function minSeamClearance(plan, holes) {
  const A = plan.segAngle;
  let worst = Infinity;
  for (const h of holes) {
    const off = ((h.ang % A) + A) % A;
    const d = (Math.min(off, A - off) * Math.PI) / 180;
    worst = Math.min(worst, h.r * Math.sin(d) - h.holeR);
  }
  return worst;
}

test('default 4-bolt hub: solver keeps 8 segments and rotates the pattern off the seams', () => {
  const plan = planWheel({ bore: { type: 'bolt' } });
  assert.equal(plan.N, 8);
  assert.equal(plan.uniquePieces.length, 2);
  const holes = assembledBoltHoles(plan);
  assert.equal(holes.length, 4, 'assembled wheel has each bolt hole cut exactly once');
  for (let i = 0; i < holes.length; i++) {
    const gap = (holes[(i + 1) % holes.length].ang - holes[i].ang + 360) % 360;
    assert.ok(Math.abs(gap - 90) < 0.05, `holes stay a true 4-bolt pattern (gap ${gap.toFixed(2)}°)`);
    assert.ok(Math.abs(holes[i].r - plan.params.bore.boltCircle / 2) < 0.01, 'hole sits on the bolt circle');
  }
  assert.ok(minSeamClearance(plan, holes) >= 1, 'every hole edge clears every seam by ≥1 mm');
  assert.ok(!plan.warnings.some((w) => /seam/i.test(w)), 'no seam warning for the default wheel');
});

test('forcing N=8 with 4 bolts centres every hole mid-window instead of on the seams', () => {
  const plan = planWheel({
    diameter: 300,
    segmentsOverride: 8,
    bore: { type: 'bolt', boltCount: 4, boltCircle: 60, boltHoleDia: 5.5, pilotDia: 12 },
  });
  assert.equal(plan.N, 8);
  assert.equal(plan.uniquePieces.length, 2);
  const holes = assembledBoltHoles(plan);
  assert.equal(holes.length, 4);
  for (const h of holes) {
    const off = ((h.ang % 45) + 45) % 45;
    assert.ok(Math.abs(off - 22.5) < 0.05, `hole at ${h.ang.toFixed(2)}° sits mid-window`);
  }
  assert.ok(!plan.warnings.some((w) => /seam/i.test(w)));
});

test('solver walks past the minimum when only a larger count clears the seams', () => {
  const plan = planWheel({ bore: { type: 'bolt', boltCount: 11, boltCircle: 40, boltHoleDia: 5.5, pilotDia: 12 } });
  assert.equal(plan.N, 11);
  assert.equal(plan.uniquePieces.length, 1, '11 bolts on 11 segments print as one repeated piece');
  const holes = assembledBoltHoles(plan);
  assert.equal(holes.length, 11);
  assert.ok(minSeamClearance(plan, holes) >= 1);
  assert.ok(plan.notes.some((n) => /clear the segment seams/.test(n)));
  assert.ok(!plan.warnings.some((w) => /seam/i.test(w)));
});

test('an unavoidable seam crossing (coprime override) still warns', () => {
  const plan = planWheel({
    diameter: 300,
    segmentsOverride: 9,
    bore: { type: 'bolt', boltCount: 4, boltCircle: 60, boltHoleDia: 5.5, pilotDia: 12 },
  });
  assert.equal(plan.N, 9);
  assert.ok(plan.warnings.some((w) => /seam/i.test(w)), 'residual conflicts keep a loud warning');
});

test('sector wedges extend inside the bore so the cutter forms the true bore', () => {
  for (const cfg of [{}, { bore: { type: 'hex', hexAcrossFlats: 13 } }]) {
    const plan = planWheel({ diameter: 355.6, ...cfg });
    if (plan.N === 1) continue;
    const innerArc = plan.outline.segs[plan.outline.segs.length - 1];
    assert.equal(innerArc.kind, 'arc');
    assert.ok(innerArc.radius <= plan.radii.rInner + 1e-9, 'inner arc at rInner');
    assert.ok(plan.radii.rInner < plan.radii.boreMaxR, 'inner arc hides inside the bore envelope');
  }
});

test('segmented concentric bores live in the outline, not in a cutter', () => {
  // Bolt pilots and plain bores are circles concentric with the wheel, so
  // the sector outline carries the exact bore arc and no piece needs the
  // razor-thin tip-trim subtract that the Zoo engine rejects.
  for (const cfg of [
    { bore: { type: 'bolt' }, infill: 'solid', tread: 'slick' }, // the failing repro: N=8, pilot r 6.2
    { diameter: 300, bore: { type: 'bolt', boltCount: 4, boltCircle: 60, boltHoleDia: 5.5, pilotDia: 12 } },
    { diameter: 400, bore: { type: 'plain', diameter: 20 } },
  ]) {
    const plan = planWheel(cfg);
    assert.ok(plan.N > 1, 'config must be segmented');
    const innerArc = plan.outline.segs[plan.outline.segs.length - 1];
    assert.equal(innerArc.kind, 'arc');
    assert.ok(Math.abs(innerArc.radius - plan.radii.boreMaxR) < 1e-3, 'inner arc sits exactly on the bore radius');
    for (const u of plan.uniquePieces) {
      assert.ok(!u.cutters.some((c) => c.id === 'bore'), `piece ${u.label} has no bore cutter`);
    }
  }
});

// The loft can only raise a surface between sections that match one another
// entity for entity, and region() can only resolve loops that actually close.
// Both are easy to break from a long way away — a tread option, a crown, a web
// pattern, a hub that moves a seam — so sweep the combinations rather than
// trusting any single one.
test('every tread × profile × web × hub combination yields closed, congruent sections', () => {
  const problems = [];
  let count = 0;
  for (const tread of ['slick', 'ribbed', 'lugged', 'diamond', 'chevron', 'angled']) {
    for (const shape of ['flat', 'crowned', 'round']) {
      for (const infill of ['solid', 'spokes', 'honeycomb', 'lattice', 'auxetic', 'voronoi']) {
        for (const bore of ['keyed', 'hex', 'dbore', 'bolt']) {
          for (const diameter of [120, 355.6]) {
            const where = `${tread}/${shape}/${infill}/${bore}/Ø${diameter}`;
            const plan = planWheel({ diameter, tread, infill, profile: { shape }, bore: { type: bore } });
            count++;
            const shapes = new Set(plan.sections.map((s) => (s.kind === 'circle' ? 'circle' : s.segs.length)));
            if (shapes.size !== 1) problems.push(`${where}: sections differ (${[...shapes]})`);
            for (const sec of plan.sections) {
              if (sec.kind === 'circle') continue;
              for (let i = 0; i < sec.segs.length; i++) {
                const cur = sec.segs[i];
                const nxt = sec.segs[(i + 1) % sec.segs.length];
                if (Math.hypot(cur.b[0] - nxt.a[0], cur.b[1] - nxt.a[1]) > 1e-6) problems.push(`${where}: open at segment ${i}`);
                if (Math.hypot(cur.a[0] - cur.b[0], cur.a[1] - cur.b[1]) < 1e-6) problems.push(`${where}: zero-length segment ${i}`);
              }
            }
            generateKcl(plan); // must not throw for any of them
          }
        }
      }
    }
  }
  assert.ok(count > 500, `swept ${count} configurations`);
  assert.deepEqual(problems.slice(0, 5), [], `${problems.length} bad configurations`);
});
