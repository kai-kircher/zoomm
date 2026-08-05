#!/usr/bin/env node
// Regenerates KCL for a spread of configurations and, when the Zoo CLI +
// ZOO_API_TOKEN are available, round-trips every piece through the real
// engine (`zoo kcl export`) to prove the generated code executes.
//
// Usage: npm run validate:kcl        (writes to ./out/validate)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv } from '../src/lib/env.js';
import { planWheel } from '../src/lib/wheel.js';
import { generateKcl, slugFor } from '../src/lib/kclgen.js';
import { zooStatus, exportStl } from '../src/lib/zoo.js';

loadEnv(process.cwd()); // seed ZOO_API_TOKEN from .env, like the server does

const CONFIGS = [
  ['cart-14in-keyed', {}],
  ['one-piece-plain', { diameter: 120, width: 30, bore: { type: 'plain', diameter: 8 } }],
  ['rover-tpu-flexweb-hex', { diameter: 260, width: 60, material: 'tpu', infill: 'flexweb', tread: 'ribbed', bore: { type: 'hex', hexAcrossFlats: 13 } }],
  ['caster-bolt-honeycomb', { diameter: 160, width: 45, infill: 'honeycomb', tread: 'slick', bore: { type: 'bolt', boltCount: 4, boltCircle: 60, boltHoleDia: 5.5, pilotDia: 12 } }],
  // Honeycomb cells can be round (circle cutters) or filleted (lines + corner
  // arcs) — both are shapes the engine sees nowhere else in the matrix.
  ['honeycomb-round-cells', { diameter: 400, width: 70, infill: 'honeycomb', tread: 'slick', honeycomb: { cellSize: 18, wall: 3, cellShape: 'round' } }],
  ['honeycomb-filleted-cells', { diameter: 400, width: 70, infill: 'honeycomb', tread: 'ribbed', honeycomb: { cellSize: 18, cornerRadius: 2.5, orientation: 'tangential' } }],
  // The chart-drawn webs (lattice / auxetic / voronoi) all emit many-sided
  // closed line loops with an explicit region seed — a shape the engine sees
  // nowhere else, and one where a self-crossing loop or a seed that missed
  // its own cell would only show up here.
  ['lattice-woven-tpu', { diameter: 260, width: 55, material: 'tpu', infill: 'lattice', tread: 'ribbed', lattice: { rows: 3, cornerRadius: 2 } }],
  ['lattice-chevron-sharp', { diameter: 300, width: 50, infill: 'lattice', tread: 'lugged', lattice: { rows: 1, cornerRadius: 0 } }],
  ['auxetic-reentrant-hex', { diameter: 200, width: 40, material: 'tpu', infill: 'auxetic', tread: 'lugged', bore: { type: 'hex', hexAcrossFlats: 13 }, auxetic: { rings: 2, waist: 0.4 } }],
  ['voronoi-organic-bolt', { diameter: 180, width: 40, infill: 'voronoi', tread: 'slick', bore: { type: 'bolt', boltCount: 5, boltCircle: 70, boltHoleDia: 5.5, pilotDia: 14 }, voronoi: { seed: 7 } }],
  ['wagon-bolt-segmented', { diameter: 355.6, bore: { type: 'bolt', boltCount: 4, boltCircle: 60, boltHoleDia: 5.5, pilotDia: 12 } }],
  ['dbore-diamond-solid', { diameter: 200, width: 45, infill: 'solid', tread: 'diamond', bore: { type: 'dbore', diameter: 12 } }],
  // Segmented bolt hub (N=8 at the default diameter): the pilot bore must be
  // carried by the sector outline — the engine rejects the old tip-trim
  // subtract of the concentric pilot circle over the wedge tip.
  ['cart-bolt-segmented', { bore: { type: 'bolt' }, infill: 'solid', tread: 'slick' }],
];

const outRoot = join(process.cwd(), 'out', 'validate');
const status = zooStatus();
console.log(`Zoo CLI: ${status.cli ? 'found' : 'NOT FOUND'} | token: ${status.token ? 'set' : 'NOT SET'}`);

let failures = 0;
for (const [name, cfg] of CONFIGS) {
  const plan = planWheel(cfg);
  const files = generateKcl(plan);
  const dir = join(outRoot, `${name}-${slugFor(plan)}`);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f.name), f.content);
  process.stdout.write(`${name}: N=${plan.N}, ${plan.uniquePieces.length} unique piece(s) → ${dir}\n`);

  if (status.ready) {
    try {
      const stls = exportStl(files);
      for (const s of stls) writeFileSync(join(dir, s.name), s.data);
      console.log(`  ✓ engine round-trip OK (${stls.map((s) => `${s.name} ${(s.data.length / 1024).toFixed(0)}kB`).join(', ')})`);
    } catch (e) {
      failures++;
      console.log(`  ✗ engine export FAILED: ${e.message}`);
    }
  }
}

if (!status.ready) {
  console.log('\nKCL written. To validate against the engine: `npm run setup:zoo`, set ZOO_API_TOKEN in .env, and re-run.');
} else if (failures) {
  process.exit(1);
} else {
  console.log('\nAll configurations executed by the Zoo engine.');
}
