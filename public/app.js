// Wheelwright UI — gathers params, replans live (same planner module the
// server uses), drives the preview, and handles source/STL downloads.

import { planWheel, DEFAULTS } from '../src/lib/wheel.js';
import { convertFormUnits, fromMm, isLengthInput } from '../src/lib/units.js';
import { generateSource, slugFor, RUNTIME_FILES } from '../src/lib/occgen.js';
import { createPreview, MATERIAL_COLORS, cssColor } from './preview.js';
import { enableScrub } from './scrub.js';

const $ = (id) => document.getElementById(id);

// The Python that makes a downloaded bundle self-building. Fetched from the
// same /lib the server reads off disk, so the per-file links below hand out
// exactly the bytes the server would have run. Best-effort: on static hosting
// there is nothing to fetch, and the bundle is then source-only.
const runtime = {};
Promise.all(
  RUNTIME_FILES.map((n) =>
    fetch(`../src/lib/occ/${n}`)
      .then((r) => (r.ok ? r.text() : null))
      .then((t) => { if (t) runtime[n] = t; })
      .catch(() => {})
  )
).then(() => { if (plan) renderFileLinks(); });

const PRESETS = {
  cart: {
    units: 'in', diameter: 14, width: 2, material: 'petg', infill: 'spokes', spokeCount: 0,
    tread: 'lugged', treadDepth: 0.14,
    bore: { type: 'keyed', diameter: 0.75, keyWidth: 0.1875, keyDepth: 0.11 },
  },
  rover: {
    units: 'mm', diameter: 260, width: 60, material: 'tpu', infill: 'flexweb',
    tread: 'ribbed', treadDepth: 3,
    bore: { type: 'hex', hexAcrossFlats: 13 },
  },
  caster: {
    units: 'mm', diameter: 160, width: 45, material: 'petg', infill: 'honeycomb',
    tread: 'slick', treadDepth: 2,
    bore: { type: 'bolt', boltCount: 4, boltCircle: 60, boltHoleDia: 5.5, pilotDia: 12 },
  },
  interlaced: {
    units: 'mm', diameter: 260, width: 55, material: 'tpu', infill: 'lattice',
    tread: 'ribbed', treadDepth: 3,
    bore: { type: 'keyed', diameter: 20, keyWidth: 6, keyDepth: 2.8 },
    lattice: { rows: 3, strutWidth: 4, cornerRadius: 2 },
  },
  auxetic: {
    units: 'mm', diameter: 200, width: 40, material: 'tpu', infill: 'auxetic',
    tread: 'lugged', treadDepth: 2.5,
    bore: { type: 'hex', hexAcrossFlats: 13 },
    auxetic: { rings: 2, wall: 2.6, waist: 0.4, cornerRadius: 1.2 },
  },
  graded: {
    units: 'mm', diameter: 200, width: 45, material: 'petg', infill: 'graded',
    tread: 'ribbed', treadDepth: 2.5,
    bore: { type: 'bolt', boltCount: 5, boltCircle: 80, boltHoleDia: 5.5, pilotDia: 30 },
    graded: { rings: 3, wall: 2.6, cellShape: 'hex', grade: 1, swirl: 0, cornerRadius: 1.6 },
  },
  organic: {
    units: 'mm', diameter: 180, width: 40, material: 'petg', infill: 'voronoi',
    tread: 'slick', treadDepth: 2,
    bore: { type: 'bolt', boltCount: 5, boltCircle: 70, boltHoleDia: 5.5, pilotDia: 14 },
    voronoi: { wall: 3, seed: 7, cornerRadius: 1.6 },
  },
  tiny: {
    units: 'mm', diameter: 100, width: 25, material: 'pla', infill: 'spokes',
    tread: 'ribbed', treadDepth: 2,
    bore: { type: 'plain', diameter: 8 },
  },
  dual: {
    units: 'mm', diameter: 200, width: 40, material: 'petg', infill: 'honeycomb',
    materials: { tread: 'tpu', web: 'petg', hub: 'petg' },
    tread: 'lugged', treadDepth: 3,
    bore: { type: 'bolt', boltCount: 4, boltCircle: 60, boltHoleDia: 5.5, pilotDia: 12 },
    honeycomb: { cellSize: 12, wall: 2.4 },
  },
  bike: {
    units: 'mm', diameter: 200, width: 28, material: 'tpu', infill: 'honeycomb',
    tread: 'chevron', treadDepth: 2.2, treadAngle: 35,
    profile: { shape: 'round' },
    bore: { type: 'bolt', boltCount: 5, boltCircle: 60, boltHoleDia: 5, pilotDia: 12 },
    honeycomb: { cellSize: 10, wall: 2.2 },
  },
};

function gather() {
  return {
    units: $('units').value,
    diameter: $('diameter').value,
    width: $('width').value,
    material: $('material').value,
    // Off, the zone selects mirror the wheel's material (see
    // syncZoneMaterials) — but sending nothing says the same thing to the
    // planner more plainly, and keeps a single-material plan single-material
    // even if a stale value is sitting in a hidden select.
    materials: $('multiMaterial').checked
      ? { tread: $('matTread').value, web: $('matWeb').value, hub: $('matHub').value }
      : {},
    infill: $('infill').value,
    spokeCount: $('spokeCount').value,
    tread: $('tread').value,
    treadDepth: $('treadDepth').value,
    treadCount: $('treadCount').value,
    treadAngle: $('treadAngle').value,
    ribCount: $('ribCount').value,
    profile: {
      shape: $('profileShape').value,
      crownDrop: $('crownDrop').value,
    },
    bore: {
      type: $('boreType').value,
      diameter: $('boreDiameter').value,
      keyWidth: $('keyWidth').value,
      keyDepth: $('keyDepth').value,
      hexAcrossFlats: $('hexAcrossFlats').value,
      flatOffset: $('flatOffset').value,
      boltCount: $('boltCount').value,
      boltCircle: $('boltCircle').value,
      boltHoleDia: $('boltHoleDia').value,
      pilotDia: $('pilotDia').value,
    },
    ...Object.fromEntries(
      Object.entries(STYLE_FIELDS).map(([group, fields]) => [
        group,
        Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, $(f.id).value])),
      ])
    ),
    printer: {
      x: $('printerX').value,
      y: $('printerY').value,
      z: $('printerZ').value,
      margin: $('printerMargin').value,
    },
    joint: { clearance: $('jointClearance').value },
    boreClearance: $('boreClearance').value,
    segmentsOverride: $('segmentsOverride').value,
  };
}

// Per-web-style tuning fields, keyed by the planner's parameter group. Which
// of them carry a length is settled once, in /lib/units.js — asking there
// (isLengthInput) keeps the unit switch and the preset defaults agreeing.
const STYLE_FIELDS = {
  honeycomb: {
    cellSize: { id: 'hcCellSize' },
    wall: { id: 'hcWall' },
    orientation: { id: 'hcOrientation' },
    cellShape: { id: 'hcCellShape' },
    cornerRadius: { id: 'hcCornerRadius' },
    maxCells: { id: 'hcMaxCells' },
  },
  lattice: {
    rows: { id: 'ltRows' },
    struts: { id: 'ltStruts' },
    strutWidth: { id: 'ltStrutWidth' },
    cornerRadius: { id: 'ltCornerRadius' },
  },
  auxetic: {
    rings: { id: 'axRings' },
    cellSize: { id: 'axCellSize' },
    wall: { id: 'axWall' },
    waist: { id: 'axWaist' },
    cornerRadius: { id: 'axCornerRadius' },
  },
  graded: {
    rings: { id: 'grRings' },
    cells: { id: 'grCells' },
    wall: { id: 'grWall' },
    cellShape: { id: 'grCellShape' },
    grade: { id: 'grGrade' },
    swirl: { id: 'grSwirl' },
    cornerRadius: { id: 'grCornerRadius' },
  },
  voronoi: {
    cells: { id: 'voCells' },
    wall: { id: 'voWall' },
    seed: { id: 'voSeed' },
    cornerRadius: { id: 'voCornerRadius' },
  },
};

// The form's numbers only mean something together with the units selector, so
// every change of it converts them in place (see /lib/units.js) — otherwise
// the planner re-reads millimetres as inches.
const formStore = {
  get: (id) => $(id).value,
  set: (id, v) => ($(id).value = v),
};
let formUnits = $('units').value;

function setUnits(units) {
  if (units === formUnits) return;
  convertFormUnits(formStore, formUnits, units);
  $('units').value = units;
  formUnits = units;
}

// The three per-zone material selects, keyed by the planner's zone name.
const ZONE_SELECTS = { tread: 'matTread', web: 'matWeb', hub: 'matHub' };

// While the wheel is single-material the zone selects track it, so ticking the
// box shows three selects that already say what the wheel is made of and the
// design does not jump at the moment of ticking.
function syncZoneMaterials() {
  if ($('multiMaterial').checked) return;
  for (const id of Object.values(ZONE_SELECTS)) $(id).value = $('material').value;
}

function applyPreset(p) {
  // Switch units first: that converts everything the form already holds, so
  // the printer envelope and the two clearances — user settings no preset
  // writes — keep the physical size the user gave them. The preset's own
  // numbers land on top afterwards, already in its units.
  setUnits(p.units);
  const flat = {
    diameter: p.diameter, width: p.width, material: p.material,
    infill: p.infill, spokeCount: p.spokeCount ?? 0, tread: p.tread, treadDepth: p.treadDepth,
  };
  for (const [k, v] of Object.entries(flat)) if ($(k) && v !== undefined) $(k).value = v;
  // A preset that says nothing about zones is a single-material wheel, and its
  // zone selects fall back to its material — so switching presets never leaves
  // the last one's TPU tread behind.
  $('multiMaterial').checked = !!p.materials;
  for (const [zone, id] of Object.entries(ZONE_SELECTS)) {
    $(id).value = p.materials?.[zone] || p.material;
  }
  $('boreType').value = p.bore.type;
  const boreMap = {
    diameter: 'boreDiameter', keyWidth: 'keyWidth', keyDepth: 'keyDepth',
    hexAcrossFlats: 'hexAcrossFlats', flatOffset: 'flatOffset', boltCount: 'boltCount',
    boltCircle: 'boltCircle', boltHoleDia: 'boltHoleDia', pilotDia: 'pilotDia',
  };
  for (const [k, id] of Object.entries(boreMap)) if (p.bore[k] !== undefined) $(id).value = p.bore[k];
  // Tread and profile tuning: a preset that says nothing about them falls back
  // to the planner defaults, so switching preset never leaves a stray bar
  // angle or crown behind from the last one.
  $('treadCount').value = p.treadCount ?? DEFAULTS.treadCount;
  $('treadAngle').value = p.treadAngle ?? DEFAULTS.treadAngle;
  $('ribCount').value = p.ribCount ?? DEFAULTS.ribCount;
  $('profileShape').value = p.profile?.shape ?? DEFAULTS.profile.shape;
  $('crownDrop').value = p.profile?.crownDrop ?? fromMm(DEFAULTS.profile.crownDrop, p.units);
  // Web-style tuning falls back to the planner defaults (which are mm, so
  // they convert when the preset works in inches).
  for (const [group, fields] of Object.entries(STYLE_FIELDS)) {
    for (const [k, f] of Object.entries(fields)) {
      const preset = p[group]?.[k];
      if (preset !== undefined) {
        $(f.id).value = preset;
        continue;
      }
      const d = DEFAULTS[group][k];
      $(f.id).value = isLengthInput(f.id) ? fromMm(d, p.units) : d;
    }
  }
  updateVisibility();
  replan();
}

function updateVisibility() {
  // "field:a,b" — or several such conditions joined by ";", all must hold.
  // A checkbox has no useful `value`, so it answers with "true"/"false".
  document.querySelectorAll('[data-show]').forEach((el) => {
    const show = el.dataset.show.split(';').every((cond) => {
      const [field, vals] = cond.split(':');
      const el2 = $(field);
      const v = el2.type === 'checkbox' ? String(el2.checked) : el2.value;
      return vals.split(',').includes(v);
    });
    el.classList.toggle('hidden', !show);
  });
}

// --- plan + render ---------------------------------------------------------
let preview = null;
let plan = null;
let planTimer = 0;

function replan() {
  clearTimeout(planTimer);
  planTimer = setTimeout(() => {
    try {
      plan = planWheel(gather());
      renderOutput(plan);
      preview?.setPlan(plan);
    } catch (e) {
      $('summary').innerHTML = `<div class="warn">Planner error: ${e.message}</div>`;
      console.error(e);
    }
  }, 120);
}

// The planner rounds everything it derives, but the params it echoes back are
// raw — and the in → mm conversion leaves float noise on them (14in becomes
// 355.59999999999997). Round to the 1 decimal the rest of the summary uses.
const mm1 = (v) => Math.round(v * 10) / 10;

function renderOutput(plan) {
  const p = plan.params;
  const segTxt = plan.N === 1
    ? 'prints in <b>one piece</b>'
    : `split into <b>${plan.N} segments</b> of ${plan.segAngle}°`;
  const jointTxt = plan.N === 1
    ? ''
    : `<div class="kv"><span>Joints per seam</span><span>${plan.joints.length} dovetail${plan.joints.length === 1 ? '' : 's'} (${plan.joints.map((j) => j.tag).join(', ')})</span></div>`;
  $('summary').innerHTML = `
    <div class="big">Ø${mm1(p.diameter)} × ${mm1(p.width)} mm — ${segTxt}</div>
    <div class="kv"><span>Piece footprint</span><span>${plan.bbox.w} × ${plan.bbox.d} × ${plan.W} mm</span></div>
    <div class="kv"><span>Usable bed</span><span>${plan.fit.usable.x} × ${plan.fit.usable.y} × ${plan.fit.usable.z} mm</span></div>
    ${materialTxt(plan)}
    ${jointTxt}
    <div class="kv"><span>Web</span><span>${describeInfill(plan.infillInfo)}</span></div>
    <div class="kv"><span>Tread</span><span>${describeTread(plan.treadInfo)}</span></div>
    <div class="kv"><span>Profile</span><span>${describeProfile(plan)}</span></div>`;

  $('pieceList').innerHTML = plan.uniquePieces
    .map(
      (u) => `<div class="piece"><span>piece&nbsp;<b>${u.label}</b> × ${u.count}</span>
        <span class="fit ${plan.fit.pieceFits ? 'ok' : 'bad'}">${plan.fit.pieceFits ? 'fits printer' : 'does not fit'}</span></div>`
    )
    .join('');

  $('warnings').innerHTML =
    plan.warnings.map((w) => `<div class="warn">⚠ ${w}</div>`).join('') +
    plan.notes.map((n) => `<div class="note">ℹ ${n}</div>`).join('');

  // Adhesive, then the printer settings, then the one thing a multi-material
  // wheel adds: where two filaments meet and whether they will hold.
  const perJoint = (plan.glue.perJoint || [])
    .map(
      (j) =>
        `<p><b>${j.tag} dovetail — ${j.material.toUpperCase()}:</b> ${j.name}. ${j.tips}</p>`
    )
    .join('');
  const printLines = (plan.printRec.byMaterial || [plan.printRec])
    .map(
      (r) =>
        `<p><b>Print${plan.printRec.byMaterial ? ` — ${r.material.toUpperCase()}` : ''}:</b> ` +
        `${r.walls} walls, ${r.infillPct}% ${r.infillPattern}. ${r.note}</p>`
    )
    .join('');
  const VERDICT = { weld: 'welds', good: 'bonds well', weak: 'bonds poorly' };
  const interfaces = plan.interfaces.length
    ? `<div class="g-sub">Where the materials meet</div>` +
      plan.interfaces
        .map(
          (f) =>
            `<p><b>${f.inner.toUpperCase()} → ${f.outer.toUpperCase()}</b> at Ø${mm1(f.r * 2)} mm — ` +
            `${VERDICT[f.level]}. ${f.why}</p>`
        )
        .join('')
    : '';
  $('glue').innerHTML = `
    <div class="g-name">${plan.glue.name}</div>
    <p>${plan.glue.why}</p>
    ${perJoint || `<p><b>How:</b> ${plan.glue.tips}</p>`}
    ${printLines}
    ${interfaces}`;

  renderFileLinks();
}

// One swatch per body, in the colours the preview paints them.
function materialTxt(plan) {
  if (!plan.multiMaterial) return '';
  const swatches = plan.zones
    .map(
      (z) =>
        `<span><i style="background:${cssColor(MATERIAL_COLORS[z.material])}"></i>` +
        `${z.key} ${z.material.toUpperCase()}</span>`
    )
    .join('');
  return `<div class="kv"><span>Materials</span><span class="mats">${swatches}</span></div>`;
}

function describeInfill(i) {
  if (i.style === 'spokes') return `${i.totalSpokes} spokes`;
  if (i.style === 'honeycomb') {
    return `honeycomb — ${i.cellsPerSegment}/segment, ${i.cellAcrossFlats} mm ${i.cellShape} cells, ${i.wall} mm wall`;
  }
  if (i.style === 'flexweb') return `flex web (${i.slotsTotal} slots)`;
  if (i.style === 'lattice') {
    const shape = i.rows === 1 ? 'chevron truss' : `${i.rows}-row weave`;
    return `interlaced lattice — ${shape}, ${i.cellsPerSegment} voids/segment, ${i.strutWidth} mm struts`;
  }
  if (i.style === 'auxetic') {
    return `auxetic — ${i.rings} ring${i.rings === 1 ? '' : 's'}, ${i.cellsPerSegment}/segment, ${i.cellWidth}×${i.cellHeight} mm cells, ${i.wall} mm wall`;
  }
  if (i.style === 'graded') {
    const lean = i.swirl ? `, ${Math.abs(i.swirl)}° swirl` : '';
    return `graded rings — ${i.rings} ring${i.rings === 1 ? '' : 's'}, ${i.cellsPerSegment}/segment, ${i.cellShape} cells ${i.innerCell} → ${i.outerCell} mm wide, ${i.wall} mm wall${lean}`;
  }
  if (i.style === 'voronoi') {
    return `voronoi — ${i.cellsPerSegment} cells/segment, ${i.wall} mm wall, seed ${i.seed}`;
  }
  return 'solid';
}
function describeTread(t) {
  const bits = [];
  if (t.bars) bits.push(`${t.bars} bars${t.barAngle ? ` at ${t.barAngle}°` : ''}`);
  if (t.ribs) bits.push(`${t.ribs} rib${t.ribs === 1 ? '' : 's'}`);
  return bits.length ? `${t.style} (${bits.join(', ')})` : t.style;
}
function describeProfile(plan) {
  const pr = plan.profile;
  if (pr.shape === 'flat') return 'flat (cylindrical)';
  const kind = pr.shape === 'round' ? 'round section' : 'crowned';
  return `${kind} — Ø${plan.radii.R * 2} at centre, Ø${(pr.shoulderR * 2).toFixed(1)} at the shoulders (section R${pr.crownRadius})`;
}

function renderFileLinks() {
  const files = generateSource(plan, runtime);
  $('fileLinks').innerHTML = '';
  for (const f of files.filter((f) => f.kind !== 'manifest')) {
    const a = document.createElement('a');
    a.textContent = f.name;
    a.href = URL.createObjectURL(new Blob([f.content], { type: 'text/plain' }));
    a.download = f.name;
    $('fileLinks').appendChild(a);
  }
}

// --- downloads -------------------------------------------------------------
async function postForBlob(url, msgOnFail) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(gather()),
  });
  if (!res.ok) {
    let detail = msgOnFail;
    try {
      const j = await res.json();
      detail = `${j.error}\n\n${j.how || ''}`;
    } catch { /* keep default */ }
    throw new Error(detail);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const name = /filename="([^"]+)"/.exec(cd)?.[1] || 'wheelwright.zip';
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
}

$('dlSourceZip').addEventListener('click', async () => {
  $('exportMsg').textContent = '';
  try {
    await postForBlob('/api/source.zip', 'Source zip failed');
  } catch (e) {
    // Server not reachable (static hosting) — fall back to per-file links.
    $('exportMsg').textContent = 'Server zip unavailable — use the individual file links below.';
  }
});

// Which formats the kernel is asked for. Both by default — STEP costs little
// on top of the solid that has already been built — but STL alone is the
// smaller download when the wheel is only going to a slicer, and STEP alone is
// what you want when it is going back into CAD.
const FORMAT_BOXES = { stl: 'fmtStl', step: 'fmtStep' };

const chosenFormats = () =>
  Object.entries(FORMAT_BOXES).filter(([, id]) => $(id).checked).map(([fmt]) => fmt);

const formatLabel = (formats) => formats.map((f) => f.toUpperCase()).join(' + ');

function syncFormats(cleared) {
  // Building nothing is not a state worth having, so the last box on cannot be
  // turned off — clearing it re-checks it instead of disabling the button.
  if (cleared && !chosenFormats().length) cleared.checked = true;
  $('dlStl').textContent = `Build ${formatLabel(chosenFormats())}`;
}

for (const id of Object.values(FORMAT_BOXES)) {
  $(id).addEventListener('change', () => syncFormats($(id)));
}
syncFormats(); // the label follows the boxes, not the markup's guess at them

$('dlStl').addEventListener('click', async () => {
  const btn = $('dlStl');
  const formats = chosenFormats();
  btn.disabled = true;
  btn.textContent = 'Building…';
  // A whole wheel is a few seconds; a lofted one is a few seconds more. Say
  // roughly what is happening rather than leave the button silent.
  $('exportMsg').textContent =
    plan.sections.length > 1
      ? `Lofting a ${plan.profile.shape} cross-section through ${plan.sections.length} profiles, ` +
        `${plan.uniquePieces.length} piece(s).`
      : `Building ${plan.uniquePieces.length} piece(s).`;
  $('exportMsg').classList.remove('err');
  try {
    await postForBlob(`/api/export/stl?formats=${formats.join(',')}`, 'Build failed');
    $('exportMsg').textContent = `${formatLabel(formats)} bundle downloaded.`;
  } catch (e) {
    $('exportMsg').textContent = e.message;
    $('exportMsg').classList.add('err');
  } finally {
    btn.disabled = false;
    btn.textContent = `Build ${formatLabel(chosenFormats())}`;
  }
});

// --- wiring ----------------------------------------------------------------
document.querySelectorAll('#config input, #config select').forEach((el) => {
  el.addEventListener('input', () => {
    if (el.id === 'units') setUnits(el.value);
    syncZoneMaterials();
    updateVisibility();
    replan();
  });
});
enableScrub(document.querySelectorAll('#config input[type="number"]'));
document.querySelectorAll('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => applyPreset(PRESETS[btn.dataset.preset]));
});
$('explode').addEventListener('input', (e) => preview?.setExplode(e.target.value / 100));
$('fitView').addEventListener('change', (e) => preview?.setFitView(e.target.checked));

function renderHealth(h) {
  const el = $('occStatus');
  el.classList.remove('ok', 'off');
  let items;
  if (!h) {
    el.textContent = '○ static mode';
    el.classList.add('off');
    items = [[false, 'server API unreachable — the source bundle still downloads']];
  } else {
    const o = h.occ;
    el.textContent = o.ready ? '● build ready' : '○ kernel setup';
    el.classList.add(o.ready ? 'ok' : 'off');
    items = [
      [
        o.python,
        o.python
          ? `OpenCascade ${o.occtVersion} — ${o.pythonPath}`
          : 'OpenCascade not installed — run this in the project, then restart the server:',
      ],
    ];
  }
  $('healthList').innerHTML = items
    .map(([ok, text]) => `<li><span class="dot ${ok ? 'ok' : ''}"></span>${text}</li>`)
    .join('');
  $('cliHint').classList.toggle('hidden', !h || h.occ.ready);
}

function refreshHealth() {
  fetch('/api/health')
    .then((r) => r.json())
    .then(renderHealth)
    .catch(() => renderHealth(null));
}

$('occStatus').addEventListener('click', (e) => {
  e.stopPropagation();
  $('kernelPanel').classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.kernel-wrap')) $('kernelPanel').classList.add('hidden');
});
refreshHealth();

syncZoneMaterials();
updateVisibility();
createPreview($('stage')).then((pv) => {
  preview = pv;
  $('renderMode').textContent = pv.mode;
  pv.setExplode($('explode').value / 100);
  if (plan) pv.setPlan(plan);
});
replan();
