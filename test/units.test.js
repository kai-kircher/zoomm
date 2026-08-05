// Switching units must preserve the physical size the form describes.
//
// The regression pinned here: clicking the "14″ cart wheel" preset selected
// inches and wrote the preset's own wheel and bore numbers, but left the
// printer envelope, the joint clearance and the bore clearance holding
// millimetres. The planner then read those as inches — a 220 mm bed became
// 5588 mm, clamped to 2000 — so the build plan reported "Usable bed 1940 ×
// 1940 × 2000 mm" and "prints in one piece" instead of dovetailed segments.
// Changing the selector by hand had the same effect on every length field.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planWheel, LENGTH_FIELDS, IN } from '../src/lib/wheel.js';
import { LENGTH_INPUTS, convertLength, convertFormUnits } from '../src/lib/units.js';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

// The value the shipped form starts each length input at.
function formDefault(id) {
  const m = new RegExp(`<input id="${id}"[^>]*\\bvalue="([^"]*)"`).exec(html);
  assert.ok(m, `#${id} is an input carrying a default value`);
  return m[1];
}

// A form as a plain record of input values — the store shape app.js hands to
// convertFormUnits, backed by an object instead of DOM inputs.
function form(overrides = {}) {
  const values = { units: 'mm' }; // the form's first <option>
  for (const { id } of LENGTH_INPUTS) values[id] = formDefault(id);
  Object.assign(values, overrides);
  return {
    values,
    get: (id) => values[id],
    set: (id, v) => {
      values[id] = v;
    },
  };
}

// The planner params gather() would send for a form state: every length input
// at its parameter path, plus whatever non-length fields the case cares about.
function paramsFrom(store, rest = {}) {
  const p = { units: store.values.units, ...structuredClone(rest) };
  for (const { id, path } of LENGTH_INPUTS) {
    let o = p;
    for (const k of path.slice(0, -1)) o[k] ??= {};
    for (const k of path.slice(0, -1)) o = o[k];
    o[path[path.length - 1]] = store.get(id);
  }
  return p;
}

// PRESETS.cart in public/app.js — the flat fields and bore it writes over the
// form after switching it to inches.
const CART_PRESET = {
  diameter: 14, width: 2, treadDepth: 0.14,
  boreDiameter: 0.75, keyWidth: 0.1875, keyDepth: 0.11,
};
const CART_REST = { material: 'petg', infill: 'spokes', spokeCount: 0, tread: 'lugged', bore: { type: 'keyed' } };

test('every length the planner converts has a form input', () => {
  const planner = LENGTH_FIELDS.map((path) => path.join('.')).sort();
  const formFields = LENGTH_INPUTS.map((f) => f.path.join('.')).sort();
  assert.deepEqual(formFields, planner);
});

test('every length input is a real field in the form', () => {
  for (const { id } of LENGTH_INPUTS) {
    assert.match(html, new RegExp(`<input id="${id}"`), `#${id} exists in index.html`);
  }
});

test('converting a length preserves the physical size', () => {
  assert.equal(convertLength(355.6, 'mm', 'in'), 14);
  assert.equal(convertLength(14, 'in', 'mm'), 355.6);
  assert.equal(convertLength(0, 'mm', 'in'), 0); // 0 = "auto" on several fields
  assert.equal(convertLength(220, 'mm', 'mm'), 220);
  // Every default the form ships with survives a there-and-back flip exactly.
  for (const mm of [0.15, 0.2, 2.6, 10, 50, 220, 250, 355.6]) {
    assert.equal(convertLength(convertLength(mm, 'mm', 'in'), 'in', 'mm'), mm, `${mm} mm round-trips`);
  }
});

test('switching the form to inches keeps every length physically the same', () => {
  const mmForm = form();
  const inForm = form();
  convertFormUnits(inForm, 'mm', 'in');
  inForm.values.units = 'in';

  for (const { id } of LENGTH_INPUTS) {
    const mm = Number(mmForm.get(id));
    // Within a tenth of a micron — the rounding the input boxes display at.
    assert.ok(Math.abs(Number(inForm.get(id)) * IN - mm) < 1e-4, `#${id}: ${inForm.get(id)} in is ${mm} mm`);
  }
  // …and the planner agrees, down to the usable bed and the segment count.
  const mmPlan = planWheel(paramsFrom(mmForm, CART_REST));
  const inPlan = planWheel(paramsFrom(inForm, CART_REST));
  assert.deepEqual(inPlan.fit.usable, mmPlan.fit.usable);
  assert.equal(inPlan.N, mmPlan.N);
  assert.deepEqual(inPlan.bbox, mmPlan.bbox);
});

test('the 14in cart preset plans dovetailed segments, not one 2000 mm piece', () => {
  // What applyPreset does: switch the units (converting what the form holds),
  // then write the preset's own inch numbers over the top.
  const store = form();
  convertFormUnits(store, 'mm', 'in');
  store.values.units = 'in';
  Object.assign(store.values, CART_PRESET);
  const plan = planWheel(paramsFrom(store, CART_REST));

  assert.deepEqual(plan.fit.usable, { x: 210, y: 210, z: 250 });
  assert.ok(plan.N >= 2, `segmented for a 220 mm bed (got N=${plan.N})`);
  assert.ok(plan.fit.pieceFits, 'each segment fits the printer');
  assert.deepEqual(plan.joints.map((j) => j.tag), ['hub', 'rim']);
  assert.equal(plan.params.joint.clearance.toFixed(3), '0.150');
  assert.equal(plan.params.boreClearance.toFixed(3), '0.200');

  // The same wheel in millimetres: same physical plan, joint radii included.
  const mmPlan = planWheel({
    ...CART_REST,
    diameter: 14 * IN, width: 2 * IN, treadDepth: 0.14 * IN,
    bore: { type: 'keyed', diameter: 0.75 * IN, keyWidth: 0.1875 * IN, keyDepth: 0.11 * IN },
  });
  assert.equal(plan.N, mmPlan.N);
  assert.deepEqual(plan.bbox, mmPlan.bbox);
  plan.joints.forEach((j, i) => {
    assert.ok(Math.abs(j.r - mmPlan.joints[i].r) < 0.01, `${j.tag} joint sits at the same radius`);
  });

  // Without the conversion — the bug — the mm printer numbers are read as
  // inches: 220 in → 5588 mm, clamped to 2000; margin 10 in → 254, clamped
  // to 60. A 14in wheel then "fits" a 1940 mm bed whole.
  const unconverted = planWheel(paramsFrom(form({ units: 'in', ...CART_PRESET }), CART_REST));
  assert.deepEqual(unconverted.fit.usable, { x: 1940, y: 1940, z: 2000 });
  assert.equal(unconverted.N, 1);
});
