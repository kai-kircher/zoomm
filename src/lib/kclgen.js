// Wheelwright — KCL code generator.
//
// Emits modern solver-sketch KCL (the same dialect Zoo's shipping samples
// use, pinned to kclVersion 1.0) with exact fixed coordinates — every number
// is precomputed by the planner, so no constraints are needed and the engine
// has nothing to solve. Geometry uses only the most battle-tested ops:
// sketch blocks, region(), extrude(), loft(), offsetPlane() and subtract().
//
// One .kcl file per *unique* piece: most wheels are "print piece A × 6";
// hub features (keyway, D-flat, bolt holes) can make one or two variants.
//
// Booleans are the scarce resource here, not entity count. Zoo's engine gets
// slow and then unreliable as the tool list grows — the demo wheel's twelve
// cutters took ~80 s, and busier wheels came back "Batch edit result is not
// valid" or dropped the connection outright. So every cut that runs the full
// depth of the piece — bore, keyway, bolt holes, every web void, every tread
// bar — is emitted as another *loop in the same sketch* and resolved by
// region(), which the engine does in one pass. Measured on the demo wheel:
// 80 s of booleans → 3 s of sketch. Only genuinely partial-depth cuts
// (circumferential grooves on a flat tread) are left as subtract tools.
//
// A crowned piece is lofted through one such sketch per z level instead of
// extruded. That is also forced: the engine rejects any boolean whose
// operands have curved faces, so a crown can never be cut in — it has to be
// in the profile from the start.

const SUBTRACT_BATCH = 12;

// Six decimals — a thousandth of a micron. Coordinates are printed finer than
// anything prints or measures because the engine solves each arc from its
// endpoints and centre: an endpoint a rounding step off its own radius is an
// arc that does not quite close, and a profile is only as closed as its worst
// entity. See snapLoop below.
function fmt(v) {
  if (!Number.isFinite(v)) return '0';
  let x = Math.round(v * 1e6) / 1e6;
  if (Object.is(x, -0)) x = 0;
  return String(x);
}
const pt = ([x, y]) => `[${fmt(x)}, ${fmt(y)}]`;

// Put a point exactly on the circle (c, r) it is meant to lie on.
function onCircle(p, c, r) {
  const dx = p[0] - c[0];
  const dy = p[1] - c[1];
  const L = Math.hypot(dx, dy) || 1;
  return [c[0] + (dx / L) * r, c[1] + (dy / L) * r];
}

// The planner rounds its coordinates to a micron for legibility, which leaves
// every arc endpoint a fraction of that off the exact radius. One arc absorbs
// it; a rim carrying fifty tread-bar arcs, or a filleted honeycomb cell with
// twelve, does not — the engine gives up with "Cannot close a path that is
// non-planar or with duplicate vertices" or "Unable to create a region that
// contains the requested query point". Snap each arc end onto its own circle
// and hand the corrected vertex to the neighbouring segment, so the loop
// comes out both watertight and exactly circular.
function snapLoop(segs) {
  const n = segs.length;
  const v = segs.map((s) => [...s.a]);
  segs.forEach((s, i) => {
    if (s.kind !== 'arc') return;
    v[i] = onCircle(s.a, s.center, s.radius);
    v[(i + 1) % n] = onCircle(s.b, s.center, s.radius);
  });
  return segs.map((s, i) => ({ ...s, a: v[i], b: v[(i + 1) % n] }));
}

function emitPathEntities(rawSegs, prefix = 'e', indent = '  ') {
  const lines = [];
  const segs = snapLoop(rawSegs);
  segs.forEach((s, i) => {
    const name = `${prefix}${i + 1}`;
    if (s.kind === 'line') {
      lines.push(`${indent}${name} = line(start = ${pt(s.a)}, end = ${pt(s.b)})`);
    } else {
      // KCL solver arcs always sweep CCW from start to end; swap endpoints
      // for segments our planner walked clockwise.
      const a = s.ccw ? s.a : s.b;
      const b = s.ccw ? s.b : s.a;
      lines.push(`${indent}${name} = arc(start = ${pt(a)}, end = ${pt(b)}, center = ${pt(s.center)})`);
    }
  });
  return lines;
}

// A cutter's boundary as a plain segment loop, or null when it is a circle
// (which KCL draws with a single entity).
function loopOf(c) {
  if (c.shape === 'poly') return c.pts.map((q, i) => ({ kind: 'line', a: q, b: c.pts[(i + 1) % c.pts.length] }));
  if (c.shape === 'path') return c.segs;
  return null;
}

// A cut that spans the whole piece is a hole in the profile, not a tool.
const isThrough = (c, W) => c.shape !== 'annulus' && c.z0 <= 0 && c.z1 >= W;

// One section: the piece's boundary at height z plus every through-hole, all
// in a single sketch, resolved to the material face by its seed point.
function emitSection(sec, holes, idx) {
  const sk = `sec${idx + 1}Sk`;
  const prof = `sec${idx + 1}`;
  const plane = sec.z === 0 ? 'XY' : `offsetPlane(XY, offset = ${fmt(sec.z)})`;
  const out = [`${sk} = sketch(on = ${plane}) {`];
  if (sec.kind === 'circle') out.push(`  rim = circle(start = ${pt([sec.r, 0])}, center = [0, 0])`);
  else out.push(...emitPathEntities(sec.segs));
  holes.forEach((c, i) => {
    if (c.shape === 'circle') {
      out.push(`  h${i + 1} = circle(start = ${pt([c.c[0] + c.r, c.c[1]])}, center = ${pt(c.c)})`);
    } else {
      out.push(...emitPathEntities(loopOf(c), `h${i + 1}_`));
    }
  });
  out.push('}');
  out.push(
    sec.kind === 'circle' && !holes.length
      ? `${prof} = region(segments = [${sk}.rim])`
      : `${prof} = region(point = ${pt(sec.interior)}, sketch = ${sk})`
  );
  out.push(`hide(${sk})`);
  return { code: out.join('\n'), varName: prof };
}

// Emit one cutter prism: sketch on an offset plane + region + extrude.
// Returns { code, varName }.
function emitCutter(cutter, idx, W) {
  const base = `cut${idx + 1}`;
  const sk = `${base}Sk`;
  const z0 = cutter.z0;
  const len = cutter.z1 - cutter.z0;
  const plane = z0 === 0 ? 'XY' : `offsetPlane(XY, offset = ${fmt(z0)})`;
  const out = [];
  out.push(`${sk} = sketch(on = ${plane}) {`);
  let regionExpr;
  if (cutter.shape === 'circle') {
    out.push(`  c1 = circle(start = ${pt([cutter.c[0] + cutter.r, cutter.c[1]])}, center = ${pt(cutter.c)})`);
    out.push(`}`);
    regionExpr = `region(segments = [${sk}.c1])`;
  } else if (cutter.shape === 'annulus') {
    out.push(`  outer = circle(start = ${pt([cutter.rOut, 0])}, center = [0, 0])`);
    out.push(`  inner = circle(start = ${pt([cutter.rIn, 0])}, center = [0, 0])`);
    out.push(`}`);
    regionExpr = `region(point = ${pt([(cutter.rIn + cutter.rOut) / 2, 0])}, sketch = ${sk})`;
  } else if (cutter.shape === 'poly') {
    const n = cutter.pts.length;
    for (let i = 0; i < n; i++) {
      const a = cutter.pts[i];
      const b = cutter.pts[(i + 1) % n];
      out.push(`  e${i + 1} = line(start = ${pt(a)}, end = ${pt(b)})`);
    }
    out.push(`}`);
    const cx = cutter.pts.reduce((s, q) => s + q[0], 0) / n;
    const cy = cutter.pts.reduce((s, q) => s + q[1], 0) / n;
    regionExpr = `region(point = ${pt([cx, cy])}, sketch = ${sk})`;
  } else {
    // 'path' — closed loop of lines and arcs with a known interior point
    out.push(...emitPathEntities(cutter.segs, 'e'));
    out.push(`}`);
    regionExpr = `region(point = ${pt(cutter.interior)}, sketch = ${sk})`;
  }
  out.push(`${base} = extrude(${regionExpr}, length = ${fmt(len)})`);
  out.push(`hide(${sk})`);
  return { code: out.join('\n'), varName: base };
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

function headerComment(plan, piece) {
  const p = plan.params;
  const b = p.bore;
  const boreDesc = {
    plain: `plain bore Ø${fmt(b.diameter)}`,
    keyed: `keyed bore Ø${fmt(b.diameter)} (key ${fmt(b.keyWidth)}×${fmt(b.keyDepth)})`,
    hex: `hex bore ${fmt(b.hexAcrossFlats)} across flats`,
    dbore: `D-bore Ø${fmt(b.diameter)} (flat at ${fmt(b.flatOffset)})`,
    bolt: `${b.boltCount}-bolt Ø${fmt(b.boltHoleDia)} on Ø${fmt(b.boltCircle)} BCD, pilot Ø${fmt(b.pilotDia)}`,
  }[b.type];
  return [
    `// Wheelwright — 3D-printable segmented wheel`,
    `// Wheel: Ø${fmt(p.diameter)} × ${fmt(p.width)} mm, ${plan.infillInfo.style} web, ${treadDesc(plan)}, ${boreDesc}`,
    `// Piece ${piece.label}: print ${piece.count} of ${plan.N} segment${plan.N > 1 ? 's' : ''}` +
      (plan.N > 1 ? ` (${fmt(plan.segAngle)}° each, slide-together dovetails, ${fmt(plan.jointClearance)} mm clearance/side)` : ''),
    `// Units mm. Piece lies print-ready on the XY plane.`,
    ``,
    `@settings(defaultLengthUnit = mm, kclVersion = 1.0)`,
  ].join('\n');
}

function emitPiece(plan, piece) {
  const W = plan.W;
  const out = [headerComment(plan, piece), ''];
  const holes = piece.cutters.filter((c) => isThrough(c, W));
  const tools = piece.cutters.filter((c) => !isThrough(c, W));
  const sections = plan.sections;

  // --- profile sections ---
  out.push(
    sections.length > 1
      ? `// Piece profile, drawn at ${sections.length} heights across the width.`
      : '// Piece profile.'
  );
  out.push('// Dovetails, bore, web voids and tread bars are all loops in the');
  out.push('// same sketch; region() picks out the material face between them.');
  const profs = [];
  sections.forEach((sec, i) => {
    if (sections.length > 1) out.push(`// section ${i + 1} of ${sections.length}, z = ${fmt(sec.z)}`);
    const { code, varName } = emitSection(sec, holes, i);
    out.push(code, '');
    profs.push(varName);
  });

  if (profs.length > 1) {
    out.push(`// The crown is lofted through the sections — it cannot be cut in:`);
    out.push(`// the engine refuses booleans on solids with curved faces.`);
    out.push(`blank = loft([${profs.join(', ')}])`);
  } else {
    out.push(`blank = extrude(${profs[0]}, length = ${fmt(W)})`);
  }
  out.push('');

  // --- partial-depth cutters (circumferential grooves) ---
  const vars = [];
  tools.forEach((c, i) => {
    out.push(`// cutter: ${c.id}`);
    const { code, varName } = emitCutter(c, i, W);
    out.push(code, '');
    vars.push(varName);
  });

  // --- subtract in batches ---
  if (vars.length === 0) {
    out.push('piece = blank');
  } else {
    let body = 'blank';
    for (let i = 0; i < vars.length; i += SUBTRACT_BATCH) {
      const batch = vars.slice(i, i + SUBTRACT_BATCH);
      const next = i + SUBTRACT_BATCH >= vars.length ? 'piece' : `body${Math.floor(i / SUBTRACT_BATCH) + 1}`;
      out.push(`${next} = subtract([${body}], tools = [${batch.join(', ')}])`);
      body = next;
    }
  }
  out.push('');
  return out.join('\n');
}

function assemblyGuide(plan) {
  const p = plan.params;
  const lines = [];
  lines.push(`# Wheelwright assembly guide`);
  lines.push('');
  lines.push(`Wheel: **Ø${fmt(p.diameter)} × ${fmt(p.width)} mm** — ${plan.infillInfo.style} web, ${treadDesc(plan)}, ${p.bore.type} hub, ${p.material.toUpperCase()}.`);
  lines.push('');
  if (plan.profile.shape !== 'flat') {
    lines.push(
      `The tread is ${plan.profile.shape === 'round' ? 'a full round section' : 'crowned'}: Ø${fmt(p.diameter)} at mid-width, ` +
        `falling to Ø${fmt(plan.profile.shoulderR * 2)} at each shoulder. The piece is lofted through ${plan.sections.length} profiles rather than extruded, ` +
        `so expect the export to take a few minutes per piece — curved faces cost the engine far more than flat ones.`
    );
    lines.push('');
  }
  lines.push(`## Pieces`);
  lines.push('');
  lines.push(`| File | Print qty | Footprint (mm) |`);
  lines.push(`|---|---|---|`);
  for (const u of plan.uniquePieces) {
    lines.push(`| piece-${u.label}.kcl | ${u.count} | ${plan.bbox.w} × ${plan.bbox.d} × ${plan.W} |`);
  }
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
    lines.push(`Segments join with axial slide dovetails (${fmt(plan.jointClearance)} mm clearance per side): each piece's tenons slide into the next piece's pockets along the wheel's axis.`);
    lines.push('');
    lines.push(`1. Dry-fit all ${plan.N} segments first. Dovetails should slide with light hand pressure; if tight, scale the piece 100.2% in your slicer or lightly file the tenons.`);
    lines.push(`2. **Adhesive — ${plan.glue.name}.** ${plan.glue.why}`);
    lines.push(`3. ${plan.glue.tips}`);
    lines.push(`4. Slide segments together one at a time on a flat surface, working around the circle. The last segment drops in axially.`);
    lines.push(`5. Check the wheel is flat, wipe squeeze-out, and let the adhesive cure fully before loading.`);
    if (p.bore.type === 'bolt') {
      lines.push(`6. Bolting through the hub (${p.bore.boltCount}× on Ø${fmt(p.bore.boltCircle)} BCD) clamps the segments axially — snug evenly in a star pattern.`);
    } else {
      lines.push(`6. Axial retention comes from the adhesive plus your shaft hardware (collars/washers) — don't rely on the dovetails alone axially.`);
    }
    lines.push('');
  }
  lines.push(`## Export to STL`);
  lines.push('');
  lines.push('With the [Zoo CLI](https://zoo.dev/docs/developer-tools/cli) and a `ZOO_API_TOKEN`:');
  lines.push('');
  lines.push('```sh');
  for (const u of plan.uniquePieces) {
    lines.push(`zoo kcl export --output-format=stl piece-${u.label}.kcl .`);
  }
  lines.push('```');
  lines.push('');
  lines.push('Or open each `.kcl` file in [Zoo Design Studio](https://zoo.dev/design-studio) and export from there.');
  lines.push('');
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

export function generateKcl(plan) {
  const files = [];
  for (const u of plan.uniquePieces) {
    files.push({ name: `piece-${u.label}.kcl`, kind: 'kcl', content: emitPiece(plan, u) });
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
        pieces: plan.uniquePieces.map((u) => ({ file: `piece-${u.label}.kcl`, printQty: u.count })),
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
