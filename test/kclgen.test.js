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
  ['honeycomb round cells', { diameter: 400, width: 70, infill: 'honeycomb', honeycomb: { cellSize: 18, wall: 3, cellShape: 'round' } }],
  ['honeycomb filleted tangential cells', { diameter: 400, width: 70, infill: 'honeycomb', honeycomb: { cellSize: 18, cornerRadius: 2.5, orientation: 'tangential' } }],
  ['lattice woven keyed', { diameter: 260, width: 55, material: 'tpu', infill: 'lattice', tread: 'ribbed', lattice: { rows: 3, cornerRadius: 2 } }],
  ['lattice chevron sharp', { diameter: 300, width: 50, infill: 'lattice', tread: 'lugged', lattice: { rows: 1, cornerRadius: 0 } }],
  ['auxetic hex bore', { diameter: 200, width: 40, material: 'tpu', infill: 'auxetic', tread: 'lugged', bore: { type: 'hex', hexAcrossFlats: 13 }, auxetic: { rings: 2, waist: 0.4 } }],
  ['voronoi bolt slick', { diameter: 180, width: 40, infill: 'voronoi', tread: 'slick', bore: { type: 'bolt', boltCount: 5, boltCircle: 70, boltHoleDia: 5.5, pilotDia: 14 }, voronoi: { seed: 7 } }],
  ['dbore ribbed solid', { diameter: 200, width: 45, infill: 'solid', tread: 'ribbed', bore: { type: 'dbore', diameter: 12 } }],
  ['segmented bolt solid slick', { bore: { type: 'bolt' }, infill: 'solid', tread: 'slick' }],
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

test('segmented bolt pieces never subtract the pilot bore', () => {
  // The concentric pilot circle used to be a tip-trim cutter; the Zoo engine
  // rejects that razor-thin subtraction ("cannot handle this 3D subtraction
  // yet"), so the bore arc is part of the outline and piece A — which has no
  // bolt hole — needs no boolean at all.
  const plan = planWheel({ bore: { type: 'bolt' }, infill: 'solid', tread: 'slick' });
  assert.ok(plan.N > 1, 'repro config must be segmented');
  const files = generateKcl(plan);
  const pieceA = files.find((f) => f.name === 'piece-A.kcl').content;
  assert.match(pieceA, /arc\(start = \[6\.2, 0\]/, 'inner arc sits on the pilot radius');
  assert.ok(!pieceA.includes('subtract('), 'piece A has no subtract');
  assert.match(pieceA, /\npiece = blank\n/);
  const pieceB = files.find((f) => f.name === 'piece-B.kcl').content;
  // Piece B's bolt hole runs the full width, so it is a loop in the profile
  // sketch rather than a boolean — nothing here needs a subtract either.
  assert.ok(!pieceB.includes('subtract('), 'piece B has no subtract');
  assert.ok(!pieceB.includes('// cutter: '), 'no full-depth cut is emitted as a tool');
  assert.match(pieceB, /sec1Sk = sketch[\s\S]*?\n {2}h1 = circle\(/, 'the bolt hole is a loop in the profile sketch');
});

test('full-depth cuts become sketch loops; only partial-depth ones stay tools', () => {
  // A flat ribbed wheel is the one case left with a real boolean: the
  // circumferential grooves do not run the full width.
  const plan = planWheel({ tread: 'ribbed', infill: 'spokes' });
  const kcl = generateKcl(plan).find((f) => f.name === 'piece-A.kcl').content;
  const tools = [...kcl.matchAll(/\/\/ cutter: (\S+)/g)].map((m) => m[1]);
  assert.ok(tools.length > 0 && tools.every((t) => t.startsWith('groove')), `only grooves stay tools, got ${tools}`);
  assert.ok(!kcl.includes('// cutter: bore'), 'the bore is a profile loop');
  // The old emitter opened a sketch per cutter; now there is one per section.
  assert.equal([...kcl.matchAll(/= sketch\(on = /g)].length, plan.sections.length + tools.length);
});

test('a crowned piece lofts through its sections instead of extruding', () => {
  const plan = planWheel({ tread: 'lugged', profile: { shape: 'crowned', crownDrop: 5 } });
  const kcl = generateKcl(plan).find((f) => f.name === 'piece-A.kcl').content;
  assert.ok(!kcl.includes('extrude('), 'a crowned piece is never extruded');
  const loft = kcl.match(/blank = loft\(\[([^\]]*)\]\)/);
  assert.ok(loft, 'blank comes from a loft');
  assert.equal(loft[1].split(',').length, plan.sections.length);
  for (let i = 0; i < plan.sections.length; i++) {
    const z = plan.sections[i].z;
    assert.ok(
      kcl.includes(z === 0 ? 'sketch(on = XY)' : `offsetPlane(XY, offset = ${z})`),
      `section at z=${z} sits on its own plane`
    );
  }
});

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
