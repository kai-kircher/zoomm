// The preview must show the same solid the kernel produces. The planner
// overshoots each segment wedge past the bore and lets the bore cutters trim
// the tip (see wheel.js); the preview folds that trim into the piece profile.
// Concentric bolt/plain bores are the exception: their bore arc is already
// the outline's inner boundary and there is no bore cutter to fold.
// These tests pin the regression where the bore was fed to ExtrudeGeometry as
// a crossing hole, growing a phantom thin-walled cylinder at every piece tip.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { planWheel, tireSurfaceAt, tireLevels } from '../src/lib/wheel.js';
import {
  tracePieceProfile,
  classifyCutters,
  shapeEmitter,
  buildPieceShape,
  buildLoftGeometry,
  buildPrismGeometry,
  offAxisAngle,
  groupByZone,
} from '../public/preview.js';

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

// ---------------------------------------------------------------------------
// Self-intersection
// ---------------------------------------------------------------------------
// A loop that crosses itself has no defined interior, so nothing downstream of
// it can be right: the triangulator tears the caps and reports a volume off by
// most of the piece, and OpenCascade answers a folded wire with a solid that
// fails its own validity check rather than with an error. The planner used to
// emit one. A dovetail was sized from the radial band it sits in and nothing
// measured it against the *width* of the wedge, so on a narrow sector the
// pocket cut into face 0 broke out through face A — hex bores folded from 14
// segments up, bolt bores from 11, and a Ø500 wheel folded on every bore type
// at the count the solver picks for it unprompted. `jointsFor` in wheel.js
// fits the dovetail to the wedge; this is the property that has to hold.

// Neighbours closer than the planner's 1e-3 coordinate grid are one point.
// Without this the slivers where two arcs join read as crossings.
const weldLoop = (pts) => {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 1e-3) continue;
    out.push(p);
  }
  const first = out[0];
  while (out.length > 2 && Math.hypot(first[0] - out[out.length - 1][0], first[1] - out[out.length - 1][1]) < 1e-3) out.pop();
  return out;
};

// Where a loop first crosses itself, or null. Edges are swept in order of
// their left end and compared only against the ones still open at that x: a
// 16-segment lugged wheel's profile runs to ten thousand points, and comparing
// every pair of those over the whole matrix below takes minutes.
function selfCrossing(loop) {
  const n = loop.length;
  if (n < 4) return null;
  const edges = [];
  for (let i = 0; i < n; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    edges.push({ i, a, b, lo: Math.min(a[0], b[0]), hi: Math.max(a[0], b[0]), len: Math.hypot(b[0] - a[0], b[1] - a[1]) });
  }
  // Proper crossing only: an endpoint two edges share is not one, and neither
  // is a touch, so both parameters have to land strictly inside.
  const meet = (e, f) => {
    const ex = e.b[0] - e.a[0];
    const ey = e.b[1] - e.a[1];
    const fx = f.b[0] - f.a[0];
    const fy = f.b[1] - f.a[1];
    const den = ex * fy - ey * fx;
    if (Math.abs(den) < 1e-14) return null; // parallel
    const wx = f.a[0] - e.a[0];
    const wy = f.a[1] - e.a[1];
    const t = (wx * fy - wy * fx) / den;
    const u = (wx * ey - wy * ex) / den;
    if (t <= 1e-9 || t >= 1 - 1e-9 || u <= 1e-9 || u >= 1 - 1e-9) return null;
    return [e.a[0] + t * ex, e.a[1] + t * ey];
  };
  const open = [];
  for (const e of [...edges].sort((x, y) => x.lo - y.lo)) {
    for (let k = open.length - 1; k >= 0; k--) {
      const f = open[k];
      if (f.hi < e.lo) {
        open.splice(k, 1); // closed for good: every later edge starts right of it
        continue;
      }
      const gap = Math.abs(e.i - f.i);
      if (gap <= 1 || gap === n - 1) continue; // adjacent edges share an endpoint
      const at = meet(e, f);
      if (at) return { at, edges: [e.i, f.i], lengths: [e.len, f.len] };
    }
    open.push(e);
  }
  return null;
}

const PROFILE_BORES = [
  ['plain', { type: 'plain', diameter: 20 }],
  ['keyed', {}],
  ['hex', { type: 'hex' }],
  ['dbore', { type: 'dbore' }],
  ['bolt', { type: 'bolt' }],
];

// Three wheels, because the profile is the outline plus every web cell as a
// hole and all of them have to come out simple.
const PROFILE_WHEELS = [
  // The wheel the fold was found on: a lugged tread notches the outer
  // boundary and a solid web leaves the sector faces as the only other detail.
  ['lugged solid', { infill: 'solid', tread: 'lugged', profile: { shape: 'flat' } }],
  // Big enough that the solver reaches 16 segments unprompted, with a crowned
  // section and a web whose cells add dozens of loops to the same profile.
  ['Ø500 honeycomb crowned', { diameter: 500, width: 60, infill: 'honeycomb', tread: 'ribbed', profile: { shape: 'crowned', crownDrop: 4 } }],
  // The spoke web, whose gap quads folded for a reason of their own and not
  // for the dovetails': the two lines bounding a gap are offset from
  // neighbouring *rays*, so they converge going inward and on a narrow wedge
  // met before the inner web circle. The guard took `mod(...)` of the gap's
  // angular span, which maps a negative one onto ~359°, so exactly the folded
  // gaps read as generously wide and were kept (wheel.js now measures that
  // span from the offsets, where it stays signed). Ø200 at 12 segments was
  // the shortest repro and is inside the sweep below.
  ['Ø200 spokes', { diameter: 200, infill: 'spokes', tread: 'lugged', profile: { shape: 'flat' } }],
];

test('no piece profile crosses itself, at any segment count', () => {
  let loops = 0;
  for (const [wheel, base] of PROFILE_WHEELS) {
    for (const [boreName, bore] of PROFILE_BORES) {
      for (let N = 1; N <= 16; N++) {
        const plan = planWheel({ ...base, bore: { ...bore }, segmentsOverride: N });
        for (const u of plan.uniquePieces) {
          const pts = buildPieceShape(THREE, plan, u).extractPoints(48);
          for (const [what, raw] of [['outline', pts.shape], ...pts.holes.map((h, i) => [`hole ${i}`, h])]) {
            const loop = weldLoop(raw.map((p) => [p.x, p.y]));
            const x = selfCrossing(loop);
            loops++;
            assert.equal(
              x,
              null,
              x &&
                `${wheel}, ${boreName} bore, N=${N}: piece ${u.label} ${what} folds at ` +
                  `(${x.at[0].toFixed(2)}, ${x.at[1].toFixed(2)}) — edges ${x.edges.join(' × ')}, ` +
                  `${x.lengths.map((l) => l.toFixed(2)).join(' mm and ')} mm long`
            );
          }
        }
      }
    }
  }
  assert.ok(loops > 500, `the matrix actually ran (${loops} loops checked)`);
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
  ['graded, default rings', { infill: 'graded' }],
  ['graded, uniform rings', { infill: 'graded', graded: { grade: 0 } }],
  ['graded, rect cells', { infill: 'graded', graded: { cellShape: 'rect', cornerRadius: 0 } }],
  ['graded, swirled diamonds', { infill: 'graded', graded: { cellShape: 'diamond', swirl: 30 } }],
  ['voronoi, default seed', { infill: 'voronoi' }],
  ['voronoi, dense', { infill: 'voronoi', voronoi: { cells: 40, seed: 12 } }],
];

// The segment count the solver picks, then a forced one at the top of the
// range. The high counts used to be left out of this matrix on purpose:
// they folded the piece profile (see `no piece profile crosses itself`
// above), and a folded profile has no triangulation to measure. Now that
// the planner fits its dovetails to the wedge, they belong here.
const WEB_SEGMENTS = [0, 12, 16];

for (const [variant, cfg] of WEB_VARIANTS) {
  test(`web piece triangulates cleanly, holes disjoint: ${variant}`, () => {
    // Overlapping cells fed to the triangulator as holes used to shred the
    // flat faces into slivers. A clean triangulation's flat-face area equals
    // the profile area minus the hole areas; a shredded one misses badly.
    // Every web style and cell shape must pass, at every segment count.
    for (const N of WEB_SEGMENTS) {
      const plan = planWheel(N ? { ...cfg, segmentsOverride: N } : cfg);
      const where = `${variant}, N=${plan.N}`;
      // A forced count can leave the pattern no room, and the planner then
      // falls back to a solid web and says so. That is its own behaviour and
      // is tested elsewhere; what must hold here either way is that whatever
      // the profile ends up being, it triangulates.
      if (plan.infillInfo.style !== cfg.infill) {
        assert.ok(N, `${where}: the count the solver picks must produce its web`);
        assert.ok(
          plan.notes.some((n) => /web left solid|solid web/.test(n)),
          `${where}: fell back to a ${plan.infillInfo.style} web without saying so`
        );
      }
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
          `${where}, piece ${u.label}: flat face area ${flatArea.toFixed(0)} ≈ profile minus holes ${expected.toFixed(0)}`
        );
      }
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

// The CAD cuts the crown as an exact solid of revolution. The preview has to
// draw the same curve or it would advertise a bicycle tire and render a
// cylinder — and, more subtly, it has to draw it *accurately*: the lofted
// crown this replaced sampled the section circle uniformly in height, which is
// its coarsest exactly where it curves hardest, and came out 2.99 mm short at
// the shoulder.
test('a crowned piece previews as a crowned mesh, not a cylinder', () => {
  const plan = planWheel({ diameter: 200, width: 28, tread: 'slick', infill: 'solid', profile: { shape: 'round' }, bore: { type: 'plain', diameter: 12 } });
  assert.equal(plan.sections.length, 1, 'the crown is cut, not lofted');
  const geo = buildLoftGeometry(THREE, plan, plan.uniquePieces[0]);
  assert.ok(geo, 'shaped geometry built');
  const pos = geo.getAttribute('position');
  const R = plan.radii.R;
  const surf = tireSurfaceAt(plan);

  // Widest radius seen in a thin z slab, at mid-width and at the shoulder.
  const rMaxNear = (z0, z1) => {
    let m = 0;
    for (let i = 0; i < pos.count; i++) {
      const z = pos.getZ(i);
      if (z >= z0 && z <= z1) m = Math.max(m, Math.hypot(pos.getX(i), pos.getY(i)));
    }
    return m;
  };
  assert.ok(Math.abs(rMaxNear(plan.W / 2 - 0.01, plan.W / 2 + 0.01) - R) < 0.5, 'full radius at mid-width');
  assert.ok(Math.abs(rMaxNear(-0.01, 0.01) - plan.profile.shoulderR) < 0.5, 'shoulder pulled in by the crown drop');

  // No vertex may stand outside the true section circle, anywhere across the
  // width. This is the check that would have caught the faceted loft: its
  // chords fell *inside* the arc, so it fails the companion check below.
  let out = 0;
  for (let i = 0; i < pos.count; i++) {
    out = Math.max(out, Math.hypot(pos.getX(i), pos.getY(i)) - surf(pos.getZ(i)));
  }
  // 1e-3 is the planner's coordinate grid; the mesh also arrives through a
  // Float32 buffer, whose spacing at a 100 mm radius is already ~7.6e-6 mm.
  assert.ok(out < 1e-3, `nothing bulges past the section circle (worst ${out.toExponential(2)} mm)`);

  // And the surface is actually reached, so the wheel is not merely smaller
  // than asked for. Checked at the heights the mesh has rings at — which are
  // spaced by equal arc angle, so they bunch towards the shoulders and a
  // fixed-width slab through the middle would simply find nothing.
  const levels = tireLevels(plan);
  assert.ok(levels.length > 8, 'the crown is sampled at more than a handful of heights');
  let reached = 0;
  for (const z of levels) {
    const r = rMaxNear(z - 1e-3, z + 1e-3);
    if (r === 0) continue; // Float32 z may miss the level exactly
    assert.ok(
      surf(z) - r < 1e-3,
      `the ring at z=${z.toFixed(2)} reaches the arc (short by ${(surf(z) - r).toFixed(4)} mm)`
    );
    reached++;
  }
  assert.ok(reached > levels.length * 0.8, `most rings located (${reached}/${levels.length})`);
  assert.ok(geo.getIndex().count > 0 && Number.isFinite(pos.array[0]));
});

// A stitched mesh is easy to get subtly wrong — a dropped quad, a cap wound
// the wrong way, a triangulation borrowed from the wrong end. Every interior
// edge belonging to exactly two faces catches all three.
//
// Edges are counted between *positions*, not vertex indices: the mesh splits a
// vertex once per surface meeting on it, so the shading can keep the piece's
// edges hard (see creasedNormals) and one physical corner is several indices.
// The split copies a position verbatim, so exact equality is the right weld —
// rounding here would instead merge the collapsed bar windows, which sit as
// close as 1e-6 mm apart and are deliberately kept distinct.
const weldByPosition = (pos) => {
  const seen = new Map();
  const of = new Uint32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)}`;
    if (!seen.has(k)) seen.set(k, seen.size);
    of[i] = seen.get(k);
  }
  return of;
};

// Every edge of a closed shell belongs to exactly two faces. Counting raw
// indices would let a real tear hide behind a coincident pair — the two halves
// of a split edge read as one edge with two faces — so the count is taken on
// welded vertices. The triangles that go degenerate under the weld are
// skipped: those are the zero-area fans the cap adds over a collapsed bar
// window, to give the side strips' repeated points a second face. Welded,
// their two copies of the surviving edge cancel, so they neither close nor
// open anything. Indexed or not, both preview paths answer to this count.
function openEdges(geo) {
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex() ? geo.getIndex().array : [...Array(pos.count).keys()];
  const weld = weldByPosition(pos);
  const edges = new Map();
  for (let i = 0; i < idx.length; i += 3) {
    const t = [weld[idx[i]], weld[idx[i + 1]], weld[idx[i + 2]]];
    if (new Set(t).size < 3) continue;
    for (let k = 0; k < 3; k++) {
      const a = t[k];
      const b = t[(k + 1) % 3];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edges.set(key, (edges.get(key) || 0) + 1);
    }
  }
  return [...edges.values()].filter((v) => v !== 2).length;
}

test('lofted preview meshes are watertight and face outwards', () => {
  const CASES = [
    ['round, one piece', { diameter: 200, width: 28, tread: 'slick', infill: 'solid', profile: { shape: 'round' }, bore: { type: 'plain', diameter: 12 } }],
    ['crowned + bars', { tread: 'lugged', profile: { shape: 'crowned', crownDrop: 5 } }],
    ['angled bars, flat', { tread: 'angled', treadAngle: 30 }],
    ['chevron on a round section', { tread: 'chevron', treadAngle: 30, profile: { shape: 'round' } }],
    // A lattice cell that overhangs a segment face is clamped to the joint
    // keep-out, and that keep-out is a fixed perpendicular offset from the
    // θ = 0 face — so the clamped edges land on the line y = const, and the
    // next cell out along the band bridges to the outline along exactly that
    // line. Earcut steps over horizontal edges while it hunts for something to
    // bridge to, so it used to tunnel through the neighbouring cell and hand
    // back a cap 39 triangles short: 86 of this mesh's edges bounded one face.
    ['lattice web, crowned', { tread: 'lugged', infill: 'lattice', profile: { shape: 'crowned', crownDrop: 0 } }],
    ['lattice web, angled bars on a round section', { tread: 'angled', treadAngle: 30, infill: 'lattice', profile: { shape: 'round' } }],
  ];
  for (const [name, cfg] of CASES) {
    const plan = planWheel(cfg);
    const geo = buildLoftGeometry(THREE, plan, plan.uniquePieces[0]);
    assert.ok(geo, `${name}: geometry built`);
    const pos = geo.getAttribute('position');
    const idx = geo.getIndex().array;
    for (let i = 0; i < idx.length; i += 3) {
      assert.equal(new Set([idx[i], idx[i + 1], idx[i + 2]]).size, 3, `${name}: no triangle repeats a vertex`);
    }
    assert.equal(openEdges(geo), 0, `${name}: every edge shared by two faces`);
    // Normals on the tread band must point away from the axis. These are the
    // normals the mesh ships with, not a recomputed set — they are the thing
    // the renderer actually shades by.
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

// The other half of the preview. A piece nothing shapes is a prism, and
// ExtrudeGeometry triangulates its own caps — so the frame fix reaches it only
// by turning the profile on the way in and turning the geometry back on the
// way out, and the slivers the planner's rounding leaves behind have to be
// welded off the profile before earcut ever sees them. Every one of the 96
// pieces below was torn before that, 3236 open edges between them: lattice for
// the horizontal-bridge reason the lofted test pins, and every style including
// solid for three slivers a cap. Take either half out and the other half's
// cases still fail, which is what says both are load-bearing.
//
// Only the segment counts the planner itself settles on are checked, plus the
// one- and two-piece ends of the range. Forcing a high count on a non-keyed
// bore (hex from 14 up, bolt from 11) folds the piece profile across itself,
// and no triangulator answers for a polygon that crosses itself — that is a
// planner defect, and it is torn on the raw extrusion too.
test('extruded preview meshes are watertight, every web style', () => {
  const WEBS = ['solid', 'spokes', 'honeycomb', 'flexweb', 'lattice', 'auxetic', 'graded', 'voronoi'];
  const CASES = [];
  for (const infill of WEBS) for (const type of ['keyed', 'plain', 'hex', 'dbore', 'bolt']) CASES.push([infill, type, undefined]);
  // One and two pieces trace a different outline kind altogether — a whole
  // circle, or a ring with the bars notched into it, rather than a wedge — so
  // every web gets both ends of the range too.
  for (const infill of WEBS) for (const N of [1, 2]) CASES.push([infill, 'plain', N]);

  const flatArea = (l) => Math.abs(THREE.ShapeUtils.area(l));
  for (const [infill, type, N] of CASES) {
    const plan = planWheel({ infill, bore: { type }, tread: 'lugged', profile: { shape: 'flat' }, ...(N ? { segmentsOverride: N } : {}) });
    assert.equal(plan.sections.length, 1, `${infill}/${type}: a plain prism, not a loft`);
    for (let k = 0; k < plan.uniquePieces.length; k++) {
      const u = plan.uniquePieces[k];
      const what = `${infill}/${type}/N${plan.N} piece ${k}`;
      assert.ok(!classifyCutters(u.cutters).tire, `${what}: nothing shapes it`);
      const geo = buildPrismGeometry(THREE, plan, u);
      assert.equal(openEdges(geo), 0, `${what}: every edge shared by two faces`);
      // And neither the weld nor the two rotations move the solid: the shell
      // encloses the profile's own area swept across the width.
      const { shape, holes } = buildPieceShape(THREE, plan, u).extractPoints(48);
      const want = (flatArea(shape) - holes.reduce((s, h) => s + flatArea(h), 0)) * plan.W;
      const got = signedVolume(geo);
      assert.ok(
        Math.abs(got - want) / want < 1e-4,
        `${what}: encloses ${got.toFixed(0)} mm³, profile sweeps ${want.toFixed(0)} mm³`
      );
    }
  }
});

// Both fixes rest on one property, worth pinning away from the meshes that
// depend on it: turned by offAxisAngle, nothing in the profile is flat, so
// earcut's hole bridging cannot step over an edge lying on its own ray.
// Checked on a lattice piece, whose seam-clamped cells are what put runs of
// edges on a single horizontal line to begin with.
test('the triangulation frame leaves no edge horizontal', () => {
  const plan = planWheel({ infill: 'lattice', tread: 'lugged', profile: { shape: 'flat' } });
  const { shape, holes } = buildPieceShape(THREE, plan, plan.uniquePieces[0]).extractPoints(48);
  const loops = [shape, ...holes];

  // The hazard is present: more than one cell carries edges on one horizontal.
  const sharing = new Map();
  holes.forEach((l, li) => {
    for (let i = 0; i < l.length; i++) {
      const q = l[(i + 1) % l.length];
      if (l[i].y !== q.y) continue;
      if (!sharing.has(q.y)) sharing.set(q.y, new Set());
      sharing.get(q.y).add(li);
    }
  });
  assert.ok(
    [...sharing.values()].some((cells) => cells.size > 1),
    'cells clamped to the seam do share a horizontal line'
  );

  const theta = offAxisAngle(loops);
  let closest = Infinity;
  for (const l of loops) {
    for (let i = 0; i < l.length; i++) {
      const p = l[i];
      const q = l[(i + 1) % l.length];
      const dx = q.x - p.x;
      const dy = q.y - p.y;
      if (dx === 0 && dy === 0) continue;
      const off = (((Math.atan2(dy, dx) + theta) % Math.PI) + Math.PI) % Math.PI;
      closest = Math.min(closest, off, Math.PI - off);
    }
  }
  assert.ok(closest > 1e-3, `no edge lands on the horizontal (closest ${closest.toExponential(2)} rad)`);
});

// The shaped mesh is indexed, so a rim vertex sits on the end cap and on the
// side wall at once and a void's corner sits on both walls meeting there.
// Averaging a vertex over all of them — which is all `computeVertexNormals`
// can do — rounds the shading off every hard edge the piece has: pockets read
// as funnels, and each cap picks up a fan of streaks off its own rim, because
// earcut's long thin triangles carry the tilted rim normals a long way inward.
// It showed up first on crowned wheels, only because a flat slick tread never
// takes this path at all.
//
// The two halves of the property pull against each other, so both are pinned:
// hard where the piece has an edge, smooth where it has a curve.
test('shaped meshes shade hard at edges and smooth along the crown', () => {
  const CASES = [
    ['crowned + bars', { tread: 'lugged', profile: { shape: 'crowned', crownDrop: 5 } }],
    ['flat + grooves', { tread: 'ribbed', infill: 'honeycomb' }],
    ['angled bars, flat', { tread: 'angled', treadAngle: 30 }],
    ['crowned slick', { tread: 'slick', profile: { shape: 'crowned', crownDrop: 5 } }],
    ['round section', { diameter: 200, width: 28, tread: 'slick', infill: 'solid', profile: { shape: 'round' }, bore: { type: 'plain', diameter: 12 } }],
  ];
  for (const [name, cfg] of CASES) {
    const plan = planWheel(cfg);
    const geo = buildLoftGeometry(THREE, plan, plan.uniquePieces[0]);
    const pos = geo.getAttribute('position');
    const nrm = geo.getAttribute('normal');
    const idx = geo.getIndex().array;

    // The far cap is exactly the +Z plane, so any tilt in a corner it shades
    // with is shading error and nothing else. Only triangles with real area
    // count: the bore fold and the collapsed windows leave slivers that draw
    // nothing, and their direction is noise by construction.
    let capCorners = 0;
    for (let i = 0; i < idx.length; i += 3) {
      const t = [idx[i], idx[i + 1], idx[i + 2]];
      if (!t.every((v) => Math.abs(pos.getZ(v) - plan.W) < 1e-9)) continue;
      const [a, b, c] = t.map((v) => [pos.getX(v), pos.getY(v)]);
      const area = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
      if (area < 1e-4) continue;
      for (const v of t) {
        capCorners++;
        // A round section meets its own side face tangentially, so there the
        // crown really does carry on into the cap and a couple of degrees of
        // tilt is the surface, not a smear.
        const tol = plan.profile.crownDrop >= plan.W / 2 - 1e-9 ? 3 : 0.01;
        const tilt = (Math.acos(Math.min(1, Math.max(-1, nrm.getZ(v)))) * 180) / Math.PI;
        assert.ok(tilt < tol, `${name}: cap corner shades +Z (off by ${tilt.toFixed(1)}°)`);
      }
    }
    assert.ok(capCorners > 100, `${name}: found the cap (${capCorners} corners)`);

    // The crown is a real arc and has to keep shading as one, against the exact
    // normal of that solid of revolution: n ∝ (cos θ, sin θ, −f′(z)).
    //
    // Only on a slick tread, where the running surface is one unbroken patch.
    // A window wall or a groove wall ends the patch, and a corner on that edge
    // averages over the faces on one side of it only — a real effect of
    // grouping, a couple of degrees wide, and not what this is pinning.
    if (!plan.profile.crownDrop || cfg.tread !== 'slick') continue;
    const surf = tireSurfaceAt(plan);
    const { crownRadius } = plan.profile;
    const halfW = plan.W / 2;
    // Away from the caps: the patch ends there too.
    const onCrown = (v) =>
      pos.getZ(v) > 0.5 &&
      pos.getZ(v) < plan.W - 0.5 &&
      Math.abs(Math.hypot(pos.getX(v), pos.getY(v)) - surf(pos.getZ(v))) < 1e-4;
    const errs = [];
    for (let i = 0; i < idx.length; i += 3) {
      const t = [idx[i], idx[i + 1], idx[i + 2]];
      if (!t.every(onCrown)) continue;
      for (const v of t) {
        const x = pos.getX(v);
        const y = pos.getY(v);
        const z = pos.getZ(v);
        const slope = -(z - halfW) / Math.sqrt(Math.max(1e-12, crownRadius ** 2 - (z - halfW) ** 2));
        const k = Math.hypot(1, slope);
        const r = Math.hypot(x, y);
        const dot = (x / r / k) * nrm.getX(v) + (y / r / k) * nrm.getY(v) + (-slope / k) * nrm.getZ(v);
        errs.push((Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI);
      }
    }
    assert.ok(errs.length > 100, `${name}: found the crown (${errs.length} corners)`);
    // Splitting the crown per strip instead of leaving it whole would land
    // every corner on its own face's normal — half a strip out, which is 2.3°
    // on this sampling and nowhere near 0.1°. The shoulder strip that closes
    // the patch against the cap is the only thing in the tail.
    const tight = errs.filter((e) => e < 0.1).length / errs.length;
    assert.ok(tight > 0.9, `${name}: crown shades as one surface (${(100 * tight).toFixed(1)}% within 0.1°)`);
    assert.ok(Math.max(...errs) < 3, `${name}: crown normal follows the arc (worst ${Math.max(...errs).toFixed(2)}°)`);
  }
});

test('a flat piece needs no loft and every section stays congruent', () => {
  const flat = planWheel({ tread: 'lugged' });
  assert.equal(flat.sections.length, 1);
  // Bars slanting across the width still loft, and must sample to equal rings.
  const angled = planWheel({ tread: 'angled', treadAngle: 30 });
  assert.ok(angled.sections.length > 1, 'a slanted tread is the last thing that lofts');
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

// Two ways into the shaped path, each with a plain extrusion of the same solid
// to measure against: a crown of 0.05 mm is the flat wheel geometrically but
// goes through the tire tool, and slanting the bars only rotates each section
// about the axis, which leaves the swept volume alone.
test('every shaped piece encloses the solid its extrusion does — voids stay voids', () => {
  const CASES = [
    ['crowned', (base) => [{ ...base, profile: { shape: 'flat' } }, { ...base, profile: { shape: 'crowned', crownDrop: 0.05 } }]],
    ['angled', (base) => [{ ...base, tread: 'angled', treadCount: 48, treadAngle: 0 }, { ...base, tread: 'angled', treadCount: 48, treadAngle: 30 }]],
    ['chevron', (base) => [{ ...base, tread: 'chevron', treadCount: 48, treadAngle: 0 }, { ...base, tread: 'chevron', treadCount: 48, treadAngle: 30 }]],
  ];
  for (const infill of ['solid', 'spokes', 'honeycomb', 'flexweb', 'lattice', 'auxetic', 'graded', 'voronoi']) {
    for (const type of ['keyed', 'plain', 'hex', 'dbore', 'bolt']) {
      for (const [via, pair] of CASES) {
        const [flatCfg, loftCfg] = pair({ infill, bore: { type } });
        const flat = planWheel(flatCfg);
        const lofted = planWheel(loftCfg);
        const what = `${infill}/${type} via ${via}`;
        assert.equal(flat.sections.length, 1, `${what}: reference extrudes`);
        const shaped =
          lofted.sections.length > 1 ||
          lofted.uniquePieces.some((u) => u.cutters.some((c) => c.shape === 'revolve'));
        assert.ok(shaped, `${what}: subject is shaped rather than a plain prism`);
        for (let k = 0; k < flat.uniquePieces.length; k++) {
          const geo = buildLoftGeometry(THREE, lofted, lofted.uniquePieces[k]);
          assert.ok(geo, `${what}: piece ${k} builds`);
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

// ---------------------------------------------------------------------------
// Material zones
// ---------------------------------------------------------------------------
// A multi-material piece is one solid cut into bodies at cylinders concentric
// with the axle, and the preview has to show *those* bodies. Assigning whole
// triangles by centroid would be cheaper and would put the colour boundary
// tens of millimetres out, because a cap triangle out of the ear-clipper can
// run from the bore to the rim — so straddling triangles are cut on the
// cylinder instead. These tests pin both halves of that: the cut lands on the
// real radius, and cutting does not lose, duplicate or unstitch anything.
const ZONE_CASES = [
  ['3 materials, segmented, extruded', { materials: { tread: 'tpu', web: 'petg', hub: 'abs' } }],
  ['2 materials, honeycomb, crowned loft', { diameter: 200, width: 40, infill: 'honeycomb', tread: 'lugged', profile: { shape: 'crowned', crownDrop: 4 }, materials: { tread: 'tpu' } }],
  ['2 materials, one piece, voronoi', { diameter: 180, width: 40, infill: 'voronoi', tread: 'slick', bore: { type: 'bolt' }, materials: { hub: 'petg', web: 'tpu', tread: 'tpu' } }],
  ['2 materials, chevron loft', { diameter: 300, width: 50, infill: 'solid', tread: 'chevron', treadAngle: 30, materials: { tread: 'tpu' } }],
];

// The mesh the preview would build before it is grouped.
function baseGeometry(plan, u) {
  const shaped = plan.sections.length > 1 || classifyCutters(u.cutters).tire;
  return (
    (shaped ? buildLoftGeometry(THREE, plan, u) : null) ||
    new THREE.ExtrudeGeometry(buildPieceShape(THREE, plan, u), {
      depth: plan.W,
      bevelEnabled: false,
      curveSegments: 48,
    })
  );
}

test('zone groups put every triangle inside the band its material owns', () => {
  for (const [name, cfg] of ZONE_CASES) {
    const plan = planWheel(cfg);
    const bounds = plan.zones.slice(1).map((z) => z.r0);
    assert.ok(bounds.length >= 1, `${name}: more than one zone`);
    for (const u of plan.uniquePieces) {
      const geo = groupByZone(THREE, baseGeometry(plan, u), bounds);
      const pos = geo.getAttribute('position');
      const idx = geo.getIndex();
      assert.equal(geo.groups.length, plan.zones.length, `${name}: one draw group per zone`);
      const edges = [0, ...bounds, Infinity];
      let covered = 0;
      for (const g of geo.groups) {
        const lo = edges[g.materialIndex];
        const hi = edges[g.materialIndex + 1];
        covered += g.count;
        assert.ok(g.count > 0, `${name}: zone ${g.materialIndex} has geometry`);
        for (let i = g.start; i < g.start + g.count; i++) {
          const v = idx.getX(i);
          const r = Math.hypot(pos.getX(v), pos.getY(v));
          // Positions are stored as float32, so the cut lands on the cylinder
          // to about 1e-5 mm at rim radii — a hundredth of the planner's grid.
          assert.ok(
            r > lo - 1e-4 && r < hi + 1e-4,
            `${name}: vertex at r=${r.toFixed(4)} is outside its zone [${lo}, ${hi}]`
          );
        }
      }
      assert.equal(covered, idx.count, `${name}: the groups cover every triangle exactly once`);
    }
  }
});

test('splitting a piece into zones neither adds nor removes material', () => {
  for (const [name, cfg] of ZONE_CASES) {
    const plan = planWheel(cfg);
    const bounds = plan.zones.slice(1).map((z) => z.r0);
    for (const u of plan.uniquePieces) {
      const base = baseGeometry(plan, u);
      const want = signedVolume(base);
      const got = signedVolume(groupByZone(THREE, base, bounds));
      assert.ok(Math.abs(want) > 1, `${name}: the piece encloses something`);
      assert.ok(
        Math.abs(got - want) / Math.abs(want) < 1e-6,
        `${name}: grouped mesh encloses ${got.toFixed(1)} mm³ against ${want.toFixed(1)} mm³`
      );
    }
  }
});

test('a watertight piece is still watertight once it is split into zones', () => {
  // Only the lofted path is indexed and shares vertices between triangles, so
  // it is the only one where "every edge belongs to two faces" means anything
  // — and the only one where a cut vertex could fail to be shared.
  //
  // Welded by position, for the same reason the test above is: creasing splits
  // a vertex once per group of faces that share a normal, so the shell is only
  // closed geometrically, not by index. A cut vertex inherits that — the two
  // triangles either side of a crease that the boundary crosses each get their
  // own copy, at the same point.
  for (const [name, cfg] of ZONE_CASES) {
    const plan = planWheel(cfg);
    const bounds = plan.zones.slice(1).map((z) => z.r0);
    for (const u of plan.uniquePieces) {
      const base = buildLoftGeometry(THREE, plan, u);
      if (!base) continue;
      const split = groupByZone(THREE, base, bounds);
      const idx = split.getIndex().array;
      const weld = weldByPosition(split.getAttribute('position'));
      const edges = new Map();
      for (let i = 0; i < idx.length; i += 3) {
        const t = [idx[i], idx[i + 1], idx[i + 2]].map((v) => weld[v]);
        if (new Set(t).size < 3) continue; // a zero-area fan triangle, as above
        for (let k = 0; k < 3; k++) {
          const [a, b] = [t[k], t[(k + 1) % 3]];
          const key = a < b ? `${a}_${b}` : `${b}_${a}`;
          edges.set(key, (edges.get(key) || 0) + 1);
        }
      }
      const open = [...edges.values()].filter((v) => v !== 2).length;
      assert.equal(open, 0, `${name}: ${open} edges are not shared by exactly two faces`);
    }
  }
});

test('a single-material wheel is handed back the mesh it came in with', () => {
  const plan = planWheel({ diameter: 200, width: 40, infill: 'honeycomb' });
  assert.equal(plan.multiMaterial, false);
  const base = baseGeometry(plan, plan.uniquePieces[0]);
  assert.equal(groupByZone(THREE, base, plan.zones.slice(1).map((z) => z.r0)), base);
});
