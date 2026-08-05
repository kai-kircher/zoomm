// Wheelwright server — static UI + JSON API + Zoo STL export proxy.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { planWheel } from './src/lib/wheel.js';
import { generateKcl, slugFor } from './src/lib/kclgen.js';
import { zipStore } from './src/lib/zip.js';
import { zooStatus, exportStl } from './src/lib/zoo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(join(__dirname, 'public')));
// The browser imports the same planner the server uses.
app.use('/lib', express.static(join(__dirname, 'src', 'lib')));

const handle = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
};

app.get('/api/health', (req, res) => {
  res.json({ ok: true, zoo: zooStatus() });
});

app.post('/api/plan', handle((req, res) => {
  res.json(planWheel(req.body || {}));
}));

app.post('/api/kcl', handle((req, res) => {
  const plan = planWheel(req.body || {});
  res.json({ slug: slugFor(plan), files: generateKcl(plan) });
}));

app.post('/api/kcl.zip', handle((req, res) => {
  const plan = planWheel(req.body || {});
  const slug = slugFor(plan);
  const files = generateKcl(plan).map((f) => ({ name: `${slug}/${f.name}`, data: f.content }));
  const zip = zipStore(files);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${slug}-kcl.zip"`);
  res.send(zip);
}));

app.post('/api/export/stl', (req, res) => {
  let plan;
  try {
    plan = planWheel(req.body || {});
  } catch (e) {
    return res.status(400).json({ error: String(e.message || e) });
  }
  const slug = slugFor(plan);
  const files = generateKcl(plan);
  try {
    const stls = exportStl(files);
    const entries = [
      ...stls.map((s) => ({ name: `${slug}/${s.name}`, data: s.data })),
      ...files.filter((f) => f.kind !== 'kcl').map((f) => ({ name: `${slug}/${f.name}`, data: f.content })),
    ];
    const zip = zipStore(entries);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${slug}-stl.zip"`);
    res.send(zip);
  } catch (e) {
    const status = e.code === 'no-cli' || e.code === 'no-token' ? 503 : 500;
    res.status(status).json({
      error: String(e.message || e),
      code: e.code || 'error',
      how:
        'To enable one-click STL export, install the Zoo CLI (https://zoo.dev/docs/developer-tools/cli) on the server and set ZOO_API_TOKEN. ' +
        'Meanwhile: download the KCL zip and run `zoo kcl export --output-format=stl piece-A.kcl .` locally, or open the .kcl files in Zoo Design Studio and export there.',
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  const z = zooStatus();
  console.log(`Wheelwright listening on http://localhost:${port}`);
  console.log(`Zoo CLI: ${z.cli ? 'found' : 'not found'} | ZOO_API_TOKEN: ${z.token ? 'set' : 'not set'} → STL export ${z.ready ? 'ENABLED' : 'disabled (KCL download still works)'}`);
});
