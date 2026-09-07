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
  return [
    `# Wheelwright — 3D-printable segmented wheel`,
    `# Wheel: Ø${fmt(p.diameter)} × ${fmt(p.width)} mm, ${plan.infillInfo.style} web, ` +
      `${treadDesc(plan)}, ${boreDesc(p.bore)}`,
    `# Piece ${piece.label}: print ${piece.count} of ${plan.N} segment${plan.N > 1 ? 's' : ''}` +
      (plan.N > 1
        ? ` (${fmt(plan.segAngle)}° each, slide-together dovetails, ` +
          `${fmt(plan.jointClearance)} mm clearance/side)`
        : ''),
    `# Units mm. Piece lies print-ready on the XY plane.`,
    `#`,
    `#   pip install cadquery-ocp`,
    `#   python piece-${piece.label}.py       ->  piece-${piece.label}.stl + .step`,
    `#   python build.py .                 ->  every piece at once`,
    ``,
    `from wheelwright_occ import build, save`,
    ``,
    `# Wheel width; the piece is this tall.`,
    `W = ${fmt(plan.W)}`,
    ``,
    emitSections(plan),
    ``,
    emitCutters(piece),
    ``,
    `if __name__ == "__main__":`,
    `    for path in save(build(SECTIONS, CUTTERS, W), "piece-${piece.label}"):`,
    `        print("wrote", path)`,
    ``,
  ].join('\n');
}

function assemblyGuide(plan) {
  const p = plan.params;
  const lines = [];
  lines.push(`# Wheelwright assembly guide`);
  lines.push('');
  lines.push(
    `Wheel: **Ø${fmt(p.diameter)} × ${fmt(p.width)} mm** — ${plan.infillInfo.style} web, ` +
      `${treadDesc(plan)}, ${p.bore.type} hub, ${p.material.toUpperCase()}.`
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
  lines.push(`- Walls/perimeters: ${plan.printRec.walls}`);
  lines.push(`- Infill: ${plan.printRec.infillPct}% ${plan.printRec.infillPattern}`);
  lines.push(`- ${plan.printRec.note}`);
  lines.push('');
  if (plan.N > 1) {
    lines.push(`## Assembly`);
    lines.push('');
    lines.push(
      `Segments join with axial slide dovetails (${fmt(plan.jointClearance)} mm clearance per ` +
        `side): each piece's tenons slide into the next piece's pockets along the wheel's axis.`
    );
    lines.push('');
    lines.push(
      `1. Dry-fit all ${plan.N} segments first. Dovetails should slide with light hand pressure; ` +
        `if tight, scale the piece 100.2% in your slicer or lightly file the tenons.`
    );
    lines.push(`2. **Adhesive — ${plan.glue.name}.** ${plan.glue.why}`);
    lines.push(`3. ${plan.glue.tips}`);
    lines.push(
      `4. Slide segments together one at a time on a flat surface, working around the circle. ` +
        `The last segment drops in axially.`
    );
    lines.push(
      `5. Check the wheel is flat, wipe squeeze-out, and let the adhesive cure fully before loading.`
    );
    if (p.bore.type === 'bolt') {
      lines.push(
        `6. Bolting through the hub (${p.bore.boltCount}× on Ø${fmt(p.bore.boltCircle)} BCD) ` +
          `clamps the segments axially — snug evenly in a star pattern.`
      );
    } else {
      lines.push(
        `6. Axial retention comes from the adhesive plus your shaft hardware (collars/washers) — ` +
          `don't rely on the dovetails alone axially.`
      );
    }
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
        pieces: plan.uniquePieces.map((u) => ({
          source: `piece-${u.label}.py`,
          stl: `piece-${u.label}.stl`,
          step: `piece-${u.label}.step`,
          printQty: u.count,
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
