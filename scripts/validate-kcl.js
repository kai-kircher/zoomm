#!/usr/bin/env node
// Regenerates KCL for a spread of configurations and, when the Zoo CLI +
// ZOO_API_TOKEN are available, round-trips every piece through the real
// engine (`zoo kcl export`) to prove the generated code executes.
//
// Usage: npm run validate:kcl        (writes to ./out/validate)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planWheel } from '../src/lib/wheel.js';
import { generateKcl, slugFor } from '../src/lib/kclgen.js';
import { zooStatus, exportStl } from '../src/lib/zoo.js';

const CONFIGS = [
  ['cart-14in-keyed', {}],
  ['one-piece-plain', { diameter: 120, width: 30, bore: { type: 'plain', diameter: 8 } }],
  ['rover-tpu-flexweb-hex', { diameter: 260, width: 60, material: 'tpu', infill: 'flexweb', tread: 'ribbed', bore: { type: 'hex', hexAcrossFlats: 13 } }],
  ['caster-bolt-honeycomb', { diameter: 160, width: 45, infill: 'honeycomb', tread: 'slick', bore: { type: 'bolt', boltCount: 4, boltCircle: 60, boltHoleDia: 5.5, pilotDia: 12 } }],
  ['dbore-diamond-solid', { diameter: 200, width: 45, infill: 'solid', tread: 'diamond', bore: { type: 'dbore', diameter: 12 } }],
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
  console.log('\nKCL written. To validate against the engine: install the Zoo CLI, set ZOO_API_TOKEN, and re-run.');
} else if (failures) {
  process.exit(1);
} else {
  console.log('\nAll configurations executed by the Zoo engine.');
}
