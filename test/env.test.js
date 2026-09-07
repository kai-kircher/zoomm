import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../src/lib/env.js';
import { occStatus } from '../src/lib/occ.js';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ww-env-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadEnv parses .env and seeds process.env without overriding', () => {
  withTempDir((dir) => {
    writeFileSync(
      join(dir, '.env'),
      [
        '# comment line',
        'WW_TEST_A=hello',
        'WW_TEST_B="quoted value" ',
        "export WW_TEST_C='single'",
        'WW_TEST_D=trail # inline comment',
        'WW_TEST_EXISTING=from-file',
        'not a valid line',
      ].join('\n')
    );
    process.env.WW_TEST_EXISTING = 'from-shell';
    delete process.env.WW_TEST_A;
    delete process.env.WW_TEST_B;
    delete process.env.WW_TEST_C;
    delete process.env.WW_TEST_D;

    const applied = loadEnv(dir);
    assert.equal(process.env.WW_TEST_A, 'hello');
    assert.equal(process.env.WW_TEST_B, 'quoted value');
    assert.equal(process.env.WW_TEST_C, 'single');
    assert.equal(process.env.WW_TEST_D, 'trail');
    assert.equal(process.env.WW_TEST_EXISTING, 'from-shell', 'real environment wins over .env');
    assert.ok(applied.includes('WW_TEST_A'));
    assert.ok(!applied.includes('WW_TEST_EXISTING'));
    for (const k of ['WW_TEST_A', 'WW_TEST_B', 'WW_TEST_C', 'WW_TEST_D', 'WW_TEST_EXISTING']) delete process.env[k];
  });
});

test('.env.local wins over .env', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, '.env'), 'WW_TEST_LOCAL=base');
    writeFileSync(join(dir, '.env.local'), 'WW_TEST_LOCAL=local');
    delete process.env.WW_TEST_LOCAL;
    loadEnv(dir);
    assert.equal(process.env.WW_TEST_LOCAL, 'local');
    delete process.env.WW_TEST_LOCAL;
  });
});

test('missing .env files are fine', () => {
  withTempDir((dir) => {
    assert.deepEqual(loadEnv(dir), []);
  });
});

test('occStatus reports a usable shape whether or not OpenCascade is installed', () => {
  // There is no token to resolve any more — the kernel is local, so the only
  // question is which interpreter has it. The server renders this object
  // straight into the status pill, so its shape matters even when nothing is
  // installed.
  const s = occStatus();
  assert.equal(typeof s.python, 'boolean');
  assert.equal(s.ready, s.python);
  if (s.python) {
    assert.equal(typeof s.pythonPath, 'string');
    assert.match(s.occtVersion, /^\d+\.\d+/, 'OCP reports its OpenCascade version');
  }
});
