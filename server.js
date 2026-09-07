// Wheelwright server — static UI + JSON API + OpenCascade build service.

import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './src/lib/env.js';
import { planWheel } from './src/lib/wheel.js';
import { generateSource, slugFor, RUNTIME_FILES } from './src/lib/occgen.js';
import { zipStore } from './src/lib/zip.js';
import { occStatus, buildPieces } from './src/lib/occ.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(__dirname); // seed PORT / WHEELWRIGHT_PYTHON from .env / .env.local

// The Python that ships inside every bundle, read once. Both the download and
// the server-side build use these same bytes, so a bundle a user builds
// themselves cannot drift from what the app built for them.
const RUNTIME = Object.fromEntries(
  RUNTIME_FILES.map((n) => [n, readFileSync(join(__dirname, 'src', 'lib', 'occ', n), 'utf8')])
);

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, 'public')));
// The browser imports the same planner and generator the server uses, and
// fetches the same runtime Python to put in the bundles it builds client-side.
// Mounted at its real path so that `../src/lib/…` — the relative import
// `public/preview.js` needs in order to also load under `node --test` —
// resolves to the same URL here, and the browser gets one module instance.
app.use('/src/lib', express.static(join(__dirname, 'src', 'lib')));

const handle = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
};

const bundleFor = (body) => {
  const plan = planWheel(body || {});
  return { plan, slug: slugFor(plan), files: generateSource(plan, RUNTIME) };
};

app.get('/api/health', (req, res) => {
  res.json({ ok: true, occ: occStatus() });
});

app.post('/api/plan', handle((req, res) => {
  res.json(planWheel(req.body || {}));
}));

app.post('/api/source', handle((req, res) => {
  const { slug, files } = bundleFor(req.body);
  res.json({ slug, files });
}));

app.post('/api/source.zip', handle((req, res) => {
  const { slug, files } = bundleFor(req.body);
  const zip = zipStore(files.map((f) => ({ name: `${slug}/${f.name}`, data: f.content })));
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-source.zip"`);
  res.send(zip);
}));

app.post('/api/export/stl', (req, res) => {
  let bundle;
  try {
    bundle = bundleFor(req.body);
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
  const { slug, files } = bundle;
  // `step` is cheap here and is the format every other CAD tool can open, so
  // the export carries both rather than making the user choose.
  const formats = req.query.formats ? String(req.query.formats).split(',') : ['stl', 'step'];
  try {
    const built = buildPieces(files, { formats });
    const entries = [
      ...built.map((b) => ({ name: `${slug}/${b.name}`, data: b.data })),
      ...files
        .filter((f) => f.kind !== 'runtime')
        .map((f) => ({ name: `${slug}/${f.name}`, data: f.content })),
    ];
    const zip = zipStore(entries);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-stl.zip"`);
    res.send(zip);
  } catch (e) {
    res.status(e.code === 'no-python' ? 503 : 500).json({
      error: String(e.message || e),
      code: e.code || 'error',
      how:
        e.code === 'no-python'
          ? 'Run `npm run setup:occ` in the project (creates a virtualenv in ./bin and installs ' +
            'OpenCascade), then restart the server. Or install it yourself with ' +
            '`pip install cadquery-ocp` and point WHEELWRIGHT_PYTHON at that interpreter. ' +
            'Meanwhile: download the source bundle and run `python build.py .` in it.'
          : 'This is a geometry failure rather than a setup one. Download the source bundle and ' +
            'run `python build.py .` to see the full traceback, and please report the ' +
            'configuration.',
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  const s = occStatus();
  console.log(`Wheelwright listening on http://localhost:${port}`);
  console.log(
    `OpenCascade: ${
      s.ready ? `ready (OCP ${s.occtVersion} via ${s.pythonPath})` : 'not found — run: npm run setup:occ'
    } → STL/STEP export ${s.ready ? 'ENABLED' : 'disabled (source bundle download still works)'}`
  );
});
