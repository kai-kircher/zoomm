// Wheelwright — KCL code generator.
//
// Emits modern solver-sketch KCL (the same dialect Zoo's shipping samples
// use, pinned to kclVersion 1.0) with exact fixed coordinates — every number
// is precomputed by the planner, so no constraints are needed and the engine
// has nothing to solve. Geometry uses only the most battle-tested ops:
// sketch blocks, region(), extrude(), offsetPlane() and subtract().
//
// One .kcl file per *unique* piece: most wheels are "print piece A × 6";
// hub features (keyway, D-flat, bolt holes) can make one or two variants.

const SUBTRACT_BATCH = 12;

function fmt(v) {
  if (!Number.isFinite(v)) return '0';
  let x = Math.round(v * 1e4) / 1e4;
  if (Object.is(x, -0)) x = 0;
  return String(x);
}
const pt = ([x, y]) => `[${fmt(x)}, ${fmt(y)}]`;

function emitPathEntities(segs, indent = '  ') {
  const lines = [];
  segs.forEach((s, i) => {
    const name = `e${i + 1}`;
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
    out.push(...emitPathEntities(cutter.segs));
    out.push(`}`);
    regionExpr = `region(point = ${pt(cutter.interior)}, sketch = ${sk})`;
  }
  out.push(`${base} = extrude(${regionExpr}, length = ${fmt(len)})`);
  out.push(`hide(${sk})`);
  return { code: out.join('\n'), varName: base };
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
    `// Wheel: Ø${fmt(p.diameter)} × ${fmt(p.width)} mm, ${plan.infillInfo.style} web, ${p.tread} tread, ${boreDesc}`,
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

  // --- outline ---
  out.push('// Piece outline (dovetail tenons and pockets are part of the profile)');
  out.push('outlineSk = sketch(on = XY) {');
  let regionExpr;
  if (plan.outline.kind === 'circle') {
    out.push(`  rim = circle(start = ${pt([plan.outline.r, 0])}, center = [0, 0])`);
    out.push('}');
    regionExpr = 'region(segments = [outlineSk.rim])';
  } else {
    out.push(...emitPathEntities(plan.outline.segs));
    out.push('}');
    regionExpr = `region(point = ${pt(plan.outline.interior)}, sketch = outlineSk)`;
  }
  out.push(`blank = extrude(${regionExpr}, length = ${fmt(W)})`);
  out.push('hide(outlineSk)');
  out.push('');

  // --- cutters ---
  const vars = [];
  piece.cutters.forEach((c, i) => {
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
  lines.push(`Wheel: **Ø${fmt(p.diameter)} × ${fmt(p.width)} mm** — ${plan.infillInfo.style} web, ${p.tread} tread, ${p.bore.type} hub, ${p.material.toUpperCase()}.`);
  lines.push('');
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
