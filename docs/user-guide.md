# Wheelwright user guide

How to install it, what every control does, and how to get from "I need a wheel"
to printed pieces that slide together. For the design rationale and the geometry
behind it, see [architecture.md](architecture.md); for the HTTP surface, see
[api.md](api.md).

---

## 1. Install and run

```sh
npm install
npm start          # http://localhost:3000
```

Node ≥ 18. The only runtime dependency is Express; three.js is vendored under
`public/vendor/`, so the app works offline once installed.

Set `PORT` if 3000 is taken:

```bash
PORT=4000 npm start
```

### Optional: one-click STL + STEP

Wheelwright builds its solids with [OpenCascade](https://dev.opencascade.org/),
the geometry kernel behind FreeCAD. It runs on your machine — there is no
account, no token and no network call. One command installs it:

```sh
npm run setup:occ       # venv in ./bin with `pip install cadquery-ocp`
npm start
```

It needs a Python between 3.9 and 3.13 on your machine; the script finds one
and tells you if it can't. If you already have `cadquery-ocp` somewhere, skip
the setup and set `WHEELWRIGHT_PYTHON` to that interpreter instead.

The kernel pill in the top-right tells you where you stand:

| Pill | Meaning |
| --- | --- |
| `build ready` | OpenCascade found — the **Build** button works. |
| `kernel setup` | Not installed; open the panel for the command. The source bundle still downloads. |
| `static mode` | `/api/health` didn't answer — you are on a static host, or the server is down. |

**Nothing else depends on it.** Configuring, previewing, planning and
downloading the source bundle are entirely local either way — and the bundle
carries the build code, so you can always run `python build.py .` in it.

---

## 2. Five minutes, start to finish

1. **Pick a preset** — click *14″ cart wheel*. The form fills in inches, the
   preview replans instantly.
2. **Read the build plan** (right panel). With the stock 220 × 220 × 250 mm
   printer you should see:

   ```
   Ø355.6 × 50 mm — split into 6 segments of 60°
   Piece footprint   178.5 × 146 × 50 mm
   Usable bed        210 × 210 × 250 mm
   Joints per seam   2 dovetails (hub, rim)
   Web               6 spokes
   Tread             lugged (54 bars)
   Profile           flat (cylindrical)
   piece A × 1   fits printer
   piece B × 5   fits printer
   ```

   Six segments, but only **two** files: piece A carries the keyway, the other
   five are identical.
3. **Look at it.** Drag to orbit, scroll to zoom, and use the **Explode**
   slider to pull the segments apart and see the dovetails.
4. **Check the fit.** Tick **Printer-fit view**: one piece is laid out
   print-oriented inside your usable build volume.
5. **Take the geometry.** *Download source bundle (.zip)* gives you
   `piece-A.py`, `piece-B.py`, the two build files, `ASSEMBLY.md` and
   `wheelwright.json`.
6. **Get the solids.** Tick the formats you want — `.stl` for slicing, `.step`
   for CAD, both by default — and press *Build*. Or run
   `pip install cadquery-ocp && python build.py .` inside the bundle and
   export from there, where the same choice is `--formats stl` or
   `--formats step`.

---

## 3. The controls

Everything replans live (120 ms debounce) — there is no "generate" button.

### Presets

| Preset | What it is | Notable settings |
| --- | --- | --- |
| **14″ cart wheel** | Garden/utility cart wheel on a keyed shaft | inches, Ø14″ × 2″, PETG, spokes, lugged |
| **Rover airless (TPU)** | Compliant wheel for a robot/rover | Ø260 × 60, TPU, flex web, hex bore |
| **Bolt-on caster** | Bolts to a plate or caster fork | Ø160 × 45, PETG, honeycomb, 4-bolt hub |
| **Interlaced airless** | The criss-cross airless-tire look | Ø260 × 55, TPU, 3-row lattice |
| **Auxetic scooter** | Re-entrant lattice, negative Poisson's ratio | Ø200 × 40, TPU, 2 rings, waist 0.4 |
| **Voronoi show wheel** | Organic cell web, display piece | Ø180 × 40, PETG, voronoi seed 7 |
| **100 mm test** | Small, fast print for checking joints/fit | Ø100 × 25, PLA, plain 8 mm bore |

A preset writes only the wheel's own numbers. Your printer envelope and the two
clearances are yours and survive preset changes — converted, not reset, when a
preset switches units.

### Units

`mm` / `inches` rewrites every length field in place, so the physical size you
typed keeps its meaning. Counts, ratios and seeds are left alone (bolt count,
`waist`, voronoi `seed`, cell budgets). Round-tripping mm → in → mm lands back
on the number you typed rather than 2.59999.

### Wheel

| Control | Range | Notes |
| --- | --- | --- |
| Diameter | 30 – 1500 mm | The outer diameter including tread. |
| Width | 6 – 400 mm | Axial width; must fit printer Z. |
| Material | PLA / PETG / ABS-ASA / TPU | Drives the adhesive recommendation and print settings, not the geometry. |

### Structure

| Control | Notes |
| --- | --- |
| Web style | `spokes`, `solid`, `honeycomb`, `flexweb`, `lattice`, `auxetic`, `voronoi` — see [§5](#5-choosing-a-web). |
| *(per-style group)* | Each style reveals its own parameters; every length follows the units selector. Full tables in the [README](../README.md#the-airless-webs). |
| Tread | `lugged` (straight bars), `angled`, `chevron` (V-bar), `ribbed` (circumferential grooves), `diamond` (bars + grooves), `slick`. |
| Tread depth | 0.8 mm – 6 % of diameter. Ignored for slick. |
| Bars around wheel | `0` = auto (about one bar per 20 mm of circumference). Snapped to a multiple of the segment count. |
| Bar angle | Slant off the wheel's axis, for `angled` and `chevron`. |
| Ribs across width | `0` = auto (one per 14 mm). |
| Tread profile | `flat` (cylindrical), `crowned`, or `round` — the tire's cross-section. |
| Crown drop | How much smaller the radius is at each shoulder than at mid-width. `0` = auto (12 % of the width). `round` sets it to the half-width for you. |

Tread feature counts snap to multiples of the segment count, so seams land
between features and every segment carries the same tread.

**Bar angle and bar count trade against each other.** A bar can only lean as far
as the gap to its neighbour allows. Leave the bar count on auto and the planner
spaces the bars out to give you the angle you asked for — 45° on a 14″ wheel
gives 12 bars where a straight tread gives 54. Set a bar count yourself and the
angle gives way instead, and the plan says what it settled on.

**A curved profile is cut, not approximated.** The crown is a real arc of the
tire's section circle, taken out of the piece by one revolved tool, so a
`round` section is a true semicircle at any width rather than a chain of flats
between sampled heights. It costs a second or two more to build than a flat
wheel, and nothing in accuracy.

### Hub / mating

| Type | Use it for | Fields |
| --- | --- | --- |
| **Keyed shaft** | Powered axles with a key/woodruff | bore Ø, key width, key depth |
| **Plain bore** | Idler wheels on a shaft/bearing | bore Ø |
| **Hex bore** | Hex axles (rovers, RC, some carts) | across flats |
| **D-bore** | D-shafts (gearmotors, potentiometer-style flats) | bore Ø, flat offset (0 = auto at 0.75 R) |
| **Bolt circle** | Bolting to a hub plate or caster fork | bolt count 2–12, BCD, hole Ø, pilot Ø |

`Bore fit clearance` (0 – 1 mm, default 0.2) is added to the bore all round —
printers rarely hit nominal, and this is the knob for your printer's tendency.

Bolt circles get two automatic corrections: a BCD too small for the pilot bore
or for 3 mm of material between holes is increased (with a warning), and the
bolt pattern is phase-rotated so no hole lands on a segment seam.

### Printer envelope

| Control | Notes |
| --- | --- |
| Bed X / Bed Y | Physical bed size. |
| Height Z | Build height; the wheel's **width** must fit here. |
| Edge margin | Subtracted from X and Y — keeps pieces off clips and out of the skirt. |
| Segments (0 = auto) | Force a segment count, up to 16. The auto solver is usually right; forcing is for "I want quarters". |
| Joint clearance / side | 0.05 – 0.6 mm, default 0.15. Per side of every dovetail. |

Tuning joint clearance: dovetails that need a mallet → raise by 0.05 mm;
dovetails that rattle → lower by 0.05 mm. It is faster to re-generate than to
file, and the 100 mm test preset is there to spend 20 minutes finding your
printer's number once.

### Viewport

- **Orbit** drag · **zoom** scroll · **pan** right-drag.
- **Explode** (0–100) separates the segments along their radial direction.
- **Printer-fit view** shows one piece print-oriented inside the usable volume.
- The label bottom-right reads `3D` or `2D fallback` — the fallback renders the
  same geometry on a 2D canvas when WebGL is unavailable.

---

## 4. Reading the build plan

| Line | What it tells you |
| --- | --- |
| Headline | Wheel size and whether it prints whole or in N segments of A°. |
| Piece footprint | Bounding box of one piece **as printed** (already rotated flat), plus the wheel width as its Z. |
| Usable bed | Your bed minus the edge margin. Compare it with the footprint. |
| Joints per seam | How many dovetails each seam carries (`hub`, `rim`, sometimes `web`). |
| Web / Tread / Profile | What the planner actually laid out — cell counts, wall, bar and rib counts, and the tire's cross-section. |
| piece X × n | The dedupe result: how many prints of each unique file. |
| fits printer / does not fit | Whether the piece footprint fits the usable bed (and the width fits Z). |

**⚠ warnings** are things you should act on. **ℹ notes** are decisions the
planner made for you.

| Message | Why | What to do |
| --- | --- | --- |
| `Requested segment count N does not fit…` | You forced `Segments` | Raise the count or clear the override (0 = auto). |
| `Even 16 segments do not fit this printer envelope` | Piece depth ≈ wheel radius; a pie slice can't get shorter than that | Smaller wheel, or print in two rings (not yet automated — see the roadmap). |
| `Wheel width … exceeds printer Z height` | Width doesn't fit vertically | Reduce width or use a taller printer. |
| `Bolt circle was too small…` | BCD couldn't clear the pilot or leave 3 mm between holes | Nothing — it was increased for you; check it still matches your hub plate. |
| `Bore diameter was too large relative to the wheel` | Bore ≥ 50 % of the wheel | Nothing — clamped to 30 %; check the value you typed. |
| `Rim band too thin for a dovetail` | Very small wheel or very deep tread | Reduce tread depth, or accept adhesive-only rim joints. |
| `Web band too narrow for structural infill` (note) | Hub and rim rings nearly meet | Use a larger wheel or a smaller hub/bore if you want a patterned web. |
| `… cells did not clear the joint keep-outs; web left solid` (note) | The pattern couldn't fit clear of the seams | Smaller cells/wall, fewer segments, or accept the solid web. |
| `… hit the N-cell budget` / `widened to …` (note) | Per-segment void budget (keeps the boolean count sane) | Raise the budget, or the cell size. |
| `… wall is under three 0.4 mm extrusions` (note) | Wall thinner than a stock nozzle prints reliably | Raise the wall, or use a smaller nozzle. |

---

## 5. Choosing a web

| You want | Style | Why |
| --- | --- | --- |
| Maximum stiffness and load, least print time | `solid` | No voids at all. Heavy. |
| Classic wheel, rigid, light | `spokes` | Radial ribs; the default. |
| Even compliance in every direction, tidy look | `honeycomb` | Uniform-wall hex lattice; the Polaris/Resilient NPT look. |
| Springy airless wheel, simple | `flexweb` | Curved flex slots — long, compliant ribs. |
| Springy airless wheel, structural | `lattice` | Crossing strut families; 1 row gives a chevron truss. |
| Compliance that pulls inward under load | `auxetic` | Re-entrant cells, negative Poisson's ratio. |
| A show piece | `voronoi` | Organic irregular cells, reproducible from a seed. |

Notes that apply to all of them:

- Every pattern guarantees its stated **wall** as a minimum everywhere, by
  construction — not by checking afterwards.
- Cells never overlap and never cross a seam keep-out, so patterned webs cost
  no extra unique pieces.
- Compliance comes from the *material* as much as the pattern: `auxetic` and
  `lattice` in PLA are decorative; in TPU they're suspension.
- More cells = more booleans = slower engine export. The per-segment budgets
  (64 honeycomb cells, 120 for the chart-drawn webs) exist for that reason.

---

## 6. Printer envelope and segmentation

The solver walks segment counts upward and takes the first that fits, preferring
counts that match your hub's rotational symmetry so pieces come out identical.
For an annular sector of N segments on a wheel of radius R:

```
width  = 2·(R·sin(π/N) + jointDepth)
depth  = R − rInner·cos(π/N) + jointDepth
```

Two consequences worth internalising:

- **Depth barely improves with N.** As N grows, `depth → R`. A 700 mm wheel
  needs ~350 mm of bed depth no matter how many slices you cut. That is the
  pie-slice limit behind the "even 16 segments do not fit" warning.
- **Width shrinks fast.** Doubling N roughly halves the piece width, so wide
  beds are cheap to satisfy.

The wheel's **width** is never split — it must fit printer Z.

---

## 7. What you get in the bundle

| File | Contents |
| --- | --- |
| `piece-A.py`, `piece-B.py`, … | One file per **unique** piece: its boundary and the prisms to subtract. Print-flat on XY. |
| `wheelwright_occ.py`, `build.py` | The geometry code itself, shipped verbatim. `python build.py .` turns the pieces into STL and STEP; `--formats stl` or `--formats step` for one of them. |
| `ASSEMBLY.md` | Print quantities and footprints, print settings, the glue-up sequence for your material, the build commands, and any warnings. |
| `wheelwright.json` | Machine-readable manifest: the full parameter set, segment count, piece list with quantities, footprint, warnings and notes. |

Every piece file opens with a comment header naming the wheel, the piece, and
how many of it to print — the file is self-describing if it gets separated from
the bundle. The `.step` files the build produces open in FreeCAD, Fusion,
SolidWorks and Onshape as real solids, not meshes.

---

## 8. Printing and assembly

Starting settings come with the plan (and are repeated in `ASSEMBLY.md`):

| Material | Walls | Infill | Adhesive |
| --- | --- | --- | --- |
| PLA | 4 | 30 % gyroid | Flexible PU construction adhesive (epoxy for maximum stiffness) |
| PETG | 4 | 30 % gyroid | Flexible PU — PETG bonds poorly with CA |
| ABS / ASA | 4 | 30 % gyroid | Acetone solvent weld (near-monolithic), or PU where impact matters |
| TPU | 3 | 18 % gyroid | Flexible contact adhesive (E6000 / Shoe Goo class) |

The structural pattern is **modeled in the part** — slicer infill only fills the
solid ribs, so there is no need to chase high infill percentages.

Glue-up:

1. **Dry-fit everything first.** Dovetails should slide with light hand
   pressure. Too tight: scale 100.2 % in the slicer or file the tenons lightly.
2. Thin bead in each dovetail pocket and along both faces.
3. Slide segments together one at a time on a flat surface, working around the
   circle — the last segment drops in axially.
4. Wipe squeeze-out, check flatness, cure 24 h before loading.
5. Bolt hubs: snug the bolts in a star pattern; they clamp the stack axially.
6. Shaft hubs: axial retention is the adhesive plus your collars/washers — the
   dovetails resist circumferential separation, not axial pull.

---

## 9. Worked examples

### 9.1 Garden cart wheel, 14″, keyed axle, on an Ender-class printer

*Preset: 14″ cart wheel.* Ø14″ × 2″, PETG, spokes, lugged tread, ¾″ keyed bore,
220 × 220 × 250 bed.

The solver lands on 6 segments of 60°; the keyway falls inside one segment
window, so you print `piece-A` once and `piece-B` five times. Lugs snap to 54
(a multiple of 6) so no lug is cut by a seam. Total print ≈ six 178 × 146 mm
parts — an overnight job on a stock bed, versus impossible in one piece.

### 9.2 Rover wheel that has to absorb rocks

*Preset: Rover airless (TPU).* Ø260 × 60, TPU, flex web, 13 mm hex bore.

The hex bore is 6-fold symmetric, so the solver prefers a segment count that
divides 6 and every piece is identical — one file, printed six times. TPU at 3
walls / 18 % infill keeps the web doing the springing. Swap the web to
`auxetic` (rings 2, waist 0.4) for more inward-drawing compliance, or `lattice`
(rows 3) if you want the criss-cross look with more structure.

### 9.3 Bolt-on caster for a workbench

*Preset: Bolt-on caster.* Ø160 × 45, PETG, honeycomb, 4 bolts on Ø60 BCD.

At 160 mm the wheel prints in one piece on a 220 bed — no joints at all, and
the bolt holes and pilot bore are plain through-cuts. Raise the diameter past
your bed and the same design segments automatically: the bolt pattern rotates
off the seams so no piece carries a half-open hole, which is what the
[caster screenshot](../README.md#why-the-pieces-come-out-identical) shows at
Ø240.

### 9.4 Scooter wheel with a tuned auxetic web

*Preset: Auxetic scooter.* Ø200 × 40, TPU, hex bore, 2 rings, waist 0.40.

`waist` is the tuning knob: 0.3 pinches hard (more auxetic, softer), 0.7 is
nearly a plain hex (stiffer). Watch the note about walls under three extrusion
widths — a 2 mm wall in TPU on a 0.4 nozzle is fragile in exactly the place the
wheel flexes most.

### 9.5 Replacement wheel for a machine you own

Measure three things: the shaft (diameter, and key or flat if it has one), the
wheel's outer diameter, and its width. Type them in, pick the hub type that
matches the shaft, set your bed, and check `fits printer`. Set bore clearance
from experience with your printer (0.2 mm is a good first guess; 0.1 for a
tight sliding fit on a well-tuned machine).

### 9.6 A wheel bigger than your printer, on purpose

Set diameter 700 mm and a 220 bed. You'll get the `even 16 segments do not fit`
warning: the depth of a pie slice is ~R regardless of N. The honest options are
a smaller wheel, a bigger printer, or waiting for the two-ring split on the
roadmap. Wheelwright says so rather than emitting parts that can't be printed.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| **Build** returns 503 `no-python` | No interpreter with OpenCascade on this server | `npm run setup:occ`, restart. Or `pip install cadquery-ocp` yourself and set `WHEELWRIGHT_PYTHON` to that interpreter. |
| `npm run setup:occ` says no suitable Python | Only a too-new (or too-old) Python is installed | `cadquery-ocp` ships wheels for 3.9–3.13. Install one from python.org and re-run, or set `PYTHON` to a suitable interpreter. |
| `ImportError: DLL load failed … filename or extension is too long` (Windows) | OpenCascade's DLLs hit `MAX_PATH` under a deep checkout | Create the venv somewhere short (e.g. `C:\occ-venv`) and point `WHEELWRIGHT_PYTHON` at its `python.exe`. |
| 500 `build-failed` naming a piece | The kernel could not build that piece's geometry | Download the source bundle and run `python build.py .` for the full traceback, then please report the configuration. |
| Server starts but the browser shows `Planner error` | A parameter combination the planner rejects | The message names the field; check the browser console for the stack. |
| `2D fallback` in the corner of the viewport | WebGL unavailable (remote desktop, blocked GPU) | Nothing breaks — the same plan renders in 2D. Use a local browser for 3D. |
| Port 3000 in use | Another dev server | `PORT=4000 npm start`. |
| Numbers look 25.4× wrong | Units selector changed without the form | Can't happen through the UI — but if you POST to the API directly, send `units: "in"` **with** inch values, or convert to mm yourself. |

---

## 11. FAQ

**Do I need an account or an API key?**
No. Nothing here talks to a service — the geometry kernel runs on your own
machine, and the only thing the setup step downloads is a Python package.

**Is the preview the real geometry?**
Yes — the preview and the build script come from the same plan object, and the
preview renders the piece's true carved profile: the tread bars, the crown and
the circumferential grooves are all in the mesh, none of them drawn on top of
it. Where the two must differ is resolution: a triangle mesh cannot hold an
exact arc, so the preview samples the tire's curve while the solid carries it
whole. Both read that curve from the same function.

On a wheel with a *slanted* tread the preview reads 1–3 % light, because it
also samples each profile as a polyline and rules between them where the kernel
lofts the exact outlines. Everywhere else it now agrees with the built solid to
better than 0.1 %. Weigh the STL, not the preview.

**Will the pieces really slide together?**
The dovetail pockets are the tenon geometry plus your clearance per side, and
the tests assert exactly that. What no generator can know is your printer's
elephant-foot and shrinkage — hence the 100 mm test preset.

**Can I edit the generated files?**
That's the point of shipping source instead of a mesh. A `piece-*.py` is plain
data with a comment header — change a coordinate, re-run `python build.py .`.
For CAD-side edits, build the STEP and take it into FreeCAD or anything else.

**Is the voronoi web random?**
It's seeded. The planner never calls `Math.random()`, so the same parameters
give the same wheel in the browser and on the server. Change `seed` to reroll.

**Can I run this in CI / headless?**
Yes: `POST /api/source` returns the files as JSON, and `npm run validate`
regenerates a whole config matrix and builds every piece through the real
kernel, failing on the first invalid solid. No network needed. See
[api.md](api.md).
