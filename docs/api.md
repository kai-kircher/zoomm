# HTTP API

Everything the UI does is plain JSON over HTTP against the same planner the
browser runs. There is no session, no database, and no state: a request carries
the whole configuration and gets back the whole answer.

Base URL is wherever the server runs (`http://localhost:3000` by default).

| Endpoint | Method | Returns |
| --- | --- | --- |
| [`/api/health`](#get-apihealth) | GET | Zoo CLI / token status |
| [`/api/plan`](#post-apiplan) | POST | The full geometry plan |
| [`/api/kcl`](#post-apikcl) | POST | Generated files as JSON |
| [`/api/kcl.zip`](#post-apikclzip) | POST | KCL bundle as a ZIP download |
| [`/api/export/stl`](#post-apiexportstl) | POST | STL bundle via the Zoo engine |

Request bodies are the same **parameter object** everywhere (see
[§ Parameters](#parameters)); every field is optional and falls back to
`DEFAULTS` in [`src/lib/wheel.js`](../src/lib/wheel.js).

---

## GET /api/health

```sh
curl -s localhost:3000/api/health
```

```json
{
  "ok": true,
  "zoo": { "cli": true, "cliVersion": "zoo 0.2.186", "token": true, "ready": true }
}
```

`ready` is `cli && token` — the only condition under which `/api/export/stl`
can work. Pass a browser-held token as a header to test it:
`-H "x-zoo-token: …"`.

## POST /api/plan

The planner's output verbatim — the same object the preview renders.

```sh
curl -s localhost:3000/api/plan -H 'content-type: application/json' \
  -d '{"diameter":355.6,"width":50,"infill":"honeycomb","bore":{"type":"keyed"}}'
```

Response shape (abridged):

```jsonc
{
  "params": { …the normalized parameters, all lengths in mm… },
  "radii":  { "R": 177.8, "rRimIn": 163.3, "rHub": 39.5, "rInner": 9.2, … },
  "W": 50,                      // wheel width = piece height when printed
  "N": 6,                       // segments
  "segAngle": 60,
  "joints": [ { "r": 30.6, "hn": 2.4, "hh": 3.9, "d": 4.5, "tag": "hub" }, … ],
  "jointClearance": 0.15,
  "outline": { "kind": "sector", "segs": [ … ], "interior": [x, y] },
  "pieces": [ { "k": 0, "label": "A" }, { "k": 1, "label": "B" }, … ],
  "uniquePieces": [
    { "label": "A", "count": 1, "ks": [0], "cutters": [ … ] },
    { "label": "B", "count": 5, "ks": [1,2,3,4,5], "cutters": [ … ] }
  ],
  "infillInfo": { "style": "honeycomb", "cellsPerSegment": 34, "wall": 2.6, … },
  "treadInfo":  { "style": "lugged", "crown": "flat", "bars": 54, "barsPerSegment": 9, "barWidth": 14.1 },
  "profile":    { "shape": "flat", "crownDrop": 0, "crownRadius": 0, "shoulderR": 177.8 },
  "sections":   [ { "z": 0, "kind": "sector", "segs": [ … ], "interior": [x, y] } ],
  "bbox": { "w": 178.5, "d": 146, "rotForPrint": 60 },
  "fit":  { "usable": {"x":210,"y":210,"z":250}, "wholeFits": false, "pieceFits": true },
  "glue": { "name": "…", "why": "…", "tips": "…" },
  "printRec": { "orientation": "…", "walls": 4, "infillPct": 30, "infillPattern": "gyroid", "note": "…" },
  "warnings": [], "notes": []
}
```

Geometry conventions:

- **All lengths are millimetres, all angles degrees.** Inch input is converted
  during normalization; the plan never carries inches.
- The **canonical piece frame** puts the sector on `[0°, segAngle]` with the
  wheel centre at the origin. `bbox.rotForPrint` is the rotation that lays it
  out symmetric for printing.
- `sections` is the piece's boundary at one or more heights across the width,
  each a closed loop of `{kind:"line", a, b}` and
  `{kind:"arc", a, b, center, radius, ccw}` plus a region seed. Dovetail tenons
  and pockets are part of it, and so are the tread bars — they are notches in
  the outer boundary, not cutters. A flat wheel has exactly one section and is
  extruded; anything that varies with height (a crown, slanted bars,
  circumferential grooves on a crowned tread) has several and is lofted. All
  sections of a piece are congruent — same entity count, same order.
- `outline` is the widest section (mid-width), i.e. the piece's silhouette. Use
  it for footprint and flat-view work; use `sections` to build the solid.
- Each cutter is a prism: a profile (`circle` / `annulus` / `poly` / `path`)
  plus a `z0`/`z1` range. Only cuts that stop partway through the width are
  cutters now — everything full-depth is a loop in the section sketch. Cutters
  that do span the width overshoot the part by 1 mm each end.

`warnings` are things the caller should act on; `notes` are decisions the
planner made. Both are plain strings, already user-readable.

## POST /api/kcl

```sh
curl -s localhost:3000/api/kcl -H 'content-type: application/json' -d '{}' \
  | jq -r '.files[] | .name'
```

```json
{
  "slug": "wheel-d356-w50-keyed-6seg",
  "files": [
    { "name": "piece-A.kcl",      "kind": "kcl",      "content": "…" },
    { "name": "piece-B.kcl",      "kind": "kcl",      "content": "…" },
    { "name": "ASSEMBLY.md",      "kind": "doc",      "content": "…" },
    { "name": "wheelwright.json", "kind": "manifest", "content": "…" }
  ]
}
```

One `.kcl` per **unique** piece — check `uniquePieces[].count` (or the manifest)
for how many of each to print.

## POST /api/kcl.zip

Same input; responds with `application/zip` and a
`Content-Disposition: attachment` filename derived from the slug. Entries are
nested under the slug directory.

```sh
curl -s localhost:3000/api/kcl.zip -H 'content-type: application/json' \
  -d '{"diameter":200,"infill":"voronoi"}' -o wheel.zip
```

## POST /api/export/stl

Generates the KCL, runs every piece through `zoo kcl export`, and returns a ZIP
of the STLs plus the non-KCL files (assembly guide, manifest).

```sh
curl -s localhost:3000/api/export/stl -H 'content-type: application/json' \
  -H 'x-zoo-token: <token>' -d '{"diameter":120,"width":30}' -o wheel-stl.zip
```

Errors are JSON with a machine-readable `code` and a human `how`:

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | — | The parameters could not be planned. |
| 503 | `no-cli` | The `zoo` binary was not found on the server. |
| 503 | `no-token` | No token in `.env`, the environment, or the `x-zoo-token` header. |
| 500 | `export-failed` | The engine rejected the KCL, produced no STL, or the CLI exited non-zero. The message carries up to 2 000 characters of CLI stderr. |

```json
{
  "error": "The `zoo` CLI is not installed on this server.",
  "code": "no-cli",
  "how": "To enable one-click STL export, run `npm run setup:zoo` …"
}
```

**Timing.** Export is synchronous and can be slow: we have measured 1.4 s for a
plain bore, ~85 s for a 69-cutter honeycomb wheel, and a reproducible case that
never returns at all (see
[zoo-api-notes.md](zoo-api-notes.md#ww-2--export-time-is-wildly-unpredictable-and-sometimes-never-ends)).
Give any client a generous timeout, and prefer `/api/kcl` plus your own export
scheduling for batch work.

---

## Parameters

Send any subset; unknown groups fall back to defaults. Lengths are in the unit
named by `units` (`"mm"` default, `"in"` accepted and converted).

```jsonc
{
  "units": "mm",
  "diameter": 355.6,            // 30–1500 mm
  "width": 50,                  // 6–400 mm
  "material": "petg",           // pla | petg | abs | tpu
  "infill": "spokes",           // solid | spokes | honeycomb | flexweb | lattice | auxetic | voronoi
  "spokeCount": 0,              // 0 = auto; snapped to a multiple of the segment count
  "tread": "lugged",            // slick | ribbed | lugged | diamond | chevron | angled
  "treadDepth": 3.5,            // 0.8 mm – 6 % of diameter
  "treadCount": 0,              // bars around the wheel; 0 = auto, snapped to a multiple of N
  "treadAngle": 25,             // bar slant off the axis, degrees (angled | chevron)
  "ribCount": 0,                // circumferential grooves; 0 = auto
  "profile": {
    "shape": "flat",            // flat | crowned | round
    "crownDrop": 0              // mm the radius falls to each shoulder; 0 = auto
  },
  "bore": {
    "type": "keyed",            // plain | keyed | hex | dbore | bolt
    "diameter": 20, "keyWidth": 6, "keyDepth": 2.8,
    "hexAcrossFlats": 13, "flatOffset": 0,
    "boltCount": 4, "boltCircle": 60, "boltHoleDia": 5.5, "pilotDia": 12
  },
  "honeycomb": { "cellSize": 0, "wall": 2.6, "orientation": "radial",
                 "cellShape": "hex", "cornerRadius": 0, "maxCells": 64 },
  "lattice":   { "rows": 0, "struts": 0, "strutWidth": 4, "cornerRadius": 1.5 },
  "auxetic":   { "rings": 0, "cellSize": 0, "wall": 3, "waist": 0.45, "cornerRadius": 1.2 },
  "voronoi":   { "cells": 0, "wall": 3, "seed": 1, "cornerRadius": 1.2 },
  "printer": { "x": 220, "y": 220, "z": 250, "margin": 10 },
  "joint": { "clearance": 0.15 },   // 0.05–0.6 mm per side
  "boreClearance": 0.2,             // 0–1 mm, added all round
  "segmentsOverride": 0             // 0 = auto, else 1–16
}
```

Out-of-range values are **clamped, not rejected** — a configurator replans on
every keystroke and half-typed numbers shouldn't 400. Clamps that change intent
come back in `warnings`.

## Using the planner directly

The planner is a dependency-free ES module and is the fastest path for scripting:

```js
import { planWheel } from './src/lib/wheel.js';
import { generateKcl, slugFor } from './src/lib/kclgen.js';

const plan = planWheel({ diameter: 300, infill: 'auxetic', bore: { type: 'hex' } });
console.log(plan.N, plan.uniquePieces.map((u) => `${u.label}×${u.count}`).join(' '));
for (const f of generateKcl(plan)) writeFileSync(`${slugFor(plan)}-${f.name}`, f.content);
```

The browser imports the very same file from `/lib/wheel.js`, which is why the
preview and the generated CAD cannot disagree.

`scripts/validate-kcl.js` is a worked example: it plans a matrix of
configurations, writes each bundle, and — when a Zoo CLI and token are available
— exports every piece through the engine and fails the run on the first
rejection.
