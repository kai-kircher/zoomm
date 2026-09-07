#!/usr/bin/env node
/**
 * Creates a virtualenv in ./bin/occ-venv with OpenCascade's Python bindings.
 * That kernel is what turns a generated bundle into STL and STEP — without it
 * the app still plans, previews and hands you the source bundle, but cannot
 * build the solids itself.
 *
 *   npm run setup:occ
 *
 * Nothing here needs an account, a token or the network beyond PyPI. If you
 * already have `cadquery-ocp` in some interpreter, skip this entirely and set
 * WHEELWRIGHT_PYTHON to it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VENV_DIR, venvPython } from '../src/lib/occ.js';

const WIN = process.platform === 'win32';
const PKG = process.env.WHEELWRIGHT_OCP_PACKAGE || 'cadquery-ocp';

// cadquery-ocp publishes wheels for these; anything else would try to build
// OpenCascade from source, which is not a thing to do by accident.
const MIN = [3, 9];
const MAX = [3, 13];

const run = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });

function versionOf(cmd, args = []) {
  const r = run(cmd, [...args, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])']);
  if (r.status !== 0) return null;
  const m = /^(\d+)\.(\d+)/.exec(r.stdout.trim());
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const inRange = (v) =>
  v && (v[0] > MIN[0] || (v[0] === MIN[0] && v[1] >= MIN[1])) &&
  (v[0] < MAX[0] || (v[0] === MAX[0] && v[1] <= MAX[1]));

function findHostPython() {
  const candidates = [];
  if (process.env.PYTHON) candidates.push([process.env.PYTHON, []]);
  candidates.push(['python3', []], ['python', []]);
  // Newest first, but skipping versions with no wheels yet — a fresh machine
  // often has only a too-new Python on PATH, which is the confusing case.
  if (WIN) for (let m = MAX[1]; m >= MIN[1]; m--) candidates.push(['py', [`-3.${m}`]]);
  else for (let m = MAX[1]; m >= MIN[1]; m--) candidates.push([`python3.${m}`, []]);

  const rejected = [];
  for (const [cmd, args] of candidates) {
    const v = versionOf(cmd, args);
    if (!v) continue;
    if (inRange(v)) return { cmd, args, version: v.join('.') };
    rejected.push(`${cmd}${args.length ? ' ' + args.join(' ') : ''} is ${v.join('.')}`);
  }
  return { rejected };
}

const host = findHostPython();
if (!host.cmd) {
  console.error(
    `No Python between ${MIN.join('.')} and ${MAX.join('.')} found` +
      (host.rejected?.length ? ` (saw: ${host.rejected.join(', ')})` : '') +
      `.\n${PKG} only publishes wheels for those versions. Install one from ` +
      `https://www.python.org/downloads/ and re-run, or set PYTHON to a suitable interpreter.`
  );
  process.exit(1);
}

// On Windows OCP's DLL loader fails with "filename or extension is too long"
// once its own package path runs past MAX_PATH — and site-packages under a
// deep checkout gets there easily. Warn before spending the download.
if (WIN && VENV_DIR.length > 100) {
  console.warn(
    `! ${VENV_DIR} is ${VENV_DIR.length} characters deep.\n` +
      `  Windows may refuse to load OpenCascade's DLLs from there (MAX_PATH).\n` +
      `  If the check below fails, create the venv somewhere shorter and set\n` +
      `  WHEELWRIGHT_PYTHON to its python.exe instead.\n`
  );
}

const py = venvPython();
if (!fs.existsSync(py)) {
  console.log(`Creating virtualenv (Python ${host.version}) in ${VENV_DIR}…`);
  fs.mkdirSync(path.dirname(VENV_DIR), { recursive: true });
  const mk = run(host.cmd, [...host.args, '-m', 'venv', VENV_DIR], { stdio: 'inherit' });
  if (mk.status !== 0) {
    console.error('Could not create the virtualenv.');
    process.exit(1);
  }
} else {
  console.log(`Reusing virtualenv in ${VENV_DIR}`);
}

console.log(`Installing ${PKG} (OpenCascade — a few hundred MB, one time)…`);
const install = run(py, ['-m', 'pip', 'install', '--upgrade', PKG], { stdio: 'inherit' });
if (install.status !== 0) {
  console.error(`\npip install ${PKG} failed.`);
  process.exit(1);
}

const check = run(py, ['-c', 'import OCP; print(OCP.__version__)']);
if (check.status !== 0) {
  console.error(
    `\nInstalled, but importing OpenCascade failed:\n${(check.stderr || '').trim()}\n\n` +
      (WIN && /too long/i.test(check.stderr || '')
        ? 'That is the Windows MAX_PATH limit. Create the venv somewhere shorter\n' +
          '(e.g. C:\\occ-venv) and set WHEELWRIGHT_PYTHON to its python.exe.'
        : 'Try re-running, or install into your own interpreter and set WHEELWRIGHT_PYTHON.')
  );
  process.exit(1);
}

console.log(`\n✓ OpenCascade ${check.stdout.trim()} ready → ${py}`);
console.log('  Restart the server; STL/STEP export is now enabled.');
