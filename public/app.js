// Wheelwright UI — gathers params, replans live (same planner module the
// server uses), drives the preview, and handles KCL/STL downloads.

import { planWheel, DEFAULTS, IN } from '/lib/wheel.js';
import { generateKcl, slugFor } from '/lib/kclgen.js';
import { createPreview } from './preview.js';

const $ = (id) => document.getElementById(id);

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
  tiny: {
    units: 'mm', diameter: 100, width: 25, material: 'pla', infill: 'spokes',
    tread: 'ribbed', treadDepth: 2,
    bore: { type: 'plain', diameter: 8 },
  },
};

function gather() {
  return {
    units: $('units').value,
    diameter: $('diameter').value,
    width: $('width').value,
    material: $('material').value,
    infill: $('infill').value,
    spokeCount: $('spokeCount').value,
    tread: $('tread').value,
    treadDepth: $('treadDepth').value,
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
    honeycomb: {
      cellSize: $('hcCellSize').value,
      wall: $('hcWall').value,
      orientation: $('hcOrientation').value,
      cellShape: $('hcCellShape').value,
      cornerRadius: $('hcCornerRadius').value,
      maxCells: $('hcMaxCells').value,
    },
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

// Honeycomb tuning fields; `len` marks the ones that carry a length unit.
const HC_FIELDS = {
  cellSize: { id: 'hcCellSize', len: true },
  wall: { id: 'hcWall', len: true },
  orientation: { id: 'hcOrientation' },
  cellShape: { id: 'hcCellShape' },
  cornerRadius: { id: 'hcCornerRadius', len: true },
  maxCells: { id: 'hcMaxCells' },
};

function applyPreset(p) {
  const flat = {
    units: p.units, diameter: p.diameter, width: p.width, material: p.material,
    infill: p.infill, spokeCount: p.spokeCount ?? 0, tread: p.tread, treadDepth: p.treadDepth,
  };
  for (const [k, v] of Object.entries(flat)) if ($(k) && v !== undefined) $(k).value = v;
  $('boreType').value = p.bore.type;
  const boreMap = {
    diameter: 'boreDiameter', keyWidth: 'keyWidth', keyDepth: 'keyDepth',
    hexAcrossFlats: 'hexAcrossFlats', flatOffset: 'flatOffset', boltCount: 'boltCount',
    boltCircle: 'boltCircle', boltHoleDia: 'boltHoleDia', pilotDia: 'pilotDia',
  };
  for (const [k, id] of Object.entries(boreMap)) if (p.bore[k] !== undefined) $(id).value = p.bore[k];
  // Honeycomb tuning falls back to the planner defaults (which are mm, so
  // they convert when the preset works in inches).
  for (const [k, f] of Object.entries(HC_FIELDS)) {
    const preset = p.honeycomb?.[k];
    if (preset !== undefined) {
      $(f.id).value = preset;
      continue;
    }
    const d = DEFAULTS.honeycomb[k];
    $(f.id).value = f.len && p.units === 'in' ? Math.round((d / IN) * 1000) / 1000 : d;
  }
  updateVisibility();
  replan();
}

function updateVisibility() {
  // "field:a,b" — or several such conditions joined by ";", all must hold.
  document.querySelectorAll('[data-show]').forEach((el) => {
    const show = el.dataset.show.split(';').every((cond) => {
      const [field, vals] = cond.split(':');
      return vals.split(',').includes($(field).value);
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

function renderOutput(plan) {
  const p = plan.params;
  const segTxt = plan.N === 1
    ? 'prints in <b>one piece</b>'
    : `split into <b>${plan.N} segments</b> of ${plan.segAngle}°`;
  const jointTxt = plan.N === 1
    ? ''
    : `<div class="kv"><span>Joints per seam</span><span>${plan.joints.length} dovetail${plan.joints.length === 1 ? '' : 's'} (${plan.joints.map((j) => j.tag).join(', ')})</span></div>`;
  $('summary').innerHTML = `
    <div class="big">Ø${p.diameter} × ${p.width} mm — ${segTxt}</div>
    <div class="kv"><span>Piece footprint</span><span>${plan.bbox.w} × ${plan.bbox.d} × ${plan.W} mm</span></div>
    <div class="kv"><span>Usable bed</span><span>${plan.fit.usable.x} × ${plan.fit.usable.y} × ${plan.fit.usable.z} mm</span></div>
    ${jointTxt}
    <div class="kv"><span>Web</span><span>${describeInfill(plan.infillInfo)}</span></div>
    <div class="kv"><span>Tread</span><span>${describeTread(plan.treadInfo)}</span></div>`;

  $('pieceList').innerHTML = plan.uniquePieces
    .map(
      (u) => `<div class="piece"><span>piece&nbsp;<b>${u.label}</b> × ${u.count}</span>
        <span class="fit ${plan.fit.pieceFits ? 'ok' : 'bad'}">${plan.fit.pieceFits ? 'fits printer' : 'does not fit'}</span></div>`
    )
    .join('');

  $('warnings').innerHTML =
    plan.warnings.map((w) => `<div class="warn">⚠ ${w}</div>`).join('') +
    plan.notes.map((n) => `<div class="note">ℹ ${n}</div>`).join('');

  $('glue').innerHTML = `
    <div class="g-name">${plan.glue.name}</div>
    <p>${plan.glue.why}</p>
    <p><b>How:</b> ${plan.glue.tips}</p>
    <p><b>Print:</b> ${plan.printRec.walls} walls, ${plan.printRec.infillPct}% ${plan.printRec.infillPattern}. ${plan.printRec.note}</p>`;

  renderFileLinks();
}

function describeInfill(i) {
  if (i.style === 'spokes') return `${i.totalSpokes} spokes`;
  if (i.style === 'honeycomb') {
    return `honeycomb — ${i.cellsPerSegment}/segment, ${i.cellAcrossFlats} mm ${i.cellShape} cells, ${i.wall} mm wall`;
  }
  if (i.style === 'flexweb') return `flex web (${i.slotsTotal} slots)`;
  return 'solid';
}
function describeTread(t) {
  const bits = [];
  if (t.lugsTotal) bits.push(`${t.lugsTotal} lugs`);
  if (t.grooves) bits.push(`${t.grooves} grooves`);
  return bits.length ? `${t.style} (${bits.join(', ')})` : t.style;
}

function renderFileLinks() {
  const files = generateKcl(plan);
  $('fileLinks').innerHTML = '';
  for (const f of files.filter((f) => f.kind === 'kcl' || f.kind === 'doc')) {
    const a = document.createElement('a');
    a.textContent = f.name;
    a.href = URL.createObjectURL(new Blob([f.content], { type: 'text/plain' }));
    a.download = f.name;
    $('fileLinks').appendChild(a);
  }
}

// --- Zoo token (same scheme as zapim: .env on the server is preferred; a
// token pasted here lives in localStorage only and rides each request in the
// x-zoo-token header) ---------------------------------------------------------
const TOKEN_KEY = 'wheelwright-zoo-token';
const getStoredToken = () => localStorage.getItem(TOKEN_KEY) || '';
const setStoredToken = (t) => (t ? localStorage.setItem(TOKEN_KEY, t.trim()) : localStorage.removeItem(TOKEN_KEY));
const tokenHeaders = () => (getStoredToken() ? { 'x-zoo-token': getStoredToken() } : {});

// --- downloads -------------------------------------------------------------
async function postForBlob(url, msgOnFail) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...tokenHeaders() },
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

$('dlKclZip').addEventListener('click', async () => {
  $('exportMsg').textContent = '';
  try {
    await postForBlob('/api/kcl.zip', 'KCL zip failed');
  } catch (e) {
    // Server not reachable (static hosting) — fall back to per-file links.
    $('exportMsg').textContent = 'Server zip unavailable — use the individual file links below.';
  }
});

$('dlStl').addEventListener('click', async () => {
  const btn = $('dlStl');
  btn.disabled = true;
  btn.textContent = 'Exporting via Zoo…';
  $('exportMsg').textContent = '';
  $('exportMsg').classList.remove('err');
  try {
    await postForBlob('/api/export/stl', 'STL export failed');
    $('exportMsg').textContent = 'STL bundle downloaded.';
  } catch (e) {
    $('exportMsg').textContent = e.message;
    $('exportMsg').classList.add('err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Export STL via Zoo';
  }
});

// --- wiring ----------------------------------------------------------------
document.querySelectorAll('#config input, #config select').forEach((el) => {
  el.addEventListener('input', () => {
    updateVisibility();
    replan();
  });
});
document.querySelectorAll('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => applyPreset(PRESETS[btn.dataset.preset]));
});
$('explode').addEventListener('input', (e) => preview?.setExplode(e.target.value / 100));
$('fitView').addEventListener('change', (e) => preview?.setFitView(e.target.checked));

function renderHealth(h) {
  const el = $('zooStatus');
  el.classList.remove('ok', 'off');
  let items;
  if (!h) {
    el.textContent = '○ static mode';
    el.classList.add('off');
    items = [[false, 'server API unreachable']];
  } else {
    const z = h.zoo;
    if (z.ready) {
      el.textContent = '● Zoo export ready';
      el.classList.add('ok');
    } else {
      el.textContent = z.cli ? '○ Zoo token needed' : '○ Zoo setup';
      el.classList.add('off');
    }
    items = [
      [z.token, z.token ? `API token configured${getStoredToken() ? ' (from this browser)' : ''}` : 'API token missing'],
      [z.cli, z.cli ? `zoo CLI found${z.cliVersion ? ` (${z.cliVersion})` : ''}` : 'zoo CLI not installed — run this in the project, then restart the server:'],
    ];
  }
  $('healthList').innerHTML = items
    .map(([ok, text]) => `<li><span class="dot ${ok ? 'ok' : ''}"></span>${text}</li>`)
    .join('');
  $('cliHint').classList.toggle('hidden', !h || h.zoo.cli);
}

function refreshHealth() {
  fetch('/api/health', { headers: tokenHeaders() })
    .then((r) => r.json())
    .then(renderHealth)
    .catch(() => renderHealth(null));
}

$('zooStatus').addEventListener('click', (e) => {
  e.stopPropagation();
  const panel = $('tokenPanel');
  if (panel.classList.contains('hidden')) $('tokenInput').value = getStoredToken();
  panel.classList.toggle('hidden');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.token-wrap')) $('tokenPanel').classList.add('hidden');
});
$('tokenSave').addEventListener('click', () => {
  setStoredToken($('tokenInput').value);
  refreshHealth();
  $('tokenPanel').classList.add('hidden');
});
$('tokenClear').addEventListener('click', () => {
  setStoredToken('');
  $('tokenInput').value = '';
  refreshHealth();
});
refreshHealth();

updateVisibility();
createPreview($('stage')).then((pv) => {
  preview = pv;
  $('renderMode').textContent = pv.mode;
  pv.setExplode($('explode').value / 100);
  if (plan) pv.setPlan(plan);
});
replan();
