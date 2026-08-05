#!/usr/bin/env node
/**
 * Downloads the Zoo CLI binary for this platform into ./bin.
 * The CLI is what executes generated KCL against the Zoo Design API engine —
 * without it the app still generates KCL, but can't produce STLs itself.
 *
 *   npm run setup:zoo
 *
 * Defaults to the latest release (wheelwright generates current-dialect KCL);
 * pin with ZOO_CLI_VERSION=vX.Y.Z if you need a specific engine version.
 * Same approach as zapim's scripts/setup-zoo-cli.mjs.
 */

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";

const requested = process.env.ZOO_CLI_VERSION || "latest";

const MAP = {
  "win32-x64": { asset: "zoo-x86_64-pc-windows-gnu", exe: "zoo.exe" },
  "darwin-arm64": { asset: "zoo-aarch64-apple-darwin", exe: "zoo" },
  "darwin-x64": { asset: "zoo-x86_64-apple-darwin", exe: "zoo" },
  "linux-x64": { asset: "zoo-x86_64-unknown-linux-musl", exe: "zoo" },
  "linux-arm64": { asset: "zoo-aarch64-unknown-linux-musl", exe: "zoo" },
};

const key = `${process.platform}-${process.arch}`;
const target = MAP[key];
if (!target) {
  console.error(`No prebuilt zoo CLI for ${key}. Install manually: https://zoo.dev/docs/developer-tools/cli`);
  process.exit(1);
}

const relUrl =
  requested === "latest"
    ? "https://api.github.com/repos/KittyCAD/cli/releases/latest"
    : `https://api.github.com/repos/KittyCAD/cli/releases/tags/${requested}`;

console.log(`Fetching zoo CLI release info (${requested})…`);
const relRes = await fetch(relUrl, {
  headers: { Accept: "application/vnd.github+json", "User-Agent": "wheelwright-setup" },
});
if (!relRes.ok) {
  console.error(`GitHub API error ${relRes.status} — try again, or install manually: https://zoo.dev/docs/developer-tools/cli`);
  process.exit(1);
}
const rel = await relRes.json();
const wantVersion = rel.tag_name.replace(/^v/, "");

const binDir = path.join(process.cwd(), "bin");
const dest = path.join(binDir, target.exe);
if (fs.existsSync(dest)) {
  const v = spawnSync(dest, ["--version"], { encoding: "utf8" });
  const have = v.status === 0 ? (v.stdout.trim().match(/[\d.]+/) || [""])[0] : "";
  if (have === wantVersion) {
    console.log(`zoo CLI ${have} already installed at ${dest}`);
    process.exit(0);
  }
  console.log(`Replacing zoo CLI ${have || "(unknown)"} with ${wantVersion}…`);
}

const asset = rel.assets.find((a) => a.name === target.asset);
if (!asset) {
  console.error(`Release ${rel.tag_name} has no asset named ${target.asset}.`);
  process.exit(1);
}

console.log(`Downloading ${asset.name} ${rel.tag_name} (${Math.round(asset.size / 1e6)} MB)…`);
fs.mkdirSync(binDir, { recursive: true });
const dl = await fetch(asset.browser_download_url, { headers: { "User-Agent": "wheelwright-setup" } });
if (!dl.ok || !dl.body) {
  console.error(`Download failed: HTTP ${dl.status}`);
  process.exit(1);
}
await pipeline(Readable.fromWeb(dl.body), fs.createWriteStream(dest));
if (process.platform !== "win32") fs.chmodSync(dest, 0o755);

const check = spawnSync(dest, ["--version"], { encoding: "utf8" });
if (check.status === 0) {
  console.log(`✓ Installed ${check.stdout.trim()} → ${dest}`);
  console.log(`  Token: set ZOO_API_TOKEN in .env (https://zoo.dev/account/api-tokens) or paste it in the app's Zoo panel.`);
} else {
  console.error(`Downloaded but --version failed: ${check.stderr || check.error}`);
  process.exit(1);
}
