// Zoo Design API integration.
//
// KCL executes through Zoo's engine; the supported programmatic path for
// KCL → STL is the official `zoo` CLI (`zoo kcl export`), which drives the
// modeling WebSocket API with the user's API token. This module shells out
// to it when present and reports a clear status when it isn't, so the web
// UI can fall back to serving .kcl files with instructions.
//
// Token resolution (same scheme as our sibling project zapim): a
// per-request override from the browser wins, otherwise the ZOO_API_TOKEN
// environment variable — which `server.js` seeds from a `.env` file.
// Tokens are never logged and never persisted server-side.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function resolveToken(override) {
  const t = (
    (override || '').trim() ||
    process.env.ZOO_API_TOKEN ||
    process.env.ZOO_TOKEN || // legacy name the CLI also accepts
    process.env.KITTYCAD_API_TOKEN ||
    ''
  ).trim();
  return t.length > 0 ? t : null;
}

let cliCache; // undefined = not probed yet; null = not found; {path, version}

export function findZooCli() {
  if (cliCache !== undefined) return cliCache;
  const exe = process.platform === 'win32' ? 'zoo.exe' : 'zoo';
  const candidates = [process.env.ZOO_CLI_PATH, join(process.cwd(), 'bin', exe), 'zoo'].filter(Boolean);
  for (const cand of candidates) {
    try {
      const r = spawnSync(cand, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
      if (r.status === 0 && r.stdout) {
        cliCache = { path: cand, version: r.stdout.trim().split('\n')[0] };
        return cliCache;
      }
    } catch {
      /* try next candidate */
    }
  }
  cliCache = null;
  return null;
}

export function zooStatus(tokenOverride) {
  const cli = findZooCli();
  const token = !!resolveToken(tokenOverride);
  return { cli: !!cli, cliVersion: cli?.version, token, ready: !!cli && token };
}

// kclFiles: [{name, content}] (only .kcl entries are exported)
// Returns [{name, data: Buffer}] of STLs. Throws Error with .code on failure.
export function exportStl(kclFiles, tokenOverride) {
  const cli = findZooCli();
  if (!cli) {
    const err = new Error('The `zoo` CLI is not installed on this server.');
    err.code = 'no-cli';
    throw err;
  }
  const token = resolveToken(tokenOverride);
  if (!token) {
    const err = new Error('No Zoo API token — set ZOO_API_TOKEN in .env or paste one in the browser settings.');
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
      const r = spawnSync(cli.path, ['kcl', 'export', '--output-format=stl', src, outDir], {
        // Flat pieces come back in seconds. A crowned one is lofted through
        // several profiles and the engine spends minutes fitting the surface,
        // so the budget has to be generous or a legitimate export gets killed
        // and reported as "unknown error".
        timeout: 900000,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, ZOO_API_TOKEN: token },
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
