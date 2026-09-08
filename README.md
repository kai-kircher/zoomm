

https://github.com/user-attachments/assets/682232c1-782d-4b58-965c-8e1834f986e8



# 🛞 Wheelwright

**Any wheel, any printer.** A parametric configurator for 3D-printable wheels that automatically
splits the wheel into segments that fit *your* printer's build volume and slide together with
dovetail joints — no CAD required. Every configuration compiles to a small, readable Python
build script, and [OpenCascade](https://dev.opencascade.org/) turns it into STL and STEP —
locally, in seconds, with no account, token or network.

Want a 14″ airless tire for your cart project but only own an Ender-sized printer? Type in the
wheel you want and the envelope you have; Wheelwright hands you the pieces, the print settings,
and the glue-up instructions.

![Wheelwright — 14in cart wheel exploded into 6 dovetailed segments, spoked web and lugged tread](docs/screenshot-cart.png)

## What it does

- **Configure the wheel**: diameter, width, material (PLA/PETG/ABS/TPU), and hub interface (keyed
  shaft, plain, hex, D-bore, or bolt circle with pilot).
- **Give each part its own filament**: a TPU tread on a PETG core, a stiffer hub than web. Each
  piece then exports as one file per material, split on cylinders that are solid all the way
  round, ready to load into a slicer as the parts of a single object.
- **Pick a tread**: lugged (straight bars), angled, chevron / V-bar, ribbed, diamond, or slick —
  with bar count, bar angle, rib count and depth all settable.
- **Pick a cross-section**: flat cylindrical, crowned by a settable drop, or a full round
  bicycle-tire section — cut as an exact arc of the section circle, not approximated. The tread
  rides the curve, so bars fade out towards the shoulders the way a moulded tire's do.
- **Pick a web**: solid, spokes, or one of the five [airless patterns](#the-airless-webs) —
  honeycomb, interlaced lattice, auxetic re-entrant, graded rings, or voronoi. Each carries its
  own parameter group (cell size, wall, orientation, corner rounding…) and each guarantees a
  minimum wall everywhere, by construction.
- **Give it your print envelope**: bed X/Y, height Z, edge margin.
- **It plans the build**: picks the smallest segment count whose pieces fit the bed, sizes
  slide-together dovetails into the rim and hub rings, keeps structural webs clear of the seams,
  and dedupes pieces — a keyed 6-segment wheel is "print A×1, B×5", not six different files.
- **It generates a build script**: one file per unique piece — the piece boundary and the
  prisms to subtract from it, as plain data — lying
  print-flat on XY. Plus a generated `ASSEMBLY.md` (print settings, adhesive choice, glue-up
  steps) and a JSON manifest.
- **OpenCascade makes the solids**: one click for STL, STEP or both, or run `python build.py .`
  in the bundle you downloaded — it ships with the same geometry code the app runs.

| Airless TPU rover wheel (flex-web, hex bore) | Printer-fit check against your envelope |
|---|---|
| ![Rover airless wheel — six identical 60° segments with curved flex-web slots](docs/screenshot-rover.png) | ![Printer fit view — one segment print-oriented inside the usable build volume](docs/screenshot-fit.png) |

## Quickstart

```sh
npm install
npm start          # http://localhost:3000
```

Optional, for one-click STL export from the UI — two steps:

```sh
npm run setup:occ       # venv in ./bin with OpenCascade (pip install cadquery-ocp)
npm start
```

Already have `cadquery-ocp` in some interpreter? Skip the setup step and point
`WHEELWRIGHT_PYTHON` at it. Otherwise the server looks for `./bin/occ-venv`, then
`python3` / `python` / `py -3` on `PATH`. The **kernel pill** (top right in the app) says
which interpreter it found. `.env` / `.env.local` are loaded by a tiny dependency-free
loader; real environment variables always win.

Without OpenCascade installed the app still does everything except build the solids itself —
you download the source bundle and run `pip install cadquery-ocp && python build.py .` in it,
which is the same code, on the same files, that the server would have run.

```sh
npm test           # 200 unit tests: chunking math, joints, dedupe, piece profiles, every web pattern's wall and overlap guarantees, material-zone boundaries, emitted-bundle geometry
npm run validate   # regenerates a 27-config matrix and builds every piece through the real kernel
```

## Documentation

| Doc | What's in it |
|---|---|
| [User guide](docs/user-guide.md) | Install, every control, reading the build plan, six worked use-cases, printing and glue-up, troubleshooting. |
| [Architecture](docs/architecture.md) | The planner's geometry: band model, segment solver, dedupe, the chart the curved webs are drawn in, how the solids get built, testing strategy. |
| [HTTP API](docs/api.md) | `/api/plan`, `/api/source`, `/api/source.zip`, `/api/export/stl`, the parameter object, error codes. |
| [Zoo platform field notes](docs/zoo-api-notes.md) | Historical: the hosted KCL engine this project ran on before OpenCascade, its failure modes, and the geometry rules they forced. |

## How it works

```
  browser form ──► planWheel()  (src/lib/wheel.js — pure JS, runs in browser AND server)
                      │
                      ├─ segment-count solver (annular-sector bbox vs. usable bed, prefers
                      │  counts that make pieces identical for your hub's symmetry)
                      ├─ dovetail sizing (rim ring + hub ring; clearance per side,
                      │  fitted to the wedge so a pocket never breaks out the far face)
                      ├─ web layout (spokes, flex-web slots, or a honeycomb /
                      │  lattice / auxetic / voronoi cell pattern), kept clear
                      │  of seam keep-outs so joints stay solid
                      ├─ tread + tire cross-section (bar notches and the crown arc are
                      │  drawn into the piece profile itself, one profile per z level;
                      │  counts snap to multiples of N so seams land between bars)
                      ├─ per-piece hub features + signature dedupe (keyway/D-flat/bolt windows)
                      └─ material zones: which radial bands get which filament
                      │
        ┌─────────────┴──────────────┐
        ▼                            ▼
  Three.js preview            Bundle generator (src/lib/occgen.js)
  (same plan, exploded        one piece-*.py per unique piece +
  view + printer-fit view)    the build runtime + ASSEMBLY.md + manifest
                                     │
                                     ▼
                          OpenCascade (python build.py .) ──► STL + STEP
                          (one file per piece, or one per filament)
```

One geometry plan feeds both the preview and the code generator, so what you see is what the
kernel builds. Everything is derived on configure — there is no model library.

### The segmentation scheme

Segments are annular wedges cut by radial seams. Each seam carries **axial slide dovetails**
(trapezoidal tenon on one face, clearance pocket on the other) placed in the solid rim ring and
hub ring, so all pieces slide together along the axle direction and any piece can be inserted
last. Dovetails resist the circumferential separation; axial retention comes from the adhesive
(plus hub bolts, when you pick a bolt-circle hub). Because the tenon/pocket geometry is part of
each piece's 2D outline, the build needs nothing beyond wires, faces, one prism or loft, and
one subtract — the most battle-tested operations in the kernel. A dovetail is sized from the
ring of material it sits in *and* from the width of the wedge at that radius, since a pocket cut
into one seam face has to keep a wall to the other one; on a high segment count the hub dovetail
therefore comes back narrower than the ring alone would allow, and the plan notes say so.

For keyed, hex and D hubs the wedges extend inward past the bore line and the bore tool is
subtracted per piece, so the assembled hub carries the exact mating feature with your chosen fit
clearance. Concentric round bores (plain, and the bolt hub's pilot) skip that trim: each sector
outline carries its exact arc of the bore circle directly, because asking the engine to shave the
razor-thin concentric sliver is a boolean its solver rejects ("cannot handle this 3D subtraction
yet"). Bolt holes are still subtracted per piece.

### Why the pieces come out identical

Feature-aware deduplication: the planner computes which segment windows intersect the keyway /
D-flat / bolt holes and hashes each piece's canonical feature set. The segment-count solver
prefers (within fit constraints) counts that match the hub's rotational symmetry — e.g. hex
bores like 2/3/6/12 segments — so most wheels are "print one file N times". Bolt circles are
phase-rotated to sit centred between the seams for the chosen N, so no piece ever carries a
half-open hole.

![Bolt-circle caster, honeycomb web — four identical 90° segments, bolt holes clear of every seam](docs/screenshot-caster.png)

The patterned webs cooperate: every cell is placed clear of the seam keep-outs and repeats per
segment, so a web never costs you a unique piece and never leaves a joint half-cut.

The spoke web answers to the same keep-outs, from the other side: its ribs are the material
*between* the gaps, so the gap is what has to clear both seams. Split a wheel far enough and the
two keep-outs meet before the gap reaches the hub — there is no gap left to cut, and the web is
left solid with a note saying so rather than cut as a sliver.

## The airless webs

Search "airless tire" and you get four looks: honeycomb, criss-crossing curved struts, chevron
trusses, and the auxetic lattices out of the research papers — plus the rings of cells that grow
towards the rim on most moulded ones, and the organic voronoi webs the 3D-printing crowd likes.
Wheelwright models all of them. Pick a web style in the sidebar and its own parameter group
appears; every length follows the units selector.

| Style | The look | Knobs |
|---|---|---|
| `honeycomb` | Hex cells on a true hex lattice — the Polaris/Resilient NPT look. | [below](#honeycomb) |
| `lattice` | Two mirrored families of struts crossing in an X, diamonds slung between them. One row degenerates to a chevron/V-truss. | [below](#interlaced-lattice) |
| `auxetic` | Re-entrant bow-tie cells in a brick bond: the web pulls *inward* when you squeeze it. | [below](#auxetic-re-entrant) |
| `graded` | Concentric rings of hex, rectangular or diamond cells that grow with the radius — small at the hub, large at the rim. Lean them for a turbine web. | [below](#graded-rings) |
| `voronoi` | Organic irregular cells from a seeded tessellation. | [below](#voronoi) |

### How the curved ones are built

Honeycomb is a straight lattice stamped onto an annulus. The other four curve with the wheel, and
they all get there the same way — by unrolling the web band into a rectangle, drawing the pattern
there in plain straight-line geometry, and mapping it back:

```
  Φ(θ, t) = polar(rWebIn + t·bandW, θ)      θ ∈ [0, A] degrees,  t ∈ [0, 1] across the band
```

Φ is injective on the strip and orientation-preserving, so **cells laid out disjoint in the chart
come out disjoint on the wheel** — the same no-overlap guarantee the hex lattice gets for free,
extended to patterns that bend. That matters: overlapping cells merge into open voids in the CAD
and shred the preview's triangulation.

What Φ *does* distort is distance — one degree of θ buys `r·π/180` mm of arc, more the further out
you go — so every wall is converted to degrees at the innermost radius it touches, which makes the
number you typed the **minimum** material anywhere along that wall. Two consequences worth knowing:

- A leaning strut is thicker measured tangentially than it is across itself, so `strutWidth` is
  taken as the **perpendicular** thickness and the lattice gives up `strutWidth / cos φ` of arc for
  it. Fall out of that: the neck between the cells above and below a crossing works out to
  `strutWidth / sin φ` — never the tighter of the two, so it never needs policing.
- Curves are emitted as chords, and a chord falls *inside* the arc it replaces. On a cell's inner
  boundary that eats into the wall, so the chord length is held under `√(8·r·sag)` and every wall
  carries the leftover sag as an allowance.

The tests measure all of it on the finished millimetre geometry — every pair of cells in 50
configurations, checked for overlap, nesting, self-crossing loops, band containment, seam
clearance, and the wall actually left between them.

### Honeycomb

| Option | Default | What it does |
|---|---|---|
| `cellSize` | `0` (auto) | Cell width across flats. Auto sizes cells to the web band (band ÷ 8, 4–12 mm circumradius). |
| `wall` | `2.6` mm | Material left between neighbouring cells — the same everywhere by construction. |
| `orientation` | `radial` | `radial` points a cell vertex at the rim; `tangential` turns the whole lattice 30° so a flat faces it. |
| `cellShape` | `hex` | `round` replaces each hex with its inscribed circle — same lattice, same walls, no stress-raising corners. |
| `cornerRadius` | `0` (sharp) | Fillets the hex corners. Capped at half the across-flats width, where the cell becomes `round`. |
| `maxCells` | `64` | Per-segment cell budget. Cells are grown until they fit it, keeping the preview responsive. |

### Interlaced lattice

Two pencils of straight lines in the chart, `θ = c ± L·t`, crossing on `rows + 1` evenly spaced
levels. The diamond centred on each crossing spans one strut pitch across and two levels up, and
levels stagger by half a pitch. Two rows and up weave; one row leaves alternating triangles — a
chevron truss.

| Option | Default | What it does |
|---|---|---|
| `rows` | `0` (auto) | Diamond rows across the band; `1` gives the chevron/V-truss. Auto scales with the band width. |
| `struts` | `0` (auto) | Struts per family around the whole wheel, snapped to a multiple of the segment count. Auto picks roughly square cells. |
| `strutWidth` | `4` mm | Material between neighbouring cells, measured across the strut. |
| `cornerRadius` | `1.5` mm | Fillets the cell corners — the sharp apexes of a flexing web are where it cracks. |

### Auxetic (re-entrant)

Hexagonal cells whose two waist vertices are pulled back *inside* the cell, so under load the ribs
fold instead of stretching and the web draws inward as it is squeezed — a negative Poisson's ratio,
which is why the pattern keeps turning up in airless-tire research. Cells sit on concentric rings,
brick-staggered ring to ring, all sharing one angular pitch so the columns line up.

| Option | Default | What it does |
|---|---|---|
| `rings` | `0` (auto) | Cell rings across the band. Auto aims at ~26 mm of band per ring. |
| `cellSize` | `0` (auto) | Cell width at the ring's mid radius. Auto matches the ring height. Rings near the hub narrow their cells rather than turn into a few big lobes. |
| `wall` | `3` mm | Material between neighbouring cells — exactly this radially, and this at the tightest point of every ring wall. |
| `waist` | `0.45` | Waist width ÷ cell width. Lower pinches harder (more auxetic); `0.9` is nearly a plain hex. |
| `cornerRadius` | `1.2` mm | Fillets the corners, waist included — a rounded waist bows into the wall, so the bow is capped at the slack that corner has. |

### Graded rings

The regular airless-tire web: concentric rings of cells that grow with the radius — small around
the hub, large at the rim — which is what most moulded airless tires and robot wheels actually
look like. It is the deliberate opposite of the voronoi: nothing here is random.

One angular pitch is shared by the whole web, so a cell is exactly as wide as its own radius makes
it, and `grade` spaces the ring boundaries geometrically so the *height* grows with the width —
each cell a scaled copy of the one inside it. Rings brick-stagger, so the radial walls of one ring
sit over the middle of the cells in the next.

Each ring then takes the whole number of cells nearest that shared pitch and stretches to fill its
own run. It has to: the seam keep-out is a fixed number of millimetres, so it costs a ring near the
hub several times as many degrees as one at the rim, and without the stretch every inner ring would
leave most of a cell's width standing solid beside the joint.

| Option | Default | What it does |
|---|---|---|
| `rings` | `0` (auto) | Cell rings across the band. Auto takes ~26 mm of band per ring, and more when grading asks for it — a band spanning a wide range of radii needs the extra rings to keep the step from one to the next under ~1.4×. Rings whose cells would come out unprintably shallow are dropped. |
| `cells` | `0` (auto) | Cells around the whole wheel, at the shared pitch. Auto sizes them square at the middle ring. |
| `wall` | `2.6` mm | Material between neighbouring cells — exactly this radially, and this at the tightest point of every ring wall. |
| `cellShape` | `hex` | `hex` narrows the cell towards its two flat ends; `rect` keeps the sides straight all the way; `diamond` pulls the ends to a point, leaving a triangulated truss between them. |
| `grade` | `1` | How the rings are spaced. `1` makes each ring's height proportional to its radius, so cells grow in both directions at once; `0` gives every ring the same height and cells widen only across. Anything between blends the two. |
| `swirl` | `0`° | Leans every cell off radial by that many degrees, measured on the wheel — a turbine web. It is a shear of the chart, so the walls are untouched; each ring simply carries fewer cells, since the lean has to clear the seams too. |
| `cornerRadius` | `1.2` mm | Fillets the cell corners. Every corner is convex, so this only ever hands material back. |

Cells narrower than 3 mm are dropped rather than cut — on a wheel with a small hub and a big rim
the innermost ring can grade its way down to noise, and a hole a nozzle can barely draw is not
worth a boolean.

### Voronoi

A seeded tessellation of the unrolled band: jittered-grid seeds, two rounds of Lloyd relaxation to
even them out without making them look machined, then every cell pulled back by half a wall. The
pull-back is metric-aware per edge — both owners of a shared edge run the same numbers off the same
edge, so the two half-walls add up exactly.

| Option | Default | What it does |
|---|---|---|
| `cells` | `0` (auto) | Cells per segment. Auto sizes them to the band; the automatic count stops at 40, but you can ask for up to 120. |
| `wall` | `3` mm | Material between neighbouring cells. |
| `seed` | `1` | Same seed, same web. Nothing in the planner touches `Math.random()`, so a design is reproducible on the server and in the browser. |
| `cornerRadius` | `1.2` mm | Fillets the cell corners. |

Ask for cells too small for the budget and the planner grows them and says so in the build notes;
ask for cells too big for the web band and it leaves the web solid rather than half-cutting the
rim. Segmented wheels keep every cell clear of the seam keep-outs, so the joints stay solid — on a
narrow wedge near the hub that can mean a ring or two is left solid, and the notes say which.

## Tread and tire cross-section

The tread is not cut into the wheel — it *is* the wheel's outer boundary. Bars are described by
the windows between them, notched straight into the piece profile, so a lugged wheel costs the
engine no more than a slick one.

| `tread` | What |
|---|---|
| `slick` | Smooth. |
| `lugged` | Straight transverse bars. |
| `angled` | Bars slanted across the width by `treadAngle`. |
| `chevron` | Bars angling in from both shoulders to meet at the centreline. |
| `ribbed` | Circumferential grooves. |
| `diamond` | Bars and grooves together. |

| Parameter | Default | What |
|---|---|---|
| `treadDepth` | `3.5` mm | How deep the bars and grooves cut, measured from the tread surface. |
| `treadCount` | `0` (auto) | Bars around the whole wheel, snapped to a multiple of the segment count. Auto works out to roughly one bar every 20 mm of circumference. |
| `treadAngle` | `25`° | Bar slant off the wheel's axis (`angled`, `chevron`). See below. |
| `ribCount` | `0` (auto) | Circumferential grooves across the width, up to 6. Auto is one per 14 mm. A crowned tread takes as many as a flat one — they ride the same revolved tool. |

A bar can only lean as far as its own pitch cell allows before neighbouring bars merge. When
`treadCount` is on auto the planner honours the angle you asked for and **spaces the bars out**
until it fits — 45° on the demo wheel gives 12 bars where a straight tread gives 54. Pin
`treadCount` yourself and the angle gives way instead, with a note telling you what it settled
on.

### The cross-section

| `profile.shape` | What |
|---|---|
| `flat` | A cylindrical tread — the profile this planner has always made. Single extrude, seconds to export. |
| `crowned` | The radius falls by `profile.crownDrop` from mid-width to each shoulder, on a circular arc. Auto drop is 12% of the width. |
| `round` | The drop equals the half-width, so the section is a true semicircle: a bicycle tire. |

The crown is applied before the tread, and the bar floors ride it, so bars stand proud at the
centreline and fade out towards the shoulders exactly as a moulded tire's do. The drop is capped
so a rim band and a web always survive underneath it; ask for more and you get a warning and the
deepest section the wheel can actually give up.

## Multi-material: a soft tread on a rigid core

Tick **Multi-material** and the one material select becomes three — tread, web, hub. Anything you
leave alone follows the wheel's material, so a single-material wheel is still the default and is
emitted exactly as it always was: one solid, one file per piece.

The split lines are the two cylinders that separate the wheel's bands:

```
  0        bore        hub ring        web band          rim ring   tread   R
  ├──────────┼─────────────┼───────────────┼────────────────┼─────────┤
                           ↑                                ↑
                       hub │ web                        web │ tread
                         rHub                            rRimIn
```

Those two and no others, because a material boundary has to be **solid all the way round**: every
web pattern is laid out inside `[rHub + 0.5, rRimIn − 0.5]`, no dovetail reaches either line, and
the tire tool stops at the rim ring — so the two bodies meet on a complete annular face rather
than on something the web has holes in. `rRimIn` in particular keeps the whole rim ring with the
tread, so a soft tread gets a sidewall and its own dovetails instead of a 3 mm skin. (The obvious
alternative — the bar-window floor at `R − treadEff` — is a surface the piece profile already lies
on, and a boolean asked to cut exactly where the body already ends is the one that quietly does
nothing.)

Neighbouring bands that name the same filament are merged, so "TPU tread, PETG web, PETG hub" is
**two** bodies and not three: one file per thing you actually print.

```
piece-A-hub-web-petg.stl     piece-A-tread-tpu.stl
piece-A-hub-web-petg.step    piece-A-tread-tpu.step
```

The bodies **share their boundary cylinder exactly** — no gap, no overlap — which is what a slicer
wants from the parts of one object. Select the files of one piece, import them together, say yes
to *load as a single object with multiple parts*, and assign a filament to each part. The
generated `ASSEMBLY.md` carries that as a checklist, with the band diameters and the filament for
each.

The kernel does the split as one intersection per body against an annulus, then **checks the
bodies add back up to the piece they came from** and refuses to write them if they do not. That
check is there because this is a family of operations that fails quietly: an intersection whose
tool misses returns nothing, and one whose tool seam lands in the plane of a face of the body can
return the whole body — both of them valid, watertight, wheel-shaped solids. A volume that is
suddenly 3× or 0× is not.

### Which filaments actually stick to each other

The interface is a plain cylinder, so it carries the load in shear: everything the tread does to
the ground it does through it. It is as strong as the weld between the two filaments and no
stronger, which matters more here than on a decorative two-colour print. Wheelwright says so up
front rather than letting you find out on a hill:

| Pairing | Verdict |
|---|---|
| Same filament | Welds — an ordinary layer bond. |
| PETG + TPU | Bonds well. The pairing to reach for. |
| PLA + TPU | Weak — TPU grips PLA far more weakly than PETG. |
| PLA + PETG | Weak — PETG is what people put *under* PLA supports so they come away clean. |
| ABS + anything else | Weak, and the two want different chamber temperatures. |

A weak pairing is a warning in the plan, in the panel, and in `ASSEMBLY.md`.

Two more things the app tells you rather than hides:

- **Every seam is a separate glue-up.** A dovetail only ever joins a piece to its own kind, so the
  rim joint of a TPU-tread wheel is TPU-to-TPU and its hub joint is PETG-to-PETG — two different
  adhesives, listed per joint.
- **A single-nozzle machine will purge a lot.** The bodies are rings and the piece prints lying
  flat, so *every layer crosses every one of them*: an AMS or MMU changes filament at least once
  per layer — on a 50 mm wide wheel that is roughly 250 changes per body boundary — and purges
  each time. Independent tool heads make it nearly free; one nozzle does not. The number is in
  `ASSEMBLY.md` for your wheel.

## Adhesive guidance (the flexible-glue question)

This is about the **seams between segments**, which is a different question from the interface
between two filaments above. The app recommends per material — per *joint*, on a multi-material
wheel — and bakes it into the generated `ASSEMBLY.md`:

- **TPU** — flexible contact adhesive (E6000 / Shoe Goo class); rigid glue lines crack on a
  flexing tire.
- **PETG / PLA** — flexible polyurethane construction adhesive (Loctite PL Premium class): wheels
  live with shock and vibration, and slightly-flexible PU beats brittle CA. Epoxy if you want
  maximum stiffness.
- **ABS/ASA** — acetone solvent weld for a near-monolithic wheel, or PU where impact matters.

Thin bead in each dovetail pocket and along both faces, slide, wipe, cure 24 h. Dry-fit first —
the default 0.15 mm/side joint clearance suits most printers and is tunable.

## The generated build script

One file per unique piece, and it is a declaration rather than a program: the piece's boundary at
each height, and the prisms to take out of it. Every number is precomputed by the planner, so
there is nothing to solve and nothing ambiguous to resolve.

```python
# Wheelwright — 3D-printable segmented wheel
# Wheel: Ø355.6 × 50 mm, honeycomb web, lugged tread, 4-bolt Ø5.5 on Ø60 BCD
# Piece A: print 4 of 8 segments (45° each, slide-together dovetails, 0.15 mm clearance/side)

from wheelwright_occ import build, save

W = 50

SECTIONS = [
    {"z": 0, "kind": "sector", "segs": [
        {"kind": "line", "a": [9.2, 0], "b": [16.346, 0]},              # dovetail pocket
        {"kind": "arc", "a": [177.8, 0], "b": [177.664, 6.965],
         "center": [0, 0], "ccw": True},                                # tread
        {"kind": "line", "a": [177.664, 6.965], "b": [174.166, 6.828]}, # bar wall
        ...
    ]},
]

CUTTERS = [
    # bore
    {"shape": "circle", "c": [0, 0], "r": 10.2, "z0": 0, "z1": 50},
    # web void
    {"shape": "poly", "pts": [[62.1, 14.0], ...], "z0": 0, "z1": 50},
]

if __name__ == "__main__":
    for path in save(build(SECTIONS, CUTTERS, W), "piece-A"):
        print("wrote", path)
```

`build()` does the same two things for every wheel there is:

```python
blank = prism(SECTIONS[0], W)      # straight tread: one section
      | loft(SECTIONS)             # slanted tread: several
piece = blank - [solid(c) for c in CUTTERS]
```

Every cutter but one is a prism. The exception is the **tire** — the crown and every
circumferential groove together — whose profile is drawn in the (r, z) half-plane and swept a
full turn about the axle, so the running surface comes out as a real arc of the section circle.
Lofting it through sampled heights, which is what a kernel that refuses booleans on curved faces
forces you into, left the Ø200 round preset **2.99 mm** short at the shoulder — more than that
tread was deep. The revolve measures 0.0000 mm out on the built STL.

**The bundle builds itself.** Alongside the pieces it carries `wheelwright_occ.py` and
`build.py` — the geometry code, shipped verbatim. `python build.py .` writes an `.stl` (for
slicing) and a `.step` (for CAD — FreeCAD, Fusion, SolidWorks and Onshape all open it) next to
each source file. That is byte-for-byte the code the server runs when you click **Build**, on the
same files, so there is no private build path that could drift from the one you get.

Both formats are on by default because STEP costs little once the solid exists — but they are
tickboxes under **Fabricate**, and `build.py` takes the same choice as `--formats stl` or
`--formats step`. STL is the smaller download when the wheel is only going to a slicer; STEP is
what you want when it is going back into CAD, since it carries the real arcs and planes rather
than a triangle soup.

**Why it is this simple.** It did not use to be. Wheelwright originally emitted KCL for a hosted
engine, and on that engine booleans were the scarce resource: the demo wheel's twelve cutters
took ~80 s, busier wheels came back `Batch edit result is not valid` or dropped the modeling
connection, and no boolean would touch an operand with a curved face — so a crown could never be
cut, only lofted. Every full-depth cut had to be folded back into the profile as another sketch
loop to keep the tool count down. OpenCascade has none of those limits, so all of that machinery
went away and every cut is just a prism again. On the 19 configurations the two backends were
compared over, OpenCascade built **19/19, 28 pieces, 36.6 s of kernel time**, against 14/19 and
85–146 s per piece before. The failure modes
that shaped the old design are catalogued in
[docs/zoo-api-notes.md](docs/zoo-api-notes.md), which is now a historical record.

Three rules the emitter still keeps, each earned:

- **Endpoints are never moved.** Consecutive entities in a loop share their endpoint exactly, and
  the builder chains the wire through shared vertices to keep it that way. The tempting repair —
  projecting an arc's endpoints onto a mean radius, which the KCL emitter *had* to do — pushes
  them off their neighbours, and OpenCascade then returns an unclosed wire and a degenerate face
  rather than an error. A Ø355.6 mm sector prism measured 7 901 mm³ that way, against 612 000.
- **Arcs are built from three points**, because an arc is over-determined by start, end and
  centre and the planner rounds all three independently to 1e-3 mm.
- **Coordinates print at six decimals**, so regenerating a configuration is byte-identical.

## API

Everything the UI does is plain JSON over HTTP:

| Endpoint | What |
|---|---|
| `POST /api/plan` | Full geometry plan (segments, joints, warnings, per-piece cutters) |
| `POST /api/source` | Generated files as JSON |
| `POST /api/source.zip` | Source bundle download (self-building) |
| `POST /api/export/stl` | STL and/or STEP built by OpenCascade — `?formats=stl,step`, both by default (503 + instructions if the kernel is missing). One file per piece, or one per filament on a multi-material wheel |
| `GET /api/health` | Whether the geometry kernel is installed, and which interpreter has it |

Request body = the same parameter object the form produces (all fields optional; see
`DEFAULTS` in [`src/lib/wheel.js`](src/lib/wheel.js)).

## Repo layout

```
server.js                     express: static UI + API + build service
src/lib/wheel.js              the planner (pure, shared browser/server)
src/lib/units.js              unit switching: rewrites the form so lengths keep their physical size
src/lib/occgen.js             bundle emitter + assembly guide generator
src/lib/occ.js                finds a Python with OpenCascade and runs a bundle through it
src/lib/occ/wheelwright_occ.py  plan geometry → OpenCascade solid → STL/STEP (ships in every bundle)
src/lib/occ/build.py            builds every piece in a bundle (ships in every bundle)
src/lib/zip.js                dependency-free ZIP writer
src/lib/env.js                dependency-free .env / .env.local loader
public/                       UI (vanilla JS + vendored three.js, 2D canvas fallback)
scripts/setup-occ.mjs         creates ./bin/occ-venv with OpenCascade installed
scripts/validate-occ.js       builds a 27-config matrix through the real kernel
test/                         node:test suite
```

## Honest limitations & roadmap

- Very large wheels on very small printers hit a pie-slice depth limit (piece depth ≈ wheel
  radius). The fix is a second split ring (tire ring + hub ring as separate dovetailed
  assemblies) — planned, warned about today.
- Wheel width taller than the printer Z is warned, not yet auto-split axially.
- Tread/tenon edges are sharp (no chamfered lead-ins yet); slicers' seam-aware placement and a
  light file fix the first-fit experience.
- The preview draws the tread bars, the crown and the grooves for real — nothing is overlaid on
  top of the mesh any more. It samples the crown at 40-odd heights spaced by equal arc angle,
  where the solid carries it as an exact arc, so the mesh is an approximation of the same curve
  rather than of a different one.
- A bar can only lean as far as its own pitch cell allows. Ask for a steep chevron and the
  planner spaces the bars out to grant it; pin the bar count as well and the angle gives way
  instead, with a note saying so.
- Circumferential grooves are cut to a constant depth measured *perpendicular* to the tread, so
  on a crowned tire they sit a little shallower in radius near the shoulders than at the
  centreline. That is what a moulded groove does; a constant radial depth would run out through
  the shoulder.
- A **slanted tread** (`angled`, `chevron`) is the one thing left that varies the piece profile
  with height, so it is the only case that still lofts and the only one the section-congruence
  rule still binds. Everything else — crowned and round sections included — is a single prism
  plus one revolved cut.
- The preview reads **1–3 % light on a slanted tread**: it samples each profile as a polyline and
  rules between the sampled rings, where the kernel lofts the exact wires. On every other
  configuration it now agrees with the built solid to better than 0.1 %.
- Building needs a Python 3.9–3.13 with `cadquery-ocp` (~400 MB installed). `npm run setup:occ`
  handles it, but it is a real second runtime next to Node. On Windows, keep the venv path
  short: OpenCascade's DLLs hit `MAX_PATH` under a deep checkout, and the setup script warns
  before it spends the download.
- Multi-material bodies **share their boundary exactly**, which is right for printing them
  together and wrong for printing them apart: there is no fit clearance to press a separately
  printed tread onto a core with, and no interlock to carry torque across a weak interface. The
  interface is a plain cylinder, so a bad filament pairing is warned about rather than reinforced.
  A clearance-fit variant and a keyed interface are the fixes; neither is in yet.
- Wishlist: 3MF export (STL and STEP are in) — it would carry the per-part filament assignment
  that today's separate STLs leave you to make in the slicer — mass/inertia from the B-rep, since
  OpenCascade already computes the volume the validator prints, chamfered joint lead-ins, and
  per-piece print-time estimates.

## License

MIT — see [LICENSE](LICENSE).

Vendored third-party code under `public/vendor/` (three.js and `OrbitControls`) is MIT
licensed by the three.js authors and keeps its own copyright notice.
