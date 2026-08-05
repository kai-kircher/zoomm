import test from 'node:test';
import assert from 'node:assert/strict';
import { planWheel, normalizeParams, IN } from '../src/lib/wheel.js';

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
  assert.equal(plan.outline.kind, 'circle');
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
  // 2 arcs + 2 face lines + 4 lines per dovetail per face
  const expected = 4 + plan.joints.length * 8;
  assert.equal(segs.length, expected);
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

test('lug pattern repeats per segment', () => {
  const plan = planWheel({ tread: 'lugged' });
  assert.equal(plan.treadInfo.lugsTotal % plan.N, 0);
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
