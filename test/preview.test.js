// The preview must show the same solid the KCL engine produces. The planner
// overshoots each segment wedge past the bore and lets the bore cutters trim
// the tip (see wheel.js); the preview folds that trim into the piece profile.
// Concentric bolt/plain bores are the exception: their bore arc is already
// the outline's inner boundary and there is no bore cutter to fold.
// These tests pin the regression where the bore was fed to ExtrudeGeometry as
// a crossing hole, growing a phantom thin-walled cylinder at every piece tip.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { planWheel } from '../src/lib/wheel.js';
import { tracePieceProfile, classifyCutters, shapeEmitter, buildPieceShape, buildLoftGeometry } from '../public/preview.js';

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
  // With a bore family the fold must lift the overshot wedge tip onto the
  // bore; without one (concentric bolt/plain bores) the outline already is
  // the true profile and bottoms out exactly at rInner = bore radius.
  const { boreFamily } = classifyCutters(u.cutters);
  const floor = boreFamily.length ? plan.radii.rInner + 0.1 : plan.radii.rInner - 1e-6;
  assert.ok(
    minR > floor,
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

test('bolt hub: outline carries the pilot bore, bolt holes stay holes', () => {
  const plan = planWheel({ bore: { type: 'bolt' } });
  assert.ok(plan.N > 1);
  let boltHoles = 0;
  for (const u of plan.uniquePieces) {
    const { minR } = assertTrueProfile(plan, u);
    assert.ok(Math.abs(minR - 6.2) < 0.05, `pilot radius ${minR.toFixed(3)} ≈ 6.2`);
    const { holes, boreFamily } = classifyCutters(u.cutters);
    boltHoles += holes.filter((c) => c.id.startsWith('bolt')).length;
    assert.equal(boreFamily.length, 0, 'the pilot circle lives in the outline, not in a cutter');
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

const WEB_VARIANTS = [
  ['honeycomb, default cells', { infill: 'honeycomb' }],
  ['honeycomb, tuned hex cells', { infill: 'honeycomb', honeycomb: { cellSize: 16, wall: 4 } }],
  ['honeycomb, round cells', { infill: 'honeycomb', honeycomb: { cellSize: 16, cellShape: 'round' } }],
  ['honeycomb, filleted cells', { infill: 'honeycomb', honeycomb: { cellSize: 16, cornerRadius: 2.5 } }],
  ['honeycomb, tangential lattice', { infill: 'honeycomb', honeycomb: { cellSize: 16, orientation: 'tangential' } }],
  ['lattice, woven', { infill: 'lattice' }],
  ['lattice, chevron', { infill: 'lattice', lattice: { rows: 1 } }],
  ['lattice, sharp corners', { infill: 'lattice', lattice: { rows: 4, cornerRadius: 0 } }],
  ['auxetic, default rings', { infill: 'auxetic' }],
  ['auxetic, deep waist', { infill: 'auxetic', auxetic: { rings: 4, waist: 0.2 } }],
  ['voronoi, default seed', { infill: 'voronoi' }],
  ['voronoi, dense', { infill: 'voronoi', voronoi: { cells: 40, seed: 12 } }],
];

for (const [variant, cfg] of WEB_VARIANTS) {
  test(`web piece triangulates cleanly, holes disjoint: ${variant}`, () => {
    // Overlapping cells fed to the triangulator as holes used to shred the
    // flat faces into slivers. A clean triangulation's flat-face area equals
    // the profile area minus the hole areas; a shredded one misses badly.
    // Every web style and cell shape must pass.
    const plan = planWheel(cfg);
    assert.equal(plan.infillInfo.style, cfg.infill, `${variant} produced its web`);
    for (const u of plan.uniquePieces) {
      const shape = buildPieceShape(THREE, plan, u);
      const outlinePts = shape.getPoints(96);
      const expected =
        Math.abs(THREE.ShapeUtils.area(outlinePts.map(({ x, y }) => ({ x, y })))) -
        shape.holes.reduce((s, h) => s + Math.abs(THREE.ShapeUtils.area(h.getPoints(96))), 0);
      const geo = new THREE.ExtrudeGeometry(shape, { depth: plan.W, bevelEnabled: false, curveSegments: 48 });
      const pos = geo.getAttribute('position');
      const idx = geo.getIndex();
      let flatArea = 0;
      const tri = (i) => [pos.getX(i), pos.getY(i), pos.getZ(i)];
      const count = idx ? idx.count : pos.count;
      const at = (n) => (idx ? idx.getX(n) : n);
      for (let i = 0; i + 2 < count; i += 3) {
        const [a, b, c] = [tri(at(i)), tri(at(i + 1)), tri(at(i + 2))];
        if (Math.abs(a[2]) > 1e-6 || Math.abs(b[2]) > 1e-6 || Math.abs(c[2]) > 1e-6) continue; // bottom face only
        flatArea += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
      }
      assert.ok(
        Math.abs(flatArea - expected) / expected < 0.02,
        `flat face area ${flatArea.toFixed(0)} ≈ profile minus holes ${expected.toFixed(0)}`
      );
    }
  });
}

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

// The CAD lofts a crowned piece through its sections; the preview has to do
// the same or it would advertise a bicycle tire and draw a cylinder.
test('a crowned piece previews as a crowned mesh, not a cylinder', () => {
  const plan = planWheel({ diameter: 200, width: 28, tread: 'slick', infill: 'solid', profile: { shape: 'round' }, bore: { type: 'plain', diameter: 12 } });
  assert.ok(plan.sections.length > 2, 'round profile lofts through several sections');
  const geo = buildLoftGeometry(THREE, plan, plan.uniquePieces[0]);
  assert.ok(geo, 'loft geometry built');
  const pos = geo.getAttribute('position');
  // Widest radius seen in a thin z slab, at mid-width and at the shoulder.
  const rMaxNear = (z0, z1) => {
    let m = 0;
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      if (z >= z0 && z <= z1) m = Math.max(m, Math.hypot(pos.getX(i), pos.getY(i)));
    }
    return m;
  };
  const R = plan.radii.R;
  assert.ok(Math.abs(rMaxNear(plan.W / 2 - 0.01, plan.W / 2 + 0.01) - R) < 0.5, 'full radius at mid-width');
  assert.ok(Math.abs(rMaxNear(-0.01, 0.01) - plan.profile.shoulderR) < 0.5, 'shoulder pulled in by the crown drop');
  assert.ok(geo.getIndex().count > 0 && Number.isFinite(pos.array[0]));
});

// A stitched mesh is easy to get subtly wrong — a dropped quad, a cap wound
// the wrong way, a triangulation borrowed from the wrong end. Every interior
// edge belonging to exactly two faces catches all three.
test('lofted preview meshes are watertight and face outwards', () => {
  const CASES = [
    ['round, one piece', { diameter: 200, width: 28, tread: 'slick', infill: 'solid', profile: { shape: 'round' }, bore: { type: 'plain', diameter: 12 } }],
    ['crowned + bars', { tread: 'lugged', profile: { shape: 'crowned', crownDrop: 5 } }],
    ['angled bars, flat', { tread: 'angled', treadAngle: 30 }],
    ['chevron on a round section', { tread: 'chevron', treadAngle: 30, profile: { shape: 'round' } }],
  ];
  for (const [name, cfg] of CASES) {
    const plan = planWheel(cfg);
    const geo = buildLoftGeometry(THREE, plan, plan.uniquePieces[0]);
    assert.ok(geo, `${name}: geometry built`);
    const idx = geo.getIndex().array;
    const edges = new Map();
    for (let i = 0; i < idx.length; i += 3) {
      const t = [idx[i], idx[i + 1], idx[i + 2]];
      assert.equal(new Set(t).size, 3, `${name}: no degenerate triangles`);
      for (let k = 0; k < 3; k++) {
        const a = t[k];
        const b = t[(k + 1) % 3];
        const key = a < b ? `${a}_${b}` : `${b}_${a}`;
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    }
    assert.equal([...edges.values()].filter((v) => v !== 2).length, 0, `${name}: every edge shared by two faces`);
    // Normals on the tread band must point away from the axis.
    geo.computeVertexNormals();
    const pos = geo.getAttribute('position');
    const nrm = geo.getAttribute('normal');
    let outward = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const r = Math.hypot(x, y);
      if (r < plan.radii.R - 1) continue;
      const dot = (x * nrm.getX(i) + y * nrm.getY(i)) / r;
      assert.ok(dot > -0.3, `${name}: tread normal not inverted`);
      if (dot > 0.3) outward++;
    }
    assert.ok(outward > 0, `${name}: tread surface found and facing out`);
  }
});

test('a flat piece needs no loft and every section stays congruent', () => {
  const flat = planWheel({ tread: 'lugged' });
  assert.equal(flat.sections.length, 1);
  // Bars slanting across the width still loft, and must sample to equal rings.
  const angled = planWheel({ tread: 'angled', treadAngle: 30 });
  assert.ok(angled.sections.length > 1);
  assert.ok(buildLoftGeometry(THREE, angled, angled.uniquePieces[0]), 'angled bars loft cleanly');
});

// An inverted void is invisible to the checks above: flipping a hole's wall
// quads leaves every edge shared by two faces, and the tread band those walls
// never touch still faces out. What it changes is which side of the wall is
// material, so the mesh encloses the web pockets instead of hollowing them and
// the piece renders see-through. Enclosed volume is the check with teeth.
function signedVolume(geo) {
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex() ? geo.getIndex().array : [...Array(pos.count).keys()];
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const p = (j) => [pos.getX(idx[i + j]), pos.getY(idx[i + j]), pos.getZ(idx[i + j])];
    const [a, b, c] = [p(0), p(1), p(2)];
    v += (a[0] * (b[1] * c[2] - c[1] * b[2]) - a[1] * (b[0] * c[2] - c[0] * b[2]) + a[2] * (b[0] * c[1] - c[0] * b[1])) / 6;
  }
  return v;
}

const extrudedVolume = (plan, u) =>
  signedVolume(new THREE.ExtrudeGeometry(buildPieceShape(THREE, plan, u), { depth: plan.W, bevelEnabled: false, curveSegments: 48 }));

// Two ways into the loft, each with a plain extrusion of the same solid to
// measure against: a crown of 0.05 mm is the flat wheel geometrically but
// lofts, and slanting the bars only rotates each section about the axis, which
// leaves the swept volume alone.
test('every lofted piece encloses the solid its extrusion does — voids stay voids', () => {
  const CASES = [
    ['crowned', (base) => [{ ...base, profile: { shape: 'flat' } }, { ...base, profile: { shape: 'crowned', crownDrop: 0.05 } }]],
    ['angled', (base) => [{ ...base, tread: 'angled', treadCount: 48, treadAngle: 0 }, { ...base, tread: 'angled', treadCount: 48, treadAngle: 30 }]],
    ['chevron', (base) => [{ ...base, tread: 'chevron', treadCount: 48, treadAngle: 0 }, { ...base, tread: 'chevron', treadCount: 48, treadAngle: 30 }]],
  ];
  for (const infill of ['solid', 'spokes', 'honeycomb', 'flexweb', 'lattice', 'auxetic', 'voronoi']) {
    for (const type of ['keyed', 'plain', 'hex', 'dbore', 'bolt']) {
      for (const [via, pair] of CASES) {
        const [flatCfg, loftCfg] = pair({ infill, bore: { type } });
        const flat = planWheel(flatCfg);
        const lofted = planWheel(loftCfg);
        const what = `${infill}/${type} via ${via}`;
        assert.equal(flat.sections.length, 1, `${what}: reference extrudes`);
        assert.ok(lofted.sections.length > 1, `${what}: subject lofts`);
        for (let k = 0; k < flat.uniquePieces.length; k++) {
          const geo = buildLoftGeometry(THREE, lofted, lofted.uniquePieces[k]);
          assert.ok(geo, `${what}: piece ${k} lofts`);
          const want = extrudedVolume(flat, flat.uniquePieces[k]);
          const got = signedVolume(geo);
          assert.ok(want > 0, `${what}: piece ${k} extrudes to a positive volume`);
          assert.ok(
            Math.abs(got - want) / want < 0.02,
            `${what}: piece ${k} lofts to ${got.toFixed(0)} mm³, extrudes to ${want.toFixed(0)} mm³`
          );
        }
      }
    }
  }
});
