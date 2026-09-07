import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { planWheel } from '../src/lib/wheel.js';
import { generateSource, RUNTIME_FILES } from '../src/lib/occgen.js';
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
  ['crowned lugged', { diameter: 200, width: 40, infill: 'solid', tread: 'lugged', profile: { shape: 'crowned', crownDrop: 5 } }],
  ['round bike tire', { diameter: 200, width: 28, infill: 'honeycomb', tread: 'chevron', treadAngle: 35, treadDepth: 2.2, profile: { shape: 'round' } }],
];

const pieceFiles = (files) => files.filter((f) => f.kind === 'source');

// The emitted data blocks are Python literals, but deliberately of the subset
// that is also JSON once `True`/`False` and the comment lines are dealt with.
// Reading them back is how these tests check the geometry rather than the
// formatting: if the emitter ever garbles a coordinate, it shows up here and
// not merely as a diff.
function readLiteral(src, name) {
  // Either `NAME = []` on one line, or a block whose `]` closes at column 0.
  const m = new RegExp(`^${name} = (\\[\\]|\\[[\\s\\S]*?^\\])$`, 'm').exec(src);
  assert.ok(m, `${name} block present and closed at column 0`);
  const json = m[1]
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n')
    .replace(/\bTrue\b/g, 'true')
    .replace(/\bFalse\b/g, 'false')
    .replace(/,(\s*[\]}])/g, '$1'); // Python tolerates trailing commas; JSON does not
  return JSON.parse(json);
}

const endpoints = (seg) => [seg.a, seg.b];
const gap = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

for (const [name, cfg] of CONFIGS) {
  test(`bundle is well-formed: ${name}`, () => {
    const plan = planWheel(cfg);
    const files = generateSource(plan);
    const sources = pieceFiles(files);
    assert.equal(sources.length, plan.uniquePieces.length);

    for (const f of sources) {
      const src = f.content;
      assert.ok(!/NaN|Infinity|undefined/.test(src), 'no bad numbers');
      assert.ok(!/\d[eE][+-]?\d/.test(src), 'no exponent-notation numbers');
      assert.match(src, /^from wheelwright_occ import build, save$/m);
      assert.match(src, /^W = [\d.]+$/m);

      const sections = readLiteral(src, 'SECTIONS');
      const cutters = readLiteral(src, 'CUTTERS');
      assert.equal(sections.length, plan.sections.length);
      assert.deepEqual(
        sections.map((s) => s.z),
        plan.sections.map((s) => s.z)
      );

      const W = Number(/^W = ([\d.]+)$/m.exec(src)[1]);
      assert.equal(W, plan.W);
      for (const c of cutters) {
        assert.ok(['circle', 'poly', 'path', 'revolve'].includes(c.shape), `known shape ${c.shape}`);
        if (c.shape === 'revolve') {
          // The tire carries no depth range: its profile is drawn in (r, z),
          // so it already says where across the width it starts and stops.
          assert.equal(c.z0, undefined);
          assert.ok(c.segs.length >= 4, 'a revolved profile is a closed loop');
        } else {
          assert.ok(Number.isFinite(c.z0) && Number.isFinite(c.z1), 'cutter has a depth range');
          assert.ok(c.z1 > c.z0, 'cutter depth range is non-empty');
        }
      }
    }

    const manifest = JSON.parse(files.find((f) => f.name === 'wheelwright.json').content);
    assert.equal(manifest.segments, plan.N);
    assert.equal(manifest.pieces.length, plan.uniquePieces.length);
  });

  test(`every emitted loop closes: ${name}`, () => {
    // This is the property the OpenCascade builder rests on. It chains each
    // edge onto its predecessor's vertex, which closes a loop by construction
    // — but only if the entities really are in order and really do share
    // endpoints. A loop emitted out of order would build a wire that is closed
    // and wrong, so it has to be checked here rather than by the kernel.
    // Neighbours share their endpoint exactly, and the emitter prints six
    // decimals, so the only slack allowed is that last printed digit. Anything
    // looser would let a repair that moves endpoints (the one the KCL emitter
    // had to make, and the one that breaks this backend) pass unnoticed.
    const TOL = 1e-6;
    const plan = planWheel(cfg);
    let loops = 0;
    for (const f of pieceFiles(generateSource(plan))) {
      const loopsIn = [
        ...readLiteral(f.content, 'SECTIONS').filter((s) => s.segs).map((s) => s.segs),
        ...readLiteral(f.content, 'CUTTERS').filter((c) => c.segs).map((c) => c.segs),
      ];
      for (const segs of loopsIn) {
        assert.ok(segs.length >= 2, `${f.name}: a loop needs two entities`);
        for (let i = 0; i < segs.length; i++) {
          const here = endpoints(segs[i])[1];
          const next = endpoints(segs[(i + 1) % segs.length])[0];
          const d = gap(here, next);
          assert.ok(d < TOL, `${f.name}: entity ${i} ends ${d.toExponential(2)} mm from the next`);
        }
        loops++;
      }
    }
    assert.ok(loops > 0, 'the config emitted at least one loop');
  });
}

test('arcs agree with their own centre', () => {
  // The builder takes an arc's radius as the mean of its two endpoint
  // distances, so a small disagreement is absorbed rather than rejected — but
  // a large one means the centre is simply wrong, and the arc would bow the
  // wrong way instead of failing.
  const TOL = 5e-3;
  for (const [name, cfg] of CONFIGS) {
    for (const f of pieceFiles(generateSource(planWheel(cfg)))) {
      const loops = [
        ...readLiteral(f.content, 'SECTIONS').filter((s) => s.segs).map((s) => s.segs),
        ...readLiteral(f.content, 'CUTTERS').filter((c) => c.segs).map((c) => c.segs),
      ];
      for (const segs of loops) {
        for (const s of segs.filter((s) => s.kind === 'arc')) {
          const d = Math.abs(gap(s.a, s.center) - gap(s.b, s.center));
          assert.ok(d < TOL, `${name}/${f.name}: arc endpoints differ by ${d.toExponential(2)} mm`);
        }
      }
    }
  }
});

test('only a slanted tread makes a piece more than one section', () => {
  // The crown used to force several: it was lofted through sampled heights,
  // which was both slower and — because a circular section curves hardest
  // where uniform sampling is thinnest — inexact. It is a revolved cut now, so
  // the only thing left that varies the profile with height is a bar that
  // leans.
  for (const shape of ['flat', 'crowned', 'round']) {
    const plan = planWheel({ tread: 'lugged', profile: { shape, crownDrop: 5 } });
    assert.equal(plan.sections.length, 1, `${shape} + straight bars is a single prism`);
    assert.equal(readLiteral(pieceFiles(generateSource(plan))[0].content, 'SECTIONS').length, 1);
    const cutters = readLiteral(pieceFiles(generateSource(plan))[0].content, 'CUTTERS');
    assert.equal(
      cutters.filter((c) => c.shape === 'revolve').length,
      shape === 'flat' ? 0 : 1,
      `${shape}: a crown is one revolved tool, a flat tread none`
    );
  }

  const slanted = planWheel({ tread: 'chevron', treadAngle: 30, profile: { shape: 'round' } });
  assert.ok(slanted.sections.length > 1, 'a slanted tread still lofts');
  const sections = readLiteral(pieceFiles(generateSource(slanted))[0].content, 'SECTIONS');
  assert.equal(sections.length, slanted.sections.length);
  // Congruence is what makes that loft buildable — matching entity counts.
  const counts = new Set(sections.map((s) => (s.segs ? s.segs.length : -1)));
  assert.equal(counts.size, 1, `all sections have the same entity count, got ${[...counts]}`);
});

test('every prismatic cut runs the full depth; the tire is the one that does not', () => {
  // Grooves were the only cut that stopped partway through the width, and they
  // are runs of the tire's revolved profile now. So the prismatic tools are
  // uniformly through-cuts, and each overshoots both faces when it is built.
  for (const tread of ['slick', 'ribbed', 'lugged', 'diamond']) {
    for (const shape of ['flat', 'crowned', 'round']) {
      const plan = planWheel({ tread, profile: { shape }, infill: 'spokes', ribCount: 3 });
      const where = `${tread}/${shape}`;
      for (const f of pieceFiles(generateSource(plan))) {
        for (const c of readLiteral(f.content, 'CUTTERS')) {
          if (c.shape === 'revolve') continue;
          assert.ok(c.z0 <= 0 && c.z1 >= plan.W, `${where}: ${c.shape} cut runs the full depth`);
        }
      }
    }
  }
  const ribbed = planWheel({ tread: 'ribbed', ribCount: 3, infill: 'spokes' });
  const cutters = readLiteral(pieceFiles(generateSource(ribbed))[0].content, 'CUTTERS');
  assert.equal(cutters.filter((c) => c.shape === 'revolve').length, 1, 'grooves ride the tire tool');
  assert.ok(cutters.some((c) => c.shape !== 'revolve'), 'and the bore still runs through');
});

test('the bundle carries the runtime that builds it', () => {
  const plan = planWheel({});
  const bare = generateSource(plan);
  assert.equal(bare.filter((f) => f.kind === 'runtime').length, 0, 'runtime is opt-in');

  const runtime = Object.fromEntries(RUNTIME_FILES.map((n) => [n, `# ${n}\n`]));
  const full = generateSource(plan, runtime);
  for (const n of RUNTIME_FILES) {
    const f = full.find((x) => x.name === n);
    assert.ok(f, `${n} is in the bundle`);
    assert.equal(f.content, runtime[n], 'shipped verbatim, not rewritten');
  }
});

test('the shipped runtime is the code the repo actually runs', () => {
  // generateSource() takes the runtime as an argument so the browser can fetch
  // it, which means nothing stops a caller passing something else. The server
  // reads these two files; this asserts they exist to be read.
  for (const n of RUNTIME_FILES) {
    const src = readFileSync(join(process.cwd(), 'src', 'lib', 'occ', n), 'utf8');
    assert.ok(src.length > 100, `${n} is present in src/lib/occ`);
  }
});

test('regenerating a configuration is byte-identical', () => {
  // What makes "these configs regenerate unchanged" a usable regression test.
  // The manifest carries a timestamp, so it is excluded.
  for (const [name, cfg] of CONFIGS.slice(0, 4)) {
    const a = pieceFiles(generateSource(planWheel(cfg)));
    const b = pieceFiles(generateSource(planWheel(cfg)));
    assert.deepEqual(a, b, `${name} regenerates identically`);
  }
});

test('zip writer produces a valid archive skeleton', () => {
  const zip = zipStore([
    { name: 'a.txt', data: 'hello wheelwright' },
    { name: 'dir/piece-A.py', data: 'W = 1' },
  ]);
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'local header magic');
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50, 'EOCD magic');
  assert.equal(zip.readUInt16LE(zip.length - 22 + 10), 2, 'entry count');
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'crc32 reference vector');
});
