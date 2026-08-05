// The preview must show the same solid the KCL engine produces. The planner
// overshoots each segment wedge past the bore and lets the bore cutters trim
// the tip (see wheel.js); the preview folds that trim into the piece profile.
// These tests pin the regression where the bore was fed to ExtrudeGeometry as
// a crossing hole, growing a phantom thin-walled cylinder at every piece tip.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { planWheel } from '../src/lib/wheel.js';
import { tracePieceProfile, classifyCutters, shapeEmitter, buildPieceShape } from '../public/preview.js';

// Records the traced profile as a point list (arcs sampled).
function samplingEmitter() {
  const pts = [];
  return {
    pts,
    move: (x, y) => pts.push([x, y]),
    line: (x, y) => pts.push([x, y]),
    arc: (cx, cy, r, a0, a1) => {
      for (let i = 1; i <= 64; i++) {
        const a = a0 + ((a1 - a0) * i) / 64;
        pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    },
  };
}

const degOf = ([x, y]) => {
  let th = (Math.atan2(y, x) * 180) / Math.PI;
  if (th < -90) th += 360; // keep the N=2 face at +180°, not −180°
  return th;
};

// Assert no profile geometry near the hub strays outside the piece's wedge
// (the phantom-cylinder signature) and that the inner boundary sits on the
// bore, not on the planner's overshot wedge tip.
function assertTrueProfile(plan, u) {
  const em = samplingEmitter();
  const consumed = tracePieceProfile(plan, u, em);
  assert.ok(consumed, 'segmented piece folds the bore into its outline');
  let minR = Infinity;
  for (const p of em.pts) {
    const r = Math.hypot(p[0], p[1]);
    minR = Math.min(minR, r);
    if (r < plan.radii.boreMaxR + 0.5) {
      const th = degOf(p);
      assert.ok(th > -1 && th < plan.segAngle + 1, `hub point stays in wedge (r=${r.toFixed(2)} θ=${th.toFixed(1)}°)`);
    }
  }
  assert.ok(
    minR > plan.radii.rInner + 0.1,
    `inner boundary sits on the bore, not the wedge tip (minR=${minR.toFixed(2)}, rInner=${plan.radii.rInner})`
  );
  return { minR, pts: em.pts };
}

// The definitive check: the actual triangulated mesh the 3D preview renders
// has no vertices near the hub outside the wedge (no phantom bore cylinder).
function assertMeshHasNoPhantom(plan, u) {
  const geo = new THREE.ExtrudeGeometry(buildPieceShape(THREE, plan, u), {
    depth: plan.W,
    bevelEnabled: false,
    curveSegments: 48,
  });
  const pos = geo.getAttribute('position');
  for (let i = 0; i < pos.count; i++) {
    const p = [pos.getX(i), pos.getY(i)];
    if (Math.hypot(p[0], p[1]) < plan.radii.boreMaxR + 0.5) {
      const th = degOf(p);
      assert.ok(th > -1 && th < plan.segAngle + 1, `mesh vertex stays in wedge (θ=${th.toFixed(1)}°)`);
    }
  }
}

test('keyed default: profile hugs the bore and shows the keyway notch', () => {
  const plan = planWheel({});
  assert.ok(plan.N > 1);
  for (const u of plan.uniquePieces) {
    const { minR, pts } = assertTrueProfile(plan, u);
    assert.ok(Math.abs(minR - 10.2) < 0.05, `bore radius ${minR.toFixed(3)} ≈ 10.2`);
    const hasKeyway = u.cutters.some((c) => c.id === 'keyway');
    const notchPts = pts.filter((p) => {
      const r = Math.hypot(p[0], p[1]);
      return r > 12.5 && r < 13.6;
    });
    if (hasKeyway) assert.ok(notchPts.length > 0, 'keyway piece has notch points near r=13');
    else assert.equal(notchPts.length, 0, 'plain piece inner boundary stays on the bore circle');
    assertMeshHasNoPhantom(plan, u);
  }
});

test('hex bore: inner boundary spans hex flat to hex corner', () => {
  const plan = planWheel({ bore: { type: 'hex', hexAcrossFlats: 13 } });
  assert.ok(plan.N > 1);
  const inradius = 13 / 2 + 0.2;
  const circumradius = inradius / Math.cos(Math.PI / 6);
  for (const u of plan.uniquePieces) {
    const { minR, pts } = assertTrueProfile(plan, u);
    assert.ok(Math.abs(minR - inradius) < 0.05, `hex flat at ${minR.toFixed(3)} ≈ ${inradius.toFixed(3)}`);
    const maxHub = Math.max(...pts.map((p) => Math.hypot(p[0], p[1])).filter((r) => r < 10));
    assert.ok(Math.abs(maxHub - circumradius) < 0.05, `hex corner at ${maxHub.toFixed(3)} ≈ ${circumradius.toFixed(3)}`);
    assertMeshHasNoPhantom(plan, u);
  }
});

test('D-bore: pieces facing the flat bottom out at the flat offset', () => {
  const plan = planWheel({ bore: { type: 'dbore', diameter: 20 } });
  assert.ok(plan.N > 1);
  const rb = 10.2;
  const flatOffset = plan.params.bore.flatOffset;
  let sawFlat = false;
  for (const u of plan.uniquePieces) {
    const { minR } = assertTrueProfile(plan, u);
    if (u.cutters.some((c) => c.id === 'bore' && c.shape === 'path')) {
      assert.ok(minR < rb - 0.2, 'flat cuts inside the bore circle');
      assert.ok(minR > flatOffset - 0.05, 'flat never cuts inside the flat offset');
      if (minR < flatOffset + 0.05) sawFlat = true;
    } else {
      assert.ok(Math.abs(minR - rb) < 0.05, 'round piece stays on the bore circle');
    }
    assertMeshHasNoPhantom(plan, u);
  }
  assert.ok(sawFlat, 'some piece contains the deepest point of the flat');
});

test('bolt hub: pilot bore is carved into the outline, bolt holes stay holes', () => {
  const plan = planWheel({ bore: { type: 'bolt' } });
  assert.ok(plan.N > 1);
  let boltHoles = 0;
  for (const u of plan.uniquePieces) {
    const { minR } = assertTrueProfile(plan, u);
    assert.ok(Math.abs(minR - 6.2) < 0.05, `pilot radius ${minR.toFixed(3)} ≈ 6.2`);
    const { holes, boreFamily } = classifyCutters(u.cutters);
    boltHoles += holes.filter((c) => c.id.startsWith('bolt')).length;
    assert.equal(boreFamily.length, 0, 'segmented pilot bores live in the profile, not in a cutter');
    assertMeshHasNoPhantom(plan, u);
  }
  assert.ok(boltHoles > 0, 'bolt holes remain interior holes on the pieces that carry them');
});

test('keyway crossing a segment face is clipped to the face', () => {
  const plan = planWheel({ segmentsOverride: 12 });
  assert.equal(plan.N, 12);
  const keyed = plan.uniquePieces.filter((u) => u.cutters.some((c) => c.id === 'keyway'));
  assert.ok(keyed.length >= 2, 'the crossing keyway shows up on both neighbouring pieces');
  for (const u of plan.uniquePieces) {
    assertTrueProfile(plan, u);
    assertMeshHasNoPhantom(plan, u);
  }
});

test('one-piece wheel keeps the bore as a real interior hole', () => {
  const plan = planWheel({ diameter: 120, width: 30, bore: { type: 'plain', diameter: 8 } });
  assert.equal(plan.N, 1);
  const u = plan.uniquePieces[0];
  const em = samplingEmitter();
  const consumed = tracePieceProfile(plan, u, em);
  assert.equal(consumed, false, 'one-piece outline leaves the bore to the hole pass');
  const shape = buildPieceShape(THREE, plan, u);
  assert.ok(shape.holes.length >= 1, 'bore hole present');
  // The hole must be the full bore: mesh points on all sides of the origin.
  const geo = new THREE.ExtrudeGeometry(shape, { depth: plan.W, bevelEnabled: false, curveSegments: 48 });
  const pos = geo.getAttribute('position');
  const quads = new Set();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    if (Math.hypot(x, y) < 4.5) quads.add((y >= 0 ? 2 : 0) + (x >= 0 ? 1 : 0));
  }
  assert.equal(quads.size, 4, 'bore hole wall surrounds the origin');
});
