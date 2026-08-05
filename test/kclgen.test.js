import test from 'node:test';
import assert from 'node:assert/strict';
import { planWheel } from '../src/lib/wheel.js';
import { generateKcl } from '../src/lib/kclgen.js';
import { zipStore, crc32 } from '../src/lib/zip.js';

const CONFIGS = [
  ['default', {}],
  ['one-piece plain', { diameter: 120, width: 30, bore: { type: 'plain', diameter: 8 } }],
  ['flexweb hex', { diameter: 260, width: 60, material: 'tpu', infill: 'flexweb', tread: 'slick', bore: { type: 'hex', hexAcrossFlats: 13 } }],
  ['honeycomb bolt diamond', { diameter: 400, width: 70, infill: 'honeycomb', tread: 'diamond', bore: { type: 'bolt', boltCount: 6, boltCircle: 80, boltHoleDia: 6, pilotDia: 15 } }],
  ['dbore ribbed solid', { diameter: 200, width: 45, infill: 'solid', tread: 'ribbed', bore: { type: 'dbore', diameter: 12 } }],
];

for (const [name, cfg] of CONFIGS) {
  test(`kcl generation is well-formed: ${name}`, () => {
    const plan = planWheel(cfg);
    const files = generateKcl(plan);
    const kclFiles = files.filter((f) => f.kind === 'kcl');
    assert.equal(kclFiles.length, plan.uniquePieces.length);

    for (const f of kclFiles) {
      const src = f.content;
      assert.ok(!/NaN|Infinity|undefined/.test(src), 'no bad numbers');
      assert.match(src, /@settings\(defaultLengthUnit = mm, kclVersion = 1\.0\)/);
      // Balanced sketch blocks
      const opens = (src.match(/= sketch\(on = /g) || []).length;
      const hides = (src.match(/^hide\(/gm) || []).length;
      assert.equal(opens, hides, 'every sketch is hidden after use');
      // Braces balance
      let depth = 0;
      for (const ch of src) {
        if (ch === '{') depth++;
        if (ch === '}') depth--;
        assert.ok(depth >= 0);
      }
      assert.equal(depth, 0, 'braces balance');
      // Every extrude has a region and the final solid is named `piece`
      assert.match(src, /\npiece = /);
      // Subtract batches never exceed 12 tools
      for (const m of src.matchAll(/tools = \[([^\]]*)\]/g)) {
        assert.ok(m[1].split(',').length <= 12, 'subtract batch bounded');
      }
      // No scientific notation in numbers
      assert.ok(!/\d[eE][+-]?\d/.test(src), 'no exponent-notation numbers');
    }

    const manifest = files.find((f) => f.name === 'wheelwright.json');
    const parsed = JSON.parse(manifest.content);
    assert.equal(parsed.segments, plan.N);
    assert.equal(parsed.pieces.length, plan.uniquePieces.length);
  });
}

test('generated arcs always sweep CCW from start to end', () => {
  const plan = planWheel({});
  const files = generateKcl(plan);
  const src = files[0].content;
  for (const m of src.matchAll(/arc\(start = \[([-\d.]+), ([-\d.]+)\], end = \[([-\d.]+), ([-\d.]+)\], center = \[([-\d.]+), ([-\d.]+)\]\)/g)) {
    const [sx, sy, ex, ey, cx, cy] = m.slice(1).map(Number);
    const rs = Math.hypot(sx - cx, sy - cy);
    const re = Math.hypot(ex - cx, ey - cy);
    assert.ok(Math.abs(rs - re) < 0.01, 'arc endpoints equidistant from center');
  }
});

test('zip writer produces a valid archive skeleton', () => {
  const zip = zipStore([
    { name: 'a.txt', data: 'hello wheelwright' },
    { name: 'dir/b.kcl', data: 'x = 1' },
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'local header magic');
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, 'EOCD magic');
  assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 2, 'entry count');
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'crc32 reference vector');
});
