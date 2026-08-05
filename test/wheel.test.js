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
