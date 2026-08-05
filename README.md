# 🛞 Wheelwright

**Any wheel, any printer.** A parametric configurator for 3D-printable wheels that automatically
splits the wheel into segments that fit *your* printer's build volume and slide together with
dovetail joints — no CAD required. Built for the [Zoo](https://zoo.dev) API makeathon: every
configuration compiles to ready-to-run **KCL**, and Zoo's engine turns it into STLs.

Want a 14″ airless tire for your cart project but only own an Ender-sized printer? Type in the
wheel you want and the envelope you have; Wheelwright hands you the pieces, the print settings,
and the glue-up instructions.

![Wheelwright — 14in cart wheel exploded into 6 dovetailed segments](docs/screenshot-cart.png)

## What it does

- **Configure the wheel**: diameter, width, material (PLA/PETG/ABS/TPU), web structure
  (spokes / honeycomb / airless flex-web / solid), tread (lugged / ribbed / diamond / slick),
  and hub interface (keyed shaft, plain, hex, D-bore, or bolt circle with pilot).
- **Give it your print envelope**: bed X/Y, height Z, edge margin.
- **It plans the build**: picks the smallest segment count whose pieces fit the bed, sizes
  slide-together dovetails into the rim and hub rings, keeps structural webs clear of the seams,
  and dedupes pieces — a keyed 6-segment wheel is "print A×1, B×5", not six different files.
- **It generates KCL**: one file per unique piece, in Zoo's modern solver-sketch dialect, lying
  print-flat on XY. Plus a generated `ASSEMBLY.md` (print settings, adhesive choice, glue-up
  steps) and a JSON manifest.
- **Zoo makes the STLs**: one click on a server with the [Zoo CLI](https://zoo.dev/docs/developer-tools/cli)
  + `ZOO_API_TOKEN`, or open the `.kcl` files in [Zoo Design Studio](https://zoo.dev/design-studio)
  and export there.

| Airless TPU rover wheel (flex-web, hex bore) | Printer-fit check against your envelope |
|---|---|
| ![Rover airless wheel](docs/screenshot-rover.png) | ![Printer fit view](docs/screenshot-fit.png) |

## Quickstart

```sh
npm install
npm start          # http://localhost:3000
```

Optional, for one-click STL export from the UI — install the
[Zoo CLI](https://zoo.dev/docs/developer-tools/cli) and provide a token either way:

```sh
cp .env.example .env    # then set ZOO_API_TOKEN (https://zoo.dev/account/api-tokens)
npm start
```

…or click the **Zoo status pill** (top right in the app) and paste a token there. A pasted
token lives in that browser's localStorage only and rides each request in an `x-zoo-token`
header — the server uses it per-request and never stores or logs it. `.env` / `.env.local`
are loaded by a tiny dependency-free loader (real environment variables always win), and the
CLI is found via `PATH`, `ZOO_CLI_PATH`, or a `./bin/zoo` drop-in.

Without the CLI/token the app still does everything except server-side STL conversion — you
download the KCL bundle and run `zoo kcl export --output-format=stl piece-A.kcl .` yourself, or
export from Design Studio.

```sh
npm test           # 21 unit tests: chunking math, joints, dedupe, KCL well-formedness
npm run validate:kcl   # regenerates a config matrix; round-trips through Zoo's engine when a token is set
```

## How it works

```
  browser form ──► planWheel()  (src/lib/wheel.js — pure JS, runs in browser AND server)
                      │
                      ├─ segment-count solver (annular-sector bbox vs. usable bed, prefers
                      │  counts that make pieces identical for your hub's symmetry)
                      ├─ dovetail sizing (rim ring + hub ring; clearance per side)
                      ├─ web layout (spokes / honeycomb cells / curved flex-web slots),
                      │  kept clear of seam keep-outs so joints stay solid
                      ├─ tread cutters (circumferential groove rings, axial lug slots —
                      │  pattern counts snap to multiples of N so seams land between features)
                      └─ per-piece hub features + signature dedupe (keyway/D-flat/bolt windows)
                      │
        ┌─────────────┴──────────────┐
        ▼                            ▼
  Three.js preview            KCL generator (src/lib/kclgen.js)
  (same plan, exploded        one .kcl per unique piece +
  view + printer-fit view)    ASSEMBLY.md + manifest
                                     │
                                     ▼
                          Zoo engine (zoo kcl export / Design Studio) ──► STLs
```

One geometry plan feeds both the preview and the code generator, so what you see is what the
engine builds. Everything is derived on configure — there is no model library.

### The segmentation scheme

Segments are annular wedges cut by radial seams. Each seam carries **axial slide dovetails**
(trapezoidal tenon on one face, clearance pocket on the other) placed in the solid rim ring and
hub ring, so all pieces slide together along the axle direction and any piece can be inserted
last. Dovetails resist the circumferential separation; axial retention comes from the adhesive
(plus hub bolts, when you pick a bolt-circle hub). Because the tenon/pocket geometry is part of
each piece's 2D outline, the generated KCL needs nothing beyond sketches, regions, extrudes and
subtracts — the most battle-tested ops in the engine.

The wedges extend inward past the bore line and the bore tool (round, keyed, hex, D, or pilot +
bolt circle) is subtracted per piece, so the assembled hub carries the exact mating feature with
your chosen fit clearance.

### Why the pieces come out identical

Feature-aware deduplication: the planner computes which segment windows intersect the keyway /
D-flat / bolt holes and hashes each piece's canonical feature set. The segment-count solver
prefers (within fit constraints) counts that match the hub's rotational symmetry — e.g. hex
bores like 2/3/6/12 segments — so most wheels are "print one file N times".

### Adhesive guidance (the flexible-glue question)

The app recommends per material, and bakes it into the generated `ASSEMBLY.md`:

- **TPU** — flexible contact adhesive (E6000 / Shoe Goo class); rigid glue lines crack on a
  flexing tire.
- **PETG / PLA** — flexible polyurethane construction adhesive (Loctite PL Premium class): wheels
  live with shock and vibration, and slightly-flexible PU beats brittle CA. Epoxy if you want
  maximum stiffness.
- **ABS/ASA** — acetone solvent weld for a near-monolithic wheel, or PU where impact matters.

Thin bead in each dovetail pocket and along both faces, slide, wipe, cure 24 h. Dry-fit first —
the default 0.15 mm/side joint clearance suits most printers and is tunable.

## The generated KCL

Modern solver-sketch dialect, pinned to `kclVersion = 1.0` (the same pin Zoo's shipping samples
use), with exact precomputed coordinates — nothing for the solver to solve, nothing ambiguous
for the engine:

```kcl
@settings(defaultLengthUnit = mm, kclVersion = 1.0)

outlineSk = sketch(on = XY) {
  e1 = line(start = [9.2, 0], end = [166.03, 0])
  ...
  e10 = arc(start = [177.8, 0], end = [88.9, 153.9793], center = [0, 0])
  ...
}
blank = extrude(region(point = [98.68, 49.34], sketch = outlineSk), length = 50)

cut1Sk = sketch(on = offsetPlane(XY, offset = -1)) {
  c1 = circle(start = [10.2, 0], center = [0, 0])
}
cut1 = extrude(region(segments = [cut1Sk.c1]), length = 52)
...
piece = subtract([blank], tools = [cut1, cut2, ...])
```

Cutters overshoot the part in Z, boolean tool batches are bounded, and arcs are emitted
start/end/center in CCW order per the KCL spec.

## API

Everything the UI does is plain JSON over HTTP:

| Endpoint | What |
|---|---|
| `POST /api/plan` | Full geometry plan (segments, joints, warnings, per-piece cutters) |
| `POST /api/kcl` | Generated files as JSON |
| `POST /api/kcl.zip` | KCL bundle download |
| `POST /api/export/stl` | STL bundle via the Zoo engine (503 + instructions if CLI/token missing) |
| `GET /api/health` | Zoo CLI/token status |

Request body = the same parameter object the form produces (all fields optional; see
`DEFAULTS` in [`src/lib/wheel.js`](src/lib/wheel.js)).

## Repo layout

```
server.js               express: static UI + API + Zoo export proxy
src/lib/wheel.js        the planner (pure, shared browser/server)
src/lib/kclgen.js       KCL emitter + assembly guide generator
src/lib/zoo.js          zoo CLI wrapper for KCL → STL
src/lib/zip.js          dependency-free ZIP writer
public/                 UI (vanilla JS + vendored three.js, 2D canvas fallback)
scripts/validate-kcl.js engine round-trip validation for a config matrix
test/                   node:test suite
```

## Honest limitations & roadmap

- Very large wheels on very small printers hit a pie-slice depth limit (piece depth ≈ wheel
  radius). The fix is a second split ring (tire ring + hub ring as separate dovetailed
  assemblies) — planned, warned about today.
- Wheel width taller than the printer Z is warned, not yet auto-split axially.
- Tread/tenon edges are sharp (no chamfered lead-ins yet); slicers' seam-aware placement and a
  light file fix the first-fit experience.
- Preview approximates tread visually; the KCL carries the exact cuts.
- Wishlist: Text-to-CAD hub-cap emblems ("a snarling wolf, embossed"), mass/inertia estimates
  via Zoo's file API, chamfered joint lead-ins, per-piece print-time estimates.
