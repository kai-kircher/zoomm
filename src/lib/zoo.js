// Zoo Design API integration.
//
// KCL executes through Zoo's engine; the supported programmatic path for
// KCL → STL is the official `zoo` CLI (`zoo kcl export`), which drives the
// modeling WebSocket API with the user's ZOO_API_TOKEN. This module shells
// out to it when present and reports a clear status when it isn't, so the
// web UI can fall back to serving .kcl files with instructions.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let cliChecked = null;

export function zooStatus() {
  if (cliChecked === null) {
    try {
      const r = spawnSync('zoo', ['version'], { timeout: 10000, encoding: 'utf8' });
      cliChecked = r.status === 0 || r.status === 1 ? true : !r.error;
      if (r.error) cliChecked = false;
    } catch {
      cliChecked = false;
    }
  }
  const token = !!(process.env.ZOO_API_TOKEN || process.env.ZOO_TOKEN || process.env.KITTYCAD_API_TOKEN);
  return { cli: cliChecked, token, ready: cliChecked && token };
}

// kclFiles: [{name, content}] (only .kcl entries are exported)
// Returns [{name, data: Buffer}] of STLs. Throws Error with .code on failure.
export function exportStl(kclFiles) {
  const status = zooStatus();
  if (!status.cli) {
    const err = new Error('The `zoo` CLI is not installed on this server.');
    err.code = 'no-cli';
    throw err;
  }
  if (!status.token) {
    const err = new Error('ZOO_API_TOKEN is not set on this server.');
    err.code = 'no-token';
    throw err;
  }
  const work = mkdtempSync(join(tmpdir(), 'wheelwright-'));
  const out = [];
  try {
    for (const f of kclFiles.filter((f) => f.name.endsWith('.kcl'))) {
      const src = join(work, f.name);
      writeFileSync(src, f.content);
      const outDir = join(work, f.name.replace(/\.kcl$/, ''));
      mkdirSync(outDir, { recursive: true });
      const r = spawnSync('zoo', ['kcl', 'export', '--output-format=stl', src, outDir], {
        timeout: 300000,
        encoding: 'utf8',
        env: process.env,
      });
      if (r.status !== 0) {
        const err = new Error(
          `zoo kcl export failed for ${f.name}: ${(r.stderr || r.stdout || 'unknown error').slice(0, 2000)}`
        );
        err.code = 'export-failed';
        throw err;
      }
      const stl = readdirSync(outDir).find((n) => n.toLowerCase().endsWith('.stl'));
      if (!stl) {
        const err = new Error(`zoo kcl export produced no STL for ${f.name}`);
        err.code = 'export-failed';
        throw err;
      }
      out.push({ name: f.name.replace(/\.kcl$/, '.stl'), data: readFileSync(join(outDir, stl)) });
    }
    return out;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
