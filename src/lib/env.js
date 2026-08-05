// Minimal .env loader — no dependencies, mirroring dotenv semantics:
// KEY=VALUE lines, `#` comments, optional single/double quotes, `export `
// prefix tolerated. Loads `.env` then `.env.local` (later file wins), but
// never overrides variables already present in the real environment.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadEnv(dir = process.cwd(), files = ['.env', '.env.local']) {
  const loaded = {};
  for (const f of files) {
    let text;
    try {
      text = readFileSync(join(dir, f), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      if (line.trim().startsWith('#')) continue;
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) {
        v = v.slice(1, -1);
      } else {
        v = v.replace(/\s+#.*$/, '').trim();
      }
      loaded[m[1]] = v;
    }
  }
  const applied = [];
  for (const [k, v] of Object.entries(loaded)) {
    if (process.env[k] === undefined || process.env[k] === '') {
      process.env[k] = v;
      applied.push(k);
    }
  }
  return applied;
}
