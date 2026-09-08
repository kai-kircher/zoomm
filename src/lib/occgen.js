// Wheelwright — build-script generator.
//
// Emits one Python file per *unique* piece: most wheels are "print piece A × 6";
// hub features (keyway, D-flat, bolt holes) can make one or two variants. Each
// file is a declaration, not a program — the piece's boundary at each height
// and the list of prisms to subtract — handed to `wheelwright_occ.build()`,
// which ships in the same bundle. So a downloaded bundle builds itself:
//
//     pip install cadquery-ocp
//     python build.py .
//
// and the server runs that same script on those same files, which is what
// keeps "what you download" and "what the app built" the same thing.
//
// The emitter is deliberately boring: every number is precomputed by the
// planner, so there is nothing here to solve and nothing ambiguous to resolve.
// It is also *much* shorter than it needs to be, because OpenCascade imposes
// none of the constraints a KCL backend did — no folding full-depth cuts into
// the sketch to keep the boolean count down, no arc-endpoint snapping, no
// batching subtract calls, no lofting a crown because booleans refuse curved
// faces. Every cut is just a prism, and the kernel takes them all at once.

// Six decimals — a thousandth of a micron, far below both any printer and the
// planner's own 1e-3 mm coordinate grid. It exists so that regenerating a
// configuration produces byte-identical files, which is what makes
// "these configs regenerate unchanged" a usable regression test.
function fmt(v) {
  if (!Number.isFinite(v)) return '0';
  let x = Math.round(v * 1e6) / 1e6;
  if (Object.is(x, -0)) x = 0;
  return String(x);
}

// Prose rounding. `fmt` exists to make regenerated files byte-identical, which
// is why it keeps six decimals; a sentence wants one.
const mm1 = (v) => String(Math.round(v * 10) / 10);

const pt = ([x, y]) => `[${fmt(x)}, ${fmt(y)}]`;
const pts = (ps) => `[${ps.map(pt).join(', ')}]`;

// One entity of a closed loop. `radius` is dropped: the builder takes it as the
// mean of the endpoint distances, which is the more forgiving of the two given
// that the planner rounds all three numbers independently.
function seg(s) {
  if (s.kind === 'line') return `{"kind": "line", "a": ${pt(s.a)}, "b": ${pt(s.b)}}`;
  return (
    `{"kind": "arc", "a": ${pt(s.a)}, "b": ${pt(s.b)}, ` +
    `"center": ${pt(s.center)}, "ccw": ${s.ccw === false ? 'False' : 'True'}}`
  );
}

const segList = (segs, indent) =>
  segs.map((s) => `${indent}${seg(s)},`).join('\n');

function emitSections(plan) {
  const out = [];
  out.push(
    plan.sections.length > 1
      ? `# The piece boundary, drawn at ${plan.sections.length} heights across the width.`
      : '# The piece boundary.'
  );
  if (plan.sections.length > 1) {
    out.push('# Consecutive sections are lofted; they are congruent by construction,');
    out.push('# entity for entity, so the surface between them is well defined.');
  }
  out.push('SECTIONS = [');
  plan.sections.forEach((sec, i) => {
    if (plan.sections.length > 1) {
      out.push(`    # section ${i + 1} of ${plan.sections.length}, z = ${fmt(sec.z)}`);
    }
    if (sec.kind === 'circle') {
      out.push(`    {"z": ${fmt(sec.z)}, "kind": "circle", "r": ${fmt(sec.r)}},`);
    } else {
      out.push(`    {"z": ${fmt(sec.z)}, "kind": "${sec.kind}", "segs": [`);
      out.push(segList(sec.segs, '        '));
      out.push('    ]},');
    }
  });
  out.push(']');
  return out.join('\n');
}

function emitCutter(c) {
  // The tire is the one tool that is not a prism: its loop is drawn in the
  // (r, z) half-plane and swept about the wheel axis, so it carries no z-range
  // of its own — the profile already says where it starts and stops.
  if (c.shape === 'revolve') {
    return [
      `    {"shape": "revolve", "seam": ${fmt(c.seam ?? 0)}, "segs": [`,
      segList(c.segs, '        '),
      '    ]},',
    ];
  }
  const z = `"z0": ${fmt(c.z0)}, "z1": ${fmt(c.z1)}`;
  if (c.shape === 'circle') {
    return [`    {"shape": "circle", "c": ${pt(c.c)}, "r": ${fmt(c.r)}, ${z}},`];
  }
  if (c.shape === 'poly') {
    return [`    {"shape": "poly", "pts": ${pts(c.pts)}, ${z}},`];
  }
  return [
    `    {"shape": "path", ${z}, "segs": [`,
    segList(c.segs, '        '),
    '    ]},',
  ];
}

function emitCutters(piece) {
  const out = [];
  out.push('# Prisms subtracted from the blank. z0/z1 are the depth range of the');
  out.push('# cut; anything spanning the full width is extended past both faces.');
  if (!piece.cutters.length) {
    out.push('CUTTERS = []');
    return out.join('\n');
  }
  out.push('CUTTERS = [');
  let lastId = null;
  for (const c of piece.cutters) {
    // Cutters arrive grouped (bore, bolt1..n, web voids); label each run once
    // rather than repeating "web void" forty times.
    const family = String(c.id || '').replace(/\d+$/, '');
    if (family !== lastId) {
      out.push(`    # ${family || c.id}`);
      lastId = family;
    }
    out.push(...emitCutter(c));
  }
  out.push(']');
  return out.join('\n');
}

// File stem of one body of one piece. `zone_stem` in wheelwright_occ.py is the
// other half of this: the manifest and the assembly guide have to name the
// files the kernel is going to write, so the two spellings have to agree.
export const zoneStem = (label, zone) => `piece-${label}-${zone.key}-${zone.material}`;

// Where the piece gets cut into one body per filament. Only emitted for a
// wheel that has more than one — a single-material piece is a single solid and
// never goes near the extra boolean.
function zoneLines(plan) {
  return [
    '# One body per filament, from the axle out. Neighbouring bodies share their',
    '# boundary cylinder exactly — no gap and no overlap — so a slicer can load',
    '# them as the parts of one object and give each part its own extruder.',
    'ZONES = [',
    ...plan.zones.map(
      (z) =>
        `    {"key": "${z.key}", "material": "${z.material}", ` +
        `"r0": ${fmt(z.r0)}, "r1": ${fmt(z.r1)}, "seam": ${fmt(z.seam)}},`
    ),
    ']',
  ];
}

// Human-readable one-liner for the tread and the tire's cross-section.
function treadDesc(plan) {
  const t = plan.treadInfo;
  const bits = [`${t.style} tread`];
  if (t.bars) bits.push(`${t.bars} bars${t.barAngle ? ` at ${fmt(t.barAngle)}°` : ''}`);
  if (t.ribs) bits.push(`${t.ribs} rib${t.ribs === 1 ? '' : 's'}`);
  const pr = plan.profile;
  if (pr.shape === 'round') bits.push(`round section (R${fmt(pr.crownRadius)})`);
  else if (pr.shape === 'crowned') bits.push(`crowned ${fmt(pr.crownDrop)} mm (R${fmt(pr.crownRadius)})`);
  return bits.join(', ');
}

function boreDesc(b) {
  return {
    plain: `plain bore Ø${fmt(b.diameter)}`,
    keyed: `keyed bore Ø${fmt(b.diameter)} (key ${fmt(b.keyWidth)}×${fmt(b.keyDepth)})`,
    hex: `hex bore ${fmt(b.hexAcrossFlats)} across flats`,
    dbore: `D-bore Ø${fmt(b.diameter)} (flat at ${fmt(b.flatOffset)})`,
    bolt: `${b.boltCount}-bolt Ø${fmt(b.boltHoleDia)} on Ø${fmt(b.boltCircle)} BCD, pilot Ø${fmt(b.pilotDia)}`,
  }[b.type];
}

function emitPiece(plan, piece) {
  const p = plan.params;
  const mm = plan.multiMaterial;
  return [
    `# Wheelwright — 3D-printable segmented wheel`,
    `# Wheel: Ø${fmt(p.diameter)} × ${fmt(p.width)} mm, ${plan.infillInfo.style} web, ` +
      `${treadDesc(plan)}, ${boreDesc(p.bore)}`,
    `# Piece ${piece.label}: print ${piece.count} of ${plan.N} segment${plan.N > 1 ? 's' : ''}` +
      (plan.N > 1
        ? ` (${fmt(plan.segAngle)}° each, slide-together dovetails, ` +
          `${fmt(plan.jointClearance)} mm clearance/side)`
        : ''),
    ...(mm
      ? [
          `# Materials: ${plan.zones.map((z) => `${z.key} ${z.material.toUpperCase()}`).join(', ')}` +
            ` — one file per body, printed together as a single object.`,
        ]
      : []),
    `# Units mm. Piece lies print-ready on the XY plane.`,
    `#`,
    `#   pip install cadquery-ocp`,
    `#   python piece-${piece.label}.py       ->  ` +
      (mm ? `one .stl + .step per body` : `piece-${piece.label}.stl + .step`),
    `#   python build.py .                 ->  every piece at once`,
    ``,
    `from wheelwright_occ import build, ${mm ? 'save_zones' : 'save'}`,
    ``,
    `# Wheel width; the piece is this tall.`,
    `W = ${fmt(plan.W)}`,
    ``,
    emitSections(plan),
    ``,
    emitCutters(piece),
    ``,
    ...(mm ? [...zoneLines(plan), ``] : []),
    `if __name__ == "__main__":`,
    mm
      ? `    for path in save_zones(build(SECTIONS, CUTTERS, W), ZONES, W, "piece-${piece.label}"):`
      : `    for path in save(build(SECTIONS, CUTTERS, W), "piece-${piece.label}"):`,
    `        print("wrote", path)`,
    ``,
  ].join('\n');
}

// "PETG" for a single-material wheel, "PETG hub-web + TPU tread" for one that
// is printed in more than one.
function materialDesc(plan) {
  return plan.multiMaterial
    ? plan.zones.map((z) => `${z.material.toUpperCase()} ${z.key}`).join(' + ')
    : plan.zones[0].material.toUpperCase();
}

// The multi-material half of the guide: what each body is, how to get the
// bodies of one piece into a slicer as one object, and what that costs.
function materialsSection(plan) {
  const n = plan.zones.length;
  const first = plan.uniquePieces[0].label;
  // Filament changes, as a printer that carries one nozzle would see them.
  // The bodies are rings about the axle and the piece stands on its side face,
  // so every layer crosses every one of them — this is not a cost that can be
  // sliced away, and it is worth knowing before the spool runs out.
  const layers = Math.round(plan.W / 0.2);
  const out = [];
  out.push(`## Materials`);
  out.push('');
  out.push(
    `Every piece prints as **${n} bodies**, one per filament, split at cylinders ` +
      `concentric with the axle. Neighbouring bodies share their boundary face exactly — ` +
      `no gap, no overlap — so they belong in the slicer as the parts of one object, not ` +
      `as separate prints.`
  );
  out.push('');
  out.push(`| Body | Filament | Band (Ø mm) | Files (piece ${first}) |`);
  out.push(`|---|---|---|---|`);
  for (const z of plan.zones) {
    out.push(
      `| ${z.key} | **${z.material.toUpperCase()}** | ${mm1(z.r0 * 2)} – ` +
        `${mm1(Math.min(z.r1, plan.radii.R) * 2)} | \`${zoneStem(first, z)}.stl\` + \`.step\` |`
    );
  }
  out.push('');
  out.push(`### Slicing it`);
  out.push('');
  out.push(
    `1. Select the ${n} files belonging to **one** piece and import them together. ` +
      `PrusaSlicer, OrcaSlicer and Bambu Studio all ask whether to load them as a single ` +
      `object with multiple parts — say yes. (Otherwise load one, then right-click it → ` +
      `*Add part* → *Load…* for the rest.)`
  );
  out.push(`2. Give each part its filament: ${plan.zones.map((z) => `${z.key} → ${z.material.toUpperCase()}`).join(', ')}.`);
  out.push(
    `3. Do not move the parts. They are already in the same coordinate frame and touching ` +
      `exactly; nudging one apart leaves a void the slicer will happily print around.`
  );
  out.push(
    `4. Repeat for each remaining piece — the pieces are separate objects, and each carries ` +
      `its own complete set of bodies.`
  );
  out.push('');
  out.push(
    `**What it costs.** The bodies are rings, and the piece prints lying flat, so *every ` +
      `layer crosses every one of them*. A single-nozzle multi-material printer (AMS, MMU) ` +
      `therefore changes filament at least ${n - 1}× per layer — roughly ${layers * (n - 1)} ` +
      `changes over the ${fmt(plan.W)} mm height at a 0.2 mm layer — and purges at each one. ` +
      `Budget the purge (it can exceed the wheel), or use a printer with independent tool ` +
      `heads, where a change is nearly free.`
  );
  out.push('');
  out.push(`### Where the materials meet`);
  out.push('');
  for (const f of plan.interfaces) {
    const verdict = { weld: 'welds', good: 'bonds well', weak: 'bonds poorly' }[f.level];
    out.push(
      `- **${f.inner.toUpperCase()} → ${f.outer.toUpperCase()}** at Ø${mm1(f.r * 2)} mm — ` +
        `*${verdict}.* ${f.why}`
    );
  }
  out.push('');
  out.push(
    `That interface is a plain cylinder, so it carries the load in shear: everything the ` +
      `tread does to the ground it does through it. It is as strong as the weld between the ` +
      `two filaments and no stronger — which is why the pairing matters more here than it ` +
      `does on a decorative two-colour print.`
  );
  out.push('');
  return out;
}

function assemblyGuide(plan) {
  const p = plan.params;
  const lines = [];
  lines.push(`# Wheelwright assembly guide`);
  lines.push('');
  lines.push(
    `Wheel: **Ø${fmt(p.diameter)} × ${fmt(p.width)} mm** — ${plan.infillInfo.style} web, ` +
      `${treadDesc(plan)}, ${p.bore.type} hub, ${materialDesc(plan)}.`
  );
  lines.push('');
  if (plan.profile.shape !== 'flat') {
    lines.push(
      `The tread is ${plan.profile.shape === 'round' ? 'a full round section' : 'crowned'}: ` +
        `Ø${fmt(p.diameter)} at mid-width, falling to Ø${fmt(plan.profile.shoulderR * 2)} at each ` +
        `shoulder. The piece is lofted through ${plan.sections.length} profiles rather than extruded.`
    );
    lines.push('');
  }
  lines.push(`## Pieces`);
  lines.push('');
  lines.push(`| Source | Print qty | Footprint (mm) |`);
  lines.push(`|---|---|---|`);
  for (const u of plan.uniquePieces) {
    lines.push(`| piece-${u.label}.py | ${u.count} | ${plan.bbox.w} × ${plan.bbox.d} × ${plan.W} |`);
  }
  lines.push('');
  if (plan.multiMaterial) lines.push(...materialsSection(plan));
  lines.push(`## Building the STLs`);
  lines.push('');
  lines.push('This bundle builds itself — it carries the same geometry code the app runs:');
  lines.push('');
  lines.push('```sh');
  lines.push('pip install cadquery-ocp');
  lines.push('python build.py .');
  lines.push('```');
  lines.push('');
  lines.push(
    'That writes a `.stl` (for slicing) and a `.step` (for CAD — FreeCAD, Fusion, ' +
      'SolidWorks, Onshape all open it) next to each source file. `python build.py . ' +
      '--formats stl` skips the STEP files.'
  );
  lines.push('');
  lines.push(`## Print settings (starting point)`);
  lines.push('');
  lines.push(`- Orientation: ${plan.printRec.orientation}`);
  // A wheel in two filaments wants two sets of settings, and a slicer takes
  // them per part — so they are listed per filament rather than averaged into
  // one recommendation that suits neither.
  for (const r of plan.printRec.byMaterial || [plan.printRec]) {
    const who = plan.printRec.byMaterial ? `**${r.material.toUpperCase()}** — ` : '';
    lines.push(`- ${who}${r.walls} walls, ${r.infillPct}% ${r.infillPattern}. ${r.note}`);
  }
  lines.push('');
  if (plan.N > 1) {
    lines.push(`## Assembly`);
    lines.push('');
    lines.push(
      `Segments join with axial slide dovetails (${fmt(plan.jointClearance)} mm clearance per ` +
        `side): each piece's tenons slide into the next piece's pockets along the wheel's axis.`
    );
    lines.push('');
    // Numbered from the list rather than in the strings. A multi-material
    // wheel loses one step and gains a sub-list, and hand-written numbers go
    // out of step the moment that happens.
    //
    // Every seam runs through every zone, and a zone only ever meets its own
    // kind — so a wheel in two filaments has two glue-ups, not one.
    const perJoint = plan.glue.perJoint;
    const steps = [
      [
        `Dry-fit all ${plan.N} segments first. Dovetails should slide with light hand pressure; ` +
          `if tight, scale the piece 100.2% in your slicer or lightly file the tenons.`,
      ],
      [
        `**Adhesive — ${plan.glue.name}.** ${plan.glue.why}`,
        ...(perJoint || []).map(
          (j) =>
            `   - the **${j.tag}** dovetail is ${j.material.toUpperCase()} on both sides — ` +
            `${j.name}. ${j.tips}`
        ),
      ],
      // The per-joint bullets carry their own instructions; the governing
      // adhesive's would be a third telling of the same thing.
      ...(perJoint ? [] : [[plan.glue.tips]]),
      [
        `Slide segments together one at a time on a flat surface, working around the circle. ` +
          `The last segment drops in axially.`,
      ],
      [`Check the wheel is flat, wipe squeeze-out, and let the adhesive cure fully before loading.`],
      [
        p.bore.type === 'bolt'
          ? `Bolting through the hub (${p.bore.boltCount}× on Ø${fmt(p.bore.boltCircle)} BCD) ` +
            `clamps the segments axially — snug evenly in a star pattern.`
          : `Axial retention comes from the adhesive plus your shaft hardware (collars/washers) — ` +
            `don't rely on the dovetails alone axially.`,
      ],
    ];
    steps.forEach(([head, ...rest], i) => {
      lines.push(`${i + 1}. ${head}`);
      for (const extra of rest) lines.push(extra);
    });
    lines.push('');
  }
  const warn = [...plan.warnings];
  if (warn.length) {
    lines.push('## Warnings');
    lines.push('');
    for (const w of warn) lines.push(`- ${w}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function slugFor(plan) {
  const p = plan.params;
  return `wheel-d${Math.round(p.diameter)}-w${Math.round(p.width)}-${p.bore.type}-${plan.N}seg`;
}

// Files that make a bundle self-contained. The server reads them off disk, the
// browser fetches them from /lib/occ — either way they are the same bytes the
// app itself runs, so a downloaded bundle cannot silently drift from it.
export const RUNTIME_FILES = ['wheelwright_occ.py', 'build.py'];

/**
 * plan → the file list of a bundle.
 * @param {object} plan     from planWheel()
 * @param {object} runtime  { 'wheelwright_occ.py': source, 'build.py': source }
 */
export function generateSource(plan, runtime = {}) {
  const files = [];
  for (const u of plan.uniquePieces) {
    files.push({ name: `piece-${u.label}.py`, kind: 'source', content: emitPiece(plan, u) });
  }
  for (const name of RUNTIME_FILES) {
    if (runtime[name]) files.push({ name, kind: 'runtime', content: runtime[name] });
  }
  files.push({ name: 'ASSEMBLY.md', kind: 'doc', content: assemblyGuide(plan) });
  files.push({
    name: 'wheelwright.json',
    kind: 'manifest',
    content: JSON.stringify(
      {
        app: 'wheelwright',
        generated: new Date().toISOString(),
        params: plan.params,
        segments: plan.N,
        segAngle: plan.segAngle,
        // A single-material piece is one solid and names its two files
        // directly; a multi-material one names the body files the kernel
        // writes for it, in the order they stack outward from the axle.
        ...(plan.multiMaterial ? { materialZones: plan.zones } : {}),
        pieces: plan.uniquePieces.map((u) => ({
          source: `piece-${u.label}.py`,
          printQty: u.count,
          ...(plan.multiMaterial
            ? {
                bodies: plan.zones.map((z) => ({
                  zone: z.key,
                  material: z.material,
                  stl: `${zoneStem(u.label, z)}.stl`,
                  step: `${zoneStem(u.label, z)}.step`,
                })),
              }
            : { stl: `piece-${u.label}.stl`, step: `piece-${u.label}.step` }),
        })),
        pieceFootprintMm: { w: plan.bbox.w, d: plan.bbox.d, h: plan.W },
        warnings: plan.warnings,
        notes: plan.notes,
      },
      null,
      2
    ),
  });
  return files;
}
