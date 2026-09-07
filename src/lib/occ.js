// OpenCascade backend — finds a Python with the OCCT bindings and runs a
// generated bundle through it.
//
// There is no service, no account and no network here: `pip install
// cadquery-ocp` puts OpenCascade 7.9 in a virtualenv and the kernel runs
// locally. The only thing to discover is which interpreter has it.
//
// Resolution order: WHEELWRIGHT_PYTHON, then the venv `npm run setup:occ`
// creates in ./bin, then whatever `python3`/`python`/`py -3` is on PATH — so a
// developer who already has OCP installed needs no setup step at all.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WIN = process.platform === 'win32';

// Where `npm run setup:occ` puts its virtualenv.
export const VENV_DIR = join(process.cwd(), 'bin', 'occ-venv');
export const venvPython = (root = VENV_DIR) =>
  WIN ? join(root, 'Scripts', 'python.exe') : join(root, 'bin', 'python');

// Building a 24-segment voronoi wheel is seconds, not minutes; this budget is
// only here so a wedged process cannot hold a request open forever.
const BUILD_TIMEOUT_MS = 600000;
const PROBE_TIMEOUT_MS = 20000;

let cache; // undefined = not probed; null = nothing usable; {path, args, version}

function probe(cmd, args = []) {
  try {
    const r = spawnSync(cmd, [...args, '-c', 'import OCP; print(OCP.__version__)'], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    if (r.status === 0 && r.stdout.trim()) {
      return { path: cmd, args, version: r.stdout.trim().split('\n')[0] };
    }
  } catch {
    /* try the next candidate */
  }
  return null;
}

export function findPython() {
  if (cache !== undefined) return cache;
  const candidates = [];
  if (process.env.WHEELWRIGHT_PYTHON) candidates.push([process.env.WHEELWRIGHT_PYTHON, []]);
  const vp = venvPython();
  if (existsSync(vp)) candidates.push([vp, []]);
  candidates.push(['python3', []], ['python', []]);
  if (WIN) candidates.push(['py', ['-3']]);
  for (const [cmd, args] of candidates) {
    const found = probe(cmd, args);
    if (found) return (cache = found);
  }
  return (cache = null);
}

// Exposed for tests, which need to re-probe after changing the environment.
export function resetPythonCache() {
  cache = undefined;
}

export function occStatus() {
  const py = findPython();
  return {
    python: !!py,
    pythonPath: py?.path,
    occtVersion: py?.version,
    ready: !!py,
  };
}

/**
 * Run a generated bundle through OpenCascade.
 *
 * The bundle carries its own `build.py` and `wheelwright_occ.py`, so this
 * writes the files out verbatim and runs them — the server executes exactly
 * what the user can download, rather than a second private code path that
 * could drift from it.
 *
 * @param {{name: string, content: string}[]} files  from generateSource()
 * @param {{formats?: string[]}} opts
 * @returns {{name: string, data: Buffer}[]}  the built STL/STEP files
 */
export function buildPieces(files, { formats = ['stl', 'step'] } = {}) {
  const py = findPython();
  if (!py) {
    const err = new Error(
      'No Python with the OpenCascade bindings was found on this server.'
    );
    err.code = 'no-python';
    throw err;
  }

  // Short path on purpose: on Windows, OCP's DLL loader fails with "filename or
  // extension is too long" when its own package path runs past MAX_PATH, and a
  // deep working directory is an easy way to get there.
  const work = mkdtempSync(join(tmpdir(), 'ww-'));
  try {
    for (const f of files) writeFileSync(join(work, f.name), f.content);

    const r = spawnSync(
      py.path,
      [...py.args, join(work, 'build.py'), work, '--formats', formats.join(','), '--json'],
      { encoding: 'utf8', timeout: BUILD_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }
    );

    let report = null;
    try {
      report = JSON.parse((r.stdout || '').trim().split('\n').pop());
    } catch {
      /* fall through to the generic message below */
    }

    if (r.status !== 0 || !report?.ok) {
      const why =
        report?.pieces?.filter((p) => !p.ok).map((p) => `${p.piece}: ${p.error}`).join('; ') ||
        (r.stderr || r.stdout || 'unknown error').slice(0, 2000);
      const err = new Error(`Build failed — ${why}`);
      err.code = 'build-failed';
      throw err;
    }

    const wanted = new Set(formats.map((f) => `.${f}`));
    const out = readdirSync(work)
      .filter((n) => wanted.has(n.slice(n.lastIndexOf('.'))))
      .sort()
      .map((n) => ({ name: n, data: readFileSync(join(work, n)) }));
    if (!out.length) {
      const err = new Error('The build reported success but produced no files.');
      err.code = 'build-failed';
      throw err;
    }
    out.report = report;
    return out;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
