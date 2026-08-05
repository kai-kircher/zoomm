import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from '../src/lib/env.js';
import { resolveToken } from '../src/lib/zoo.js';

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

test('resolveToken: per-request override beats env, blank means null', () => {
  const saved = { a: process.env.ZOO_API_TOKEN, b: process.env.ZOO_TOKEN, c: process.env.KITTYCAD_API_TOKEN };
  delete process.env.ZOO_TOKEN;
  delete process.env.KITTYCAD_API_TOKEN;
  process.env.ZOO_API_TOKEN = 'env-token';
  assert.equal(resolveToken(), 'env-token');
  assert.equal(resolveToken('browser-token'), 'browser-token');
  assert.equal(resolveToken('  '), 'env-token', 'whitespace override falls through to env');
  delete process.env.ZOO_API_TOKEN;
  assert.equal(resolveToken(), null);
  assert.equal(resolveToken('  x  '), 'x');
  if (saved.a !== undefined) process.env.ZOO_API_TOKEN = saved.a;
  if (saved.b !== undefined) process.env.ZOO_TOKEN = saved.b;
  if (saved.c !== undefined) process.env.KITTYCAD_API_TOKEN = saved.c;
});
