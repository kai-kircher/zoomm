#!/usr/bin/env node
// Regenerates the bundle for a spread of configurations and, when OpenCascade
// is available, builds every unique piece through the real kernel to prove the
// generated code executes and produces a valid solid.
//
// Usage: npm run validate        (writes to ./out/validate)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../src/lib/env.js';
import { planWheel } from '../src/lib/wheel.js';
import { generateSource, slugFor, RUNTIME_FILES } from '../src/lib/occgen.js';
import { occStatus, buildPieces } from '../src/lib/occ.js';

loadEnv(process.cwd()); // seed WHEELWRIGHT_PYTHON from .env, like the server does

const CONFIGS = [
  ['cart-14in-keyed', {}],
  ['one-piece-plain', { diameter: 120, width: 30, bore: { type: 'plain', diameter: 8 } }],
  ['rover-tpu-flexweb-hex', { diameter: 260, width: 60, material: 'tpu', infill: 'flexweb', tread: 'ribbed', bore: { type: 'hex', hexAcrossFlats: 13 } }],
  ['caster-bolt-honeycomb', { diameter: 160, width: 45, infill: 'honeycomb', tread: 'slick', bore: { type: 'bolt', boltCount: 4, boltCircle: 60, boltHoleDia: 5.5, pilotDia: 12 } }],
  // Honeycomb cells can be round (circle cutters) or filleted (lines + corner
  // arcs) — both are shapes the kernel sees nowhere else in the matrix.
  ['honeycomb-round-cells', { diameter: 400, width: 70, infill: 'honeycomb', tread: 'slick', honeycomb: { cellSize: 18, wall: 3, cellShape: 'round' } }],
  ['honeycomb-filleted-cells', { diameter: 400, width: 70, infill: 'honeycomb', tread: 'ribbed', honeycomb: { cellSize: 18, cornerRadius: 2.5, orientation: 'tangential' } }],
  // The chart-drawn webs (lattice / auxetic / voronoi) all emit many-sided
  // closed line loops, and are where a self-crossing loop would show up.
  ['lattice-woven-tpu', { diameter: 260, width: 55, material: 'tpu', infill: 'lattice', tread: 'ribbed', lattice: { rows: 3, cornerRadius: 2 } }],
  ['lattice-chevron-sharp', { diameter: 300, width: 50, infill: 'lattice', tread: 'lugged', lattice: { rows: 1, cornerRadius: 0 } }],
  ['auxetic-reentrant-hex', { diameter: 200, width: 40, material: 'tpu', infill: 'auxetic', tread: 'lugged', bore: { type: 'hex', hexAcrossFlats: 13 }, auxetic: { rings: 2, waist: 0.4 } }],
  ['voronoi-organic-bolt', { diameter: 180, width: 40, infill: 'voronoi', tread: 'slick', bore: { type: 'bolt', boltCount: 5, boltCircle: 70, boltHoleDia: 5.5, pilotDia: 14 }, voronoi: { seed: 7 } }],
  // Graded rings put a wide range of cell sizes in one wheel — the smallest
  // loops the kernel is asked to cut sit next to the largest.
  ['graded-rings-keyed', { diameter: 355.6, width: 50, infill: 'graded', tread: 'lugged' }],
  ['graded-swirled-diamonds', { diameter: 160, width: 45, infill: 'graded', tread: 'slick', bore: { type: 'bolt' }, graded: { cellShape: 'diamond', swirl: 30, rings: 2 } }],
  ['wagon-bolt-segmented', { diameter: 355.6, bore: { type: 'bolt', boltCount: 4, boltCircle: 60, boltHoleDia: 5.5, pilotDia: 12 } }],
  ['dbore-diamond-solid', { diameter: 200, width: 45, infill: 'solid', tread: 'diamond', bore: { type: 'dbore', diameter: 12 } }],
  ['cart-bolt-segmented', { bore: { type: 'bolt' }, infill: 'solid', tread: 'slick' }],
  // Forced high segment counts, where the wedge is narrow enough to squeeze
  // the hub dovetail. Both of these used to hand the kernel a self-crossing
  // wire: it built a shape and reported success, and every piece failed its
  // own validity check. Nothing else in this matrix reaches those counts.
  ['hex-forced-16-segments', { infill: 'solid', tread: 'lugged', bore: { type: 'hex' }, segmentsOverride: 16 }],
  ['bolt-forced-12-segments', { infill: 'solid', tread: 'lugged', bore: { type: 'bolt' }, segmentsOverride: 12 }],
  // Tread bars are notches in the piece boundary, so a busy bar pattern is a
  // long loop. Chevron and angled bars move those notches from section to
  // section, which is what the loft has to stitch; a one-piece wheel closes
  // the ring across the 0°/360° seam.
  ['chevron-segmented', { diameter: 300, width: 50, infill: 'solid', tread: 'chevron', treadAngle: 30 }],
  ['angled-one-piece', { diameter: 120, width: 30, infill: 'spokes', tread: 'angled', treadAngle: 30, bore: { type: 'plain', diameter: 8 } }],
  // The only spokes entry above is one-piece, where the gap between two ribs
  // runs from seam to seam. Segmented, that gap is a quad the kernel meets
  // nowhere else in this matrix — two lines offset from neighbouring rays,
  // closed by arcs of two different radii — and it is bounded by the joint
  // keep-out on one side and by a rib on the other. On a narrow wedge those
  // two lines used to cross before reaching the inner web circle, and the
  // bowtie that left was cut as a valid gap.
  ['spokes-segmented', { diameter: 250, infill: 'spokes' }],
  ['ribbed-segmented', { infill: 'solid', tread: 'ribbed' }],
  // Curved cross-sections: several sections lofted rather than one extruded.
  ['crowned-lugged', { diameter: 200, width: 40, infill: 'solid', tread: 'lugged', profile: { shape: 'crowned', crownDrop: 5 } }],
  ['round-bike-tire', { diameter: 200, width: 28, infill: 'honeycomb', tread: 'chevron', treadAngle: 35, treadDepth: 2.2, profile: { shape: 'round' }, bore: { type: 'bolt', boltCount: 5, boltCircle: 60, boltHoleDia: 5, pilotDia: 12 } }],
  ['crowned-ribbed', { diameter: 160, width: 36, infill: 'solid', tread: 'ribbed', profile: { shape: 'crowned' } }],
  // Multi-material: the piece is built exactly as above and then intersected
  // with one annulus per filament. Three shapes of that — a segmented wheel
  // split in two, a one-piece wheel split in three, and a lofted section, so
  // the extra boolean meets a B-spline blank as well as a prismatic one.
  ['dual-tpu-tread-segmented', { materials: { tread: 'tpu' } }],
  ['triple-material-one-piece', { diameter: 200, width: 40, infill: 'honeycomb', tread: 'lugged', materials: { tread: 'tpu', web: 'petg', hub: 'abs' } }],
  ['dual-material-chevron-loft', { diameter: 300, width: 50, infill: 'lattice', tread: 'chevron', treadAngle: 30, materials: { tread: 'tpu' } }],
];

const runtime = Object.fromEntries(
  RUNTIME_FILES.map((n) => [n, readFileSync(join(process.cwd(), 'src', 'lib', 'occ', n), 'utf8')])
);

/**
 * Did the revolved tire tool actually remove anything?
 *
 * This is here because the failure it catches is silent. A boolean whose body
 * has a planar face lying in the plane of the tool's seam — or an outer
 * surface exactly tangent to the tool's inner one — reports success and
 * returns the body unchanged. Every other check passes: the solid is valid,
 * watertight, and the right shape for a wheel. It is simply not crowned.
 *
 * The control is the same piece built without that one tool, so the comparison
 * is against the identical blank and cutters rather than against a different
 * configuration. Returns null when there is no tire to check.
 */
function tireActuallyCuts(plan, rows) {
  if (!plan.uniquePieces.some((u) => u.cutters.some((c) => c.shape === 'revolve'))) return null;
  const control = {
    ...plan,
    uniquePieces: plan.uniquePieces.map((u) => ({
      ...u,
      cutters: u.cutters.filter((c) => c.shape !== 'revolve'),
    })),
  };
  const before = buildPieces(generateSource(control, runtime), { formats: ['stl'] }).report.pieces;
  return rows.every((row, i) => {
    const uncut = before[i]?.volumeMm3 ?? 0;
    return uncut - row.volumeMm3 > uncut * 5e-4;
  });
}
const outRoot = join(process.cwd(), 'out', 'validate');
const status = occStatus();
console.log(
  status.ready
    ? `OpenCascade: OCP ${status.occtVersion} via ${status.pythonPath}\n`
    : 'OpenCascade: NOT FOUND — writing sources only. Run `npm run setup:occ` to build them too.\n'
);

let failures = 0;
let pieces = 0;
let seconds = 0;
const started = Date.now();

for (const [name, cfg] of CONFIGS) {
  const plan = planWheel(cfg);
  const files = generateSource(plan, runtime);
  const dir = join(outRoot, `${name}-${slugFor(plan)}`);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f.name), f.content);

  const head = `${name.padEnd(26)} N=${String(plan.N).padStart(2)}, ${plan.uniquePieces.length} piece(s)`;
  if (!status.ready) {
    console.log(`${head} → ${dir}`);
    continue;
  }

  try {
    const built = buildPieces(files);
    for (const b of built) writeFileSync(join(dir, b.name), b.data);
    const rows = built.report.pieces;
    const bad = rows.filter((p) => !p.valid);
    pieces += rows.length;
    seconds += rows.reduce((s, p) => s + p.seconds, 0);
    const t = rows.reduce((s, p) => s + p.seconds, 0).toFixed(1);
    const cut = tireActuallyCuts(plan, rows);
    // The kernel already refuses to write bodies that do not add back up to
    // the piece they came from; this is the other half of that — that the
    // split happened at all, in the shape the planner asked for.
    const split = plan.multiMaterial
      ? rows.every(
          (p) =>
            p.bodies?.length === plan.zones.length &&
            p.bodies.every((b, i) => b.material === plan.zones[i].material)
        )
      : rows.every((p) => !p.bodies);
    if (bad.length) {
      failures++;
      console.log(`${head}  ✗ ${bad.length} piece(s) built an invalid B-rep`);
    } else if (cut === false) {
      failures++;
      console.log(`${head}  ✗ the tire tool removed nothing — the crown is not in the solid`);
    } else if (!split) {
      failures++;
      console.log(`${head}  ✗ the material split did not produce the planned bodies`);
    } else {
      const mats = plan.multiMaterial ? `, ${plan.zones.length} bodies × ${plan.materialSet.join('+')}` : '';
      console.log(`${head}  ✓ ${t}s, ${built.length} files${mats}`);
    }
  } catch (e) {
    failures++;
    console.log(`${head}  ✗ ${e.message.slice(0, 200)}`);
  }
}

if (!status.ready) {
  console.log('\nSources written. To build them: `npm run setup:occ`, then re-run.');
} else {
  console.log(
    `\n${CONFIGS.length - failures}/${CONFIGS.length} configurations built ` +
      `(${pieces} pieces, ${seconds.toFixed(1)}s of kernel time, ` +
      `${((Date.now() - started) / 1000).toFixed(0)}s wall clock) → ${outRoot}`
  );
  if (failures) process.exit(1);
}
