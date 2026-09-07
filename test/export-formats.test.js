// The `?formats=` option on /api/export/stl, and the one thing that keeps the
// JS and Python halves of it honest.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPORT_FORMATS, parseFormats } from '../src/lib/occ.js';

test('an unasked-for export gets every format', () => {
  assert.deepEqual(parseFormats(undefined), EXPORT_FORMATS);
  // `?formats=` with nothing after it is a caller that said nothing, not one
  // that asked for nothing.
  assert.deepEqual(parseFormats(''), EXPORT_FORMATS);
  assert.deepEqual(parseFormats(null), EXPORT_FORMATS);
});

test('either format can be had on its own', () => {
  assert.deepEqual(parseFormats('stl'), ['stl']);
  assert.deepEqual(parseFormats('step'), ['step']);
  assert.deepEqual(parseFormats(['step']), ['step']);
});

test('spelling does not change the export', () => {
  // The result names the download, so `step,stl` and `stl,step` must not
  // produce two differently-named zips of identical content.
  for (const spec of ['stl,step', 'step,stl', ' STL , Step ', 'stl,step,stl']) {
    assert.deepEqual(parseFormats(spec), ['stl', 'step'], spec);
  }
});

test('a format the kernel cannot write is refused, by name', () => {
  // Not academic: before this check an unknown format reached Python's `save`,
  // which wrote a STEP and named it `piece-A.obj`.
  assert.throws(() => parseFormats('obj'), /Unknown export format: obj/);
  assert.throws(() => parseFormats('stl,obj'), /Unknown export format: obj/);
  assert.throws(() => parseFormats('obj,3mf'), /obj, 3mf/);
  for (const e of [() => parseFormats('obj'), () => parseFormats('stl,obj')]) {
    assert.throws(e, /Known formats: stl, step/);
  }
});

test('asking for nothing at all is refused rather than silently built', () => {
  assert.throws(() => parseFormats(','), /No export format requested/);
  assert.throws(() => parseFormats([]), /No export format requested/);
  assert.throws(() => parseFormats('  '), /No export format requested/);
});

test('the returned list is a copy, so a caller cannot edit the source of truth', () => {
  parseFormats(undefined).push('obj');
  assert.deepEqual(EXPORT_FORMATS, ['stl', 'step']);
});

test('the Python writers and EXPORT_FORMATS name the same formats', () => {
  // These live in different languages and different files, and the export is
  // wrong in a quiet way if they drift: JS filters the build directory by
  // extension, so a format only Python knows about is built and then dropped.
  const py = readFileSync(join(import.meta.dirname, '..', 'src', 'lib', 'occ', 'wheelwright_occ.py'), 'utf8');
  const table = /^WRITERS = \{(.*)\}$/m.exec(py);
  assert.ok(table, 'WRITERS table not found in wheelwright_occ.py');
  const known = [...table[1].matchAll(/"([a-z0-9]+)":/g)].map((m) => m[1]);
  assert.deepEqual(known, EXPORT_FORMATS);
});
