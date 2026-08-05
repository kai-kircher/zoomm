// Wheelwright server — static UI + JSON API + Zoo STL export proxy.

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadEnv } from './src/lib/env.js';
import { planWheel } from './src/lib/wheel.js';
import { generateKcl, slugFor } from './src/lib/kclgen.js';
import { zipStore } from './src/lib/zip.js';
import { zooStatus, exportStl } from './src/lib/zoo.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv(__dirname); // seed ZOO_API_TOKEN etc. from .env / .env.local
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

// A token pasted in the browser arrives per-request in this header; it is
// used for that request only — never logged, never persisted server-side.
const tokenFrom = (req) => req.get('x-zoo-token') || null;

app.get('/api/health', (req, res) => {
  res.json({ ok: true, zoo: zooStatus(tokenFrom(req)) });
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
    const stls = exportStl(files, tokenFrom(req));
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
        e.code === 'no-token'
          ? 'Copy .env.example to .env and set ZOO_API_TOKEN (get one at https://zoo.dev/account/api-tokens), or paste a token in the Zoo settings panel (top right). ' +
            'Meanwhile: download the KCL zip and export with the Zoo CLI or Design Studio.'
          : 'To enable one-click STL export, run `npm run setup:zoo` in the project (downloads the Zoo CLI into ./bin), then restart the server. ' +
            'Alternatively install the CLI yourself (https://zoo.dev/docs/developer-tools/cli) or point ZOO_CLI_PATH in .env at the binary. ' +
            'Meanwhile: download the KCL zip and open the .kcl files in Zoo Design Studio to export there.',
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  const z = zooStatus();
  console.log(`Wheelwright listening on http://localhost:${port}`);
  console.log(
    `Zoo CLI: ${z.cli ? `found (${z.cliVersion})` : 'not found — run: npm run setup:zoo'} | token: ${z.token ? 'set' : 'not set (.env or browser)'} → STL export ${z.ready ? 'ENABLED' : 'disabled (KCL download still works)'}`
  );
});
