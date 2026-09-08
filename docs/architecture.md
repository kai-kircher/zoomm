# How Wheelwright works

Wheelwright turns a handful of numbers into printable CAD. This document is the
engineering tour: the data model, the geometry, the CAD-generation rules, and
why each of them is the way it is. The [user guide](user-guide.md) covers using
the app. [zoo-api-notes.md](zoo-api-notes.md) is a historical record: it
documents the hosted KCL engine this project used before the OpenCascade
backend replaced it, and the limits that shaped the geometry model.

---

## 1. One plan, two consumers

```
  form / JSON body
        │
        ▼
  normalizeParams()      units → mm, coercion, clamps, warnings
        │
        ▼
  planWheel()  ──────────►  plan  {radii, N, joints, sections[…], outline,
   (src/lib/wheel.js)                profile, uniquePieces[…], infillInfo,
        │                            treadInfo, bbox, fit, glue, printRec,
        │                            warnings, notes}
        │
   ┌────┴─────────────────────────┐
   ▼                              ▼
  preview.js                    occgen.js
  three.js (2D fallback)        piece-*.py + ASSEMBLY.md + manifest
                                       │
                                       ▼
                                 OpenCascade → STL + STEP
```

The single most important design decision: **there is exactly one geometry
model**, and everything downstream is a renderer of it. `planWheel()` is a pure
function of its input — no I/O, no globals, no `Math.random()` — and it runs
unchanged in Node and in the browser (the server serves `src/lib/` at `/lib`,
and `public/app.js` imports the same module). The preview cannot drift from the
CAD, because there is nothing for it to drift from.

The plan is deliberately *dumb data*: numbers, 2D paths, and cutter
descriptions. No classes, no lazy evaluation, no engine handles. That is what
makes it safe to serialize (`POST /api/plan` returns it verbatim), diff in
tests, and hand to two renderers written in different styles.

## 2. Module map

| File | Lines | Responsibility |
| --- | ---: | --- |
| `src/lib/wheel.js` | ~1810 | The planner. All geometry decisions live here. |
| `src/lib/occgen.js` | ~330 | Plan → `piece-*.py`, `ASSEMBLY.md`, JSON manifest. |
| `src/lib/occ/wheelwright_occ.py` | ~370 | Plan geometry → OpenCascade solid → STL/STEP. Ships in every bundle. |
| `src/lib/occ/build.py` | ~110 | Builds every piece in a bundle. Ships in every bundle. |
| `src/lib/units.js` | ~96 | mm ⇄ inch form rewriting; single source of "what is a length". |
| `src/lib/occ.js` | ~140 | Finds a Python with OpenCascade; runs a bundle through it. |
| `src/lib/zip.js` | ~87 | Dependency-free STORE-method ZIP writer. |
| `src/lib/env.js` | ~39 | Dependency-free `.env` / `.env.local` loader. |
| `server.js` | ~97 | Express: static UI, JSON API, export proxy. |
| `public/preview.js` | ~506 | three.js scene + 2D canvas fallback, both from the plan. |
| `public/app.js` | ~421 | Form ⇄ planner glue, presets, downloads. |

No build step, no framework, no bundler. The dependency list is Express (server)
and a vendored three.js (browser).

## 3. The parameter contract

`normalizeParams()` is the only place user input becomes trustworthy:

1. **Deep-merge over `DEFAULTS`** so a request can send one field or all of them.
2. **Coerce** — form values arrive as strings.
3. **Convert** — if `units: "in"`, every entry in `LENGTH_FIELDS` is multiplied
   by 25.4 and the unit flag becomes `mm`. Downstream code never asks about units.
4. **Clamp, don't throw.** Diameter to 30–1500 mm, width 6–400, joint clearance
   0.05–0.6, and so on. A configurator that replans on every keystroke sees a
   lot of half-typed numbers; erroring on them makes the UI flicker between
   "model" and "stack trace". Clamps that change intent (bore ≥ 50 % of the
   wheel, an impossible bolt circle) push a **warning**.

`LENGTH_FIELDS` is exported and `units.js` asserts at import time that its own
form-input table covers it. Adding a length parameter without teaching the unit
switch about it fails fast, in the browser console, on the first load — rather
than silently reading 220 mm as 220 inches.

## 4. The radial band model

Every wheel is the same stack of concentric bands:

```
  0        bore        hub ring        web band          rim ring   tread   R
  ├──────────┼─────────────┼───────────────┼────────────────┼─────────┤
             │             │               │                │
          boreMaxR       rHub           rWebOut          rRimIn     R−tread
```

| Band | Rule |
| --- | --- |
| Rim | `clamp(R·0.05, 6, 14)` mm thick — enough to carry tread cuts and a dovetail. |
| Tread | `crownDrop + treadDepth` (either may be 0). The crown eats radius before the tread does, so the rim band sits under the deepest point of both. |
| Hub | `boreMaxR + clamp(boreMaxR·0.4, 5, 12)`, at least 13 % of R, at least 16 mm; bolt hubs also clear the bolt circle. |
| Web | Whatever is left between hub and rim; 1 mm of breathing room at each end. |

If the web band collapses (hub nearly touching rim) the planner degrades to a
solid web and says so in the notes, rather than emitting a pattern that would
undercut the rings.

## 5. Dovetail joints

Seams are radial planes. Each seam carries **axial slide dovetails**: a
trapezoidal tenon on one face, the same trapezoid plus clearance as a pocket on
the other. Both are part of the piece's 2D outline, so the generated CAD needs
no extra bodies — the joint is *in the profile*.

```
  tenon (on face A)          pocket (on face B, +clearance/side)
      ┌──────┐                     ┌────────┐
      │      │                     │        │
   ───┘      └───               ───┘        └───
      neck ≈ 0.62 × head
```

Sizing is driven by the band that hosts it: head half-width `clamp(band·0.35, 0, 6)`,
neck 62 % of that, tangential depth `clamp(head·1.15, 2.5, 7)`. Bands too thin
to host a joint (a tiny wheel's rim, a tight hub ring) drop it, with a warning
or a note — a dovetail smaller than 1.6 mm of head is a stress riser, not a joint.

Consequences of the "axial slide" choice, all deliberate:

- Any piece can be inserted last (there is no wedge order to solve).
- Dovetails resist circumferential separation — the load that matters on a wheel.
- Axial retention comes from adhesive (or hub bolts), which the assembly guide
  says out loud.

## 6. The segment-count solver

For an annular sector of `N` segments, half-angle `α = π/N`:

```
  width  = 2·(R·sin α + jointDepth)
  depth  = R − rInner·cos α + jointDepth
```

The solver walks `N` upward from 1, takes the first that fits the usable bed in
either orientation, and then keeps walking when a larger count buys something —
notably bolt holes that clear the seams. Within the fitting counts it prefers
those matching the hub's rotational symmetry (a hex bore likes 2/3/6/12), because
that is what makes pieces identical.

Two facts worth knowing:

- **Width shrinks quickly with N; depth does not.** `depth → R` as `N → ∞`. A
  pie slice is never shallower than the wheel's radius, which is why very large
  wheels on small printers get a warning instead of a 24-segment plan. The fix
  is a second split *ring*, which is on the roadmap.
- The wheel's **width** is never split — it must fit printer Z.

## 7. Why the pieces come out identical

Deduplication is feature-aware. For each segment `k`, the planner computes which
hub features intersect that segment's angular window — keyway, D-flat, bolt
holes — and hashes them into a signature. Segments with equal signatures share
one source file:

```
  N = 6, keyed bore  →  A(keyway) ×1 + B ×5      → two files
  N = 6, hex bore    →  A ×6                     → one file
  N = 8, 4 bolts     →  A(no hole) ×4 + B ×4     → two files
```

Two supporting mechanisms:

- **Bolt phase rotation.** When `N / gcd(N, boltCount)` is even, the natural
  half-pitch phase drops every hole exactly on a seam. Those cases — and only
  those — are rotated by half the seam-lattice pitch, so no piece ever carries a
  half-open hole. The solver also requires 1 mm of wall between hole edge and
  seam, scanning past the minimum fitting count when needed.
- **Patterns repeat per segment.** Spokes are snapped to a multiple of `N`
  (`Spoke count adjusted 7 → 6`), tread lugs and grooves likewise, and every
  web pattern is laid out inside one sector and repeated. A web therefore never
  costs a unique piece, and no seam is left half-cut.

## 8. Seam keep-outs

Near a seam, material has to stay solid or the dovetails have nothing to live
in. `faceMarginAng(r) = (jointDepth + 2.5) / r` (radians → degrees) is the
angular keep-out from each radial face at radius `r` — wider near the hub, where
the same millimetres cost more degrees. Every web pattern queries it and either
shrinks, drops cells, or leaves that ring solid, reporting what it did:

> ℹ 2 auxetic rings near the hub had no room for the pattern clear of the seams; left solid.

## 9. The webs

### 9.1 Honeycomb — a true hex lattice

Cells sit on the real hex lattice (two basis vectors, half-pitch stagger), not
on "rings of cells", which is what guarantees a uniform wall by construction:
neighbouring cells are always exactly `pitch − acrossFlats` apart. `orientation`
swaps the basis vectors, so a tangential lattice is the same packing turned 30°,
stagger and all. `round` cells are the hex's inscribed circle and filleted cells
lie strictly inside the sharp hex, so both reuse the hex fit test and pack
identically. A cell budget (default 64/segment) grows the cell size until the
count fits, in quantised steps so tuned configurations stay byte-identical.

### 9.2 The chart — how the curved webs are built

The lattice, auxetic, graded and voronoi webs are laid out in an **unrolled** band:

```
  Φ(θ, t) = polar(rWebIn + t·bandW, θ)      θ ∈ [0, A]°,  t ∈ [0, 1]
```

Φ is a homeomorphism on the strip and orientation-preserving, so **cells drawn
disjoint in the chart come out disjoint on the wheel**. That matters more than
it sounds: overlapping cells merge into open voids in CAD and shred the
preview's triangulation, and checking a few thousand cell pairs after the fact
is both slow and fragile. Here it is a property of the map.

What Φ distorts is *distance* — one degree of θ buys `r·π/180` mm of arc, more
the further out you go. So every wall is converted to degrees **at the innermost
radius it touches**, making the number the user typed the minimum material
anywhere along that wall. Two corollaries the code pays for explicitly:

- A leaning strut is thicker measured tangentially than across itself, so
  `strutWidth` is taken as the perpendicular thickness and the lattice gives up
  `strutWidth / cos φ` of arc for it. The neck between the cells above and below
  a crossing then works out to `strutWidth / sin φ` — never the tighter of the
  two, so it needs no policing.
- Curved edges are emitted as **chords**, and a chord falls *inside* the arc it
  replaces. On a cell's inner boundary that eats into the wall. Chord length is
  held under `√(8·r·sag)` with `sag = 0.06 mm` (counting radial travel, not just
  angular sweep), and every wall carries the leftover sag as an allowance.

Corner fillets follow the same discipline: a convex corner only gives material
back and is free, but a **reflex** corner (the auxetic waist) bows *into* the
neighbouring wall by `r·(1/cos(turn/2) − 1)`, so the fillet radius there is
capped at the slack that corner actually has.

### 9.3 Interlaced lattice

Two pencils of straight chart lines, `θ = c ± L·t`, crossing on `rows + 1`
evenly spaced levels; the diamond centred on each crossing spans one strut pitch
across and two levels up, and levels stagger by half a pitch. Two rows and up
weave; one row leaves alternating triangles — a chevron truss. Strut counts snap
to a multiple of the segment count.

### 9.4 Auxetic (re-entrant)

Hexagonal cells with the two waist vertices pulled *inside* the cell, so ribs
fold instead of stretching and the web draws inward under load (negative
Poisson's ratio — the reason the pattern shows up in airless-tire research).
Cells sit on concentric rings, brick-staggered ring to ring, all sharing one
angular pitch taken from the **outermost** ring (the roomiest), so columns line
up and inner rings drop only the columns the seam keep-outs actually cost them.

### 9.5 Graded rings

Concentric rings of cells that grow with the radius — the regular counterpart to the
voronoi. One angular pitch is shared by the whole web, so a cell is as wide as its
radius makes it, and `grade` spaces the ring boundaries geometrically so the height
grows with it: every cell a scaled copy of the one inside it. Walls hold the same two
ways the auxetic's do — a full `wall` between ring boundaries radially, and an angular
gap subtending a `wall` chord at each ring's *inner* radius.

Two wrinkles are worth knowing. The seam keep-out is a fixed number of millimetres, so
it costs a hub ring several times the degrees it costs a rim ring; each ring therefore
takes the whole number of cells nearest the shared pitch and **stretches to fill its own
run**, rather than centring a short row and leaving most of a cell standing solid beside
the joint. And `swirl` leans every cell off radial by shearing the chart — at any given
`t` it moves every cell of a ring by the same amount, which is exactly why the walls
survive it; the run gives that lean back at both ends, so a swirled ring carries fewer
cells rather than losing them to the seam.

### 9.6 Voronoi

Jittered-grid seeds in the chart, two rounds of Lloyd relaxation (even, but not
machined-looking), then every cell pulled back by half a wall. The pull-back is
metric-aware per edge, and both owners of a shared edge run the same numbers off
the same edge — so the two half-walls add up to exactly the wall the user asked
for. Randomness is `mulberry32(seed)`: same seed, same web, in the browser and
on the server.

## 10. Tread and tire cross-section

The tread is not cut into the wheel — it **is** the wheel's outer boundary.
Bars are described by the *windows between them*, notched straight into the
piece profile; the material left between neighbouring windows is the bar. So a
lugged wheel costs the engine no more than a slick one. Counts snap to
multiples of `N` so seams land between bars.

| `tread` | Shape |
| --- | --- |
| `slick` | Smooth. |
| `lugged` | Straight transverse bars. |
| `angled` | Bars slanted by `treadAngle`. |
| `chevron` | Bars angling in from both shoulders to meet at the centreline. |
| `ribbed` | Circumferential grooves. |
| `diamond` | Both. |

The **cross-section** (`profile.shape`) is `flat`, `crowned` by a settable
`crownDrop`, or `round` — the drop taken to the half-width, giving a true
semicircular bicycle-tire section on a circular arc of radius (h² + d²)/2d. The
drop is capped so a rim band and a web always survive beneath it.

The cross-section is **cut, not drawn**. The piece profile is flat, and one
revolved tool takes the crown and every circumferential groove out of it in a
single pass (§12), so the finished running surface is an exact arc of the
section circle at any width. It used to be lofted through sampled heights,
which was not merely more machinery but *wrong*: a circular section curves
hardest at the shoulders, exactly where uniform sampling is thinnest, and on
the Ø200 × 28 round preset that left the shoulder **2.99 mm** off the true arc
— more than that tread was deep. Measured on the built STL, the revolve is
0.0000 mm out.

Three consequences follow, and they are the point of the arrangement:

- **The bars are not a special case.** Their windows are notched into the flat
  profile at a constant floor radius, and where the crown falls past that floor
  it takes the window with it. So bars stand full-depth at the centreline and
  fade out towards the shoulders, the way a moulded tire's do, without the
  planner arranging it.
- **The crown and the windows overlap rather than stack.** The rim band sits
  under whichever of `crownDrop` and the tread depth is deeper, not under their
  sum, which is what the lofted crown had to assume — every crowned wheel used
  to give up a band of radius it never actually used.
- **Grooves cost nothing.** They are runs of the same revolved profile, so a
  crowned tread takes as many as a flat one. They used to be capped at two on a
  crowned profile because each was a parabolic dip in the section curve and
  each dip cost three more loft levels. A groove floor is now the section
  circle shrunk by the groove depth, which is a constant depth measured
  *perpendicular to the tread* — what a moulded groove actually is, and not the
  same thing as a constant depth measured radially.

What still varies the profile with height, and so still lofts, is a **slanted
tread** — `angled` and `chevron` — and only that. Its sections must stay
congruent: a loft can only raise a surface between profiles that match entity
for entity, so a bar window may never leave its own pitch cell. With an auto
bar count the planner *spaces the bars out* to grant the angle asked for; pin
`treadCount` and the angle gives way instead, with a note. `wheel.test.js`
sweeps 2520 combinations asserting congruence.

## 11. Bores, and the boolean we don't ask for

Two schemes, chosen by bore family:

| Bore | Scheme | Why |
| --- | --- | --- |
| keyed, hex, D | Wedge **overshoots** inward past the bore; a bore-shaped cutter trims the tip | Their features cross seam lines, and the keyway tool's face is tangent to the wedge-tip arc — the trim has to stay. |
| plain, bolt pilot | The sector outline **carries the bore arc directly**; no cutter at all | The bore boundary inside a wedge is just an arc, so the trim is unnecessary. It was also once mandatory: the old hosted engine rejected that razor-thin coaxial subtraction outright ([WW-1](zoo-api-notes.md#ww-1--razor-thin-coaxial-subtractions-are-rejected)). OpenCascade would take it; not asking is still the cheaper answer. |

One-piece wheels keep the bore as a real through-hole in both cases: a full
circle outline needs one.

The upshot is visible in the output — `piece-A.py` of a segmented bolt wheel
carries `CUTTERS = []` and builds from its boundary alone.

## 12. Building the solids

The emitter (`src/lib/occgen.js`) is deliberately boring, and that is the
strategy: *every* number is precomputed by the planner, so a generated
`piece-*.py` is a declaration rather than a program — the piece's boundary at
each height, and the list of prisms to take out of it.

```python
W = 50

SECTIONS = [
    {"z": 0, "kind": "sector", "segs": [
        {"kind": "line", "a": [9.2, 0], "b": [16.346, 0]},          # dovetail pocket
        {"kind": "arc", "a": [177.8, 0], "b": [177.664, 6.965],
         "center": [0, 0], "ccw": True},                            # tread bar wall
        …
    ]},
]

CUTTERS = [
    # bore
    {"shape": "circle", "c": [0, 0], "r": 10.2, "z0": -1, "z1": 51},
    # web void
    {"shape": "poly", "pts": [[62.1, 14.0], …], "z0": -1, "z1": 51},
    # tire — the crown and every groove, drawn in (r, z) and swept about the axis
    {"shape": "revolve", "seam": 210, "segs": [
        {"kind": "line", "a": [171.8, -1], "b": [171.8, 0]},
        {"kind": "arc", "a": [171.8, 0], "b": [171.8, 50],
         "center": [122.717, 25], "ccw": True},
        …
    ]},
]
```

`wheelwright_occ.build()` then does the same two things for every wheel there
is:

```python
blank = prism(SECTIONS[0], W)      # straight tread: one section
      | loft(SECTIONS)             # slanted tread: several
piece = blank - [solid(c) for c in CUTTERS]
```

Every cutter but one is a prism. The exception is the **tire** — the running
surface, crown and grooves together — whose profile is drawn in the (r, z)
half-plane and swept a full turn about the axis, so the crown comes out as a
real arc of the section circle rather than a chain of facets (§10).

That uniformity is worth dwelling on, because it is not what a generator
normally gets. Wheelwright's previous backend emitted KCL for a hosted engine,
and on that engine **booleans were the scarce resource, not entities**: the demo
wheel's twelve cutters took ~80 s, and busier wheels came back `Batch edit
result is not valid`, hung mid-subtract, or dropped the modeling connection. So
every full-depth cut — bore, keyway, bolt holes, web voids, tread bars — had to
be folded back into the profile as another loop in the same sketch, resolved by
a `region()` seed point, leaving only genuinely partial-depth cuts as tools.
Crowns could not be cut at all, because that engine refused any boolean whose
operands carried curved faces.

OpenCascade has none of those limits. The busiest wheel in the matrix subtracts
35 tools from a lofted solid in about a second, and the 19 configurations the
two backends were compared over built in 36.6 s of kernel time. So the through/partial distinction stops
being load-bearing: it survives only as `z0`/`z1`, which grooves genuinely need,
and `region()` seed points are not needed at all.

**One boolean, many tools.** The cutters go into a single `BRepAlgoAPI_Cut` with
the whole tool list, rather than one cut per tool. OpenCascade fuses the tools
once and cuts in a single pass, which is both faster and less prone to leaving a
sliver where two cuts touch.

House rules, each one earned:

| Rule | Reason |
| --- | --- |
| Only `MakeWire`, `MakeFace`, `MakePrism`, `MakeRevol`, `ThruSections`, `Cut` and the two writers | The best-trodden paths in the kernel. No fillets, no shells, no sweeps to go wrong. |
| Endpoints are **never** moved | Consecutive entities in a loop share their endpoint exactly, and the wire is chained through shared vertices to keep it that way. The tempting repair — projecting an arc's endpoints onto a mean radius, which the KCL emitter had to do — moves them off their neighbours; `MakeWire` then returns an unclosed wire and `MakeFace` answers with a degenerate sliver instead of an error. A Ø355.6 mm sector prism measured 7 901 mm³ that way, against 612 000. |
| Arcs are built from three points | An arc is over-determined by start, end and centre, and the planner rounds all three to 1e-3 mm independently, so the endpoints disagree about their radius by ~1e-3. Fitting a circle through start, midpoint and end needs no agreement between them. |
| Every wire is normalised counter-clockwise | The planner walks some loops clockwise. `MakeFace` forgives that; `ThruSections` does not, and an inverted section wire lofts an inside-out solid whose only symptom is a negative volume. |
| Loft `ruled=True` | The planner spaces its sections so straight segments between them are the intended surface; a smoothed loft would bulge the tread between bar rows. |
| Cutters overshoot the part in Z (`z0 = −1`, `z1 = W + 1`) | A tool face exactly coplanar with the body's is a classic way to make a boolean ambiguous. |
| The blank is drawn 0.05 mm oversize in radius whenever a tire tool will trim it | The same rule in the other direction. The tool's inner surface *is* the finished surface, so a blank drawn at exactly R meets it tangentially along the mid-width circle, and coincides with it outright on a flat grooved tread. Measured: the cut left a Ø355.6 crowned wheel's 813 972.2 mm³ untouched. Lifting the blank clear makes the tool cross it at every height. The footprint quoted to the user is measured without it. |
| The tire's seam is parked where the piece has no radial face | A full revolution's seam is a real edge, and a boolean whose body has a planar face in that seam's plane silently does *nothing* — no error, the blank simply comes back unchanged. A segmented piece puts it on the far side of the wheel; a one-piece one puts it down the middle of a tread bar. |
| The tire's back face sits at `R + 2` | It only has to clear the blank, but a back face close in leaves a razor-thin ring of tool at mid-width and the cut stops being clean: the result crept from 623 792 mm³ at `R + 0.2` down to a stable 620 530 by `R + 2`. |
| Booleans run with a fuzzy value of 1e-3 mm | The planner rounds every coordinate onto that grid, so nothing finer is real. Left at the default the kernel hunts for intersections at 1e-7 that the input never expressed, and returns slivers. Still a thousand times finer than the thinnest wall the planner will lay down. |
| The result is passed through `UnifySameDomain` | A boolean hands a cut curved surface back as several faces on the same geometry, occasionally two on the same patch — which triangulates to duplicate triangles. Merging them changes topology only, and leaves less to mesh: it took the matrix from 35 s of kernel time to 22 s. |
| Numbers rounded to 6 decimals | A thousandth of a micron — far below any printer, and below the planner's own 1e-3 mm grid. It exists so a configuration regenerates byte-identically. |
| Every file opens with a comment header | The file names the wheel, the piece and its print quantity, so it survives being separated from the bundle. |

**What ships is what runs.** The bundle carries `wheelwright_occ.py` and
`build.py` verbatim — the same bytes `src/lib/occ/` holds and the server
executes. `POST /api/export/stl` writes the bundle to a temp directory and runs
`python build.py` on it, so there is no second, private build path that could
drift from the one users get. `generateSource(plan, runtime)` takes those two
files as an argument rather than reading them, which is what lets the same
module run in Node and in the browser (where they are fetched from `/lib/occ`).

Alongside the sources the generator emits `ASSEMBLY.md` (print settings,
adhesive, glue-up order, build commands, warnings) and `wheelwright.json` (the
full parameter set and piece list — the machine-readable half of the bundle).

**The failure mode to know about.** Three of the rules above — the seam, the
radial overshoot, the fuzzy value — exist because of the same thing: a boolean
that reports success and returns the body unchanged, or very nearly. Nothing
downstream notices. The solid is valid, watertight, and the right shape for a
wheel; it is simply not crowned. So `npm run validate` builds each crowned
configuration a second time with that one tool removed and fails the run if the
two volumes agree. It is the only check with any teeth against a silent
no-op.

## 13. The preview

`public/preview.js` builds three.js geometry from the same plan. Three subtleties:

- **The bore is folded into the outline, not cut as a hole.** Feeding bore
  cutters to `ExtrudeGeometry` as `Shape` holes grew side walls wherever the
  hole loop crossed the outline — phantom thin-walled cylinders at every piece
  tip that the engine's STL never had. Since every bore region is star-shaped
  about the piece origin, the preview instead computes the true inner boundary
  as the polar curve `ρ(θ) =` furthest bore boundary along each ray, sampled
  between the two radial faces. Works for a keyway straddling a seam, too.
- **Crowned pieces are lofted here too**, not faked with a cylinder. Every
  section samples to a ring of matching length (the sections are congruent by
  construction, §10), consecutive rings stitch into quad strips, hole walls run
  vertical, and each cap is triangulated from its *own* ring — borrowing one
  end's triangulation for the other folds triangles inside out wherever slanted
  bars have moved. If the rings ever fail to match, the builder returns `null`
  and the caller falls back to a plain extrusion rather than drawing something
  torn.
- **A hole's wall faces the opposite way to the outline's.** A quad strip wound
  along its loop faces to the right of travel, so the side the material sits on
  decides the winding, not the loop's orientation alone: the outer skin faces
  away from its loop, a web void's wall faces into it. Winding both the same way
  leaves a mesh that still passes an edge count — every edge shared by two faces
  — and still shows a correctly outward tread, but every void is inside out, so
  the webs render see-through and the whole piece looks hollow. Only lofted
  pieces stitch their own walls, so this was a crowned/round-and-slanted-bar
  symptom exclusively; `ExtrudeGeometry` gets it right on its own.
- **2D fallback.** If WebGL is unavailable the same plan renders through
  `Path2D` on the same canvas — same outlines, same holes, top view. The
  viewport labels which one you're looking at.

`test/preview.test.js` asserts against the *triangulated mesh*, not the setup
code: minimum hub vertex radius equals the bore radius, no stray geometry.

## 14. Determinism and purity

- `planWheel()` never calls `Math.random()`, `Date`, or any I/O. Given the same
  parameters it returns the same plan, in Node and in the browser.
- The only randomness is `mulberry32(seed)` inside the voronoi web.
- The emitter rounds identically everywhere (`fmt()`), so re-running a
  configuration produces byte-identical files. That is what makes
  "these five configs regenerate byte-identical" a usable regression test.

## 15. Testing strategy

`npm test` runs 173 `node:test` cases with no dependencies and no network:

| Suite | What it pins |
| --- | --- |
| `wheel.test.js` (91) | Chunking math, joint clearance, dedupe, bolt/seam clearance, bore schemes, and the web patterns' guarantees — cell-to-cell wall, no overlap, no nesting, no self-crossing loops, band containment, seam clearance, measured on the finished millimetre geometry across 50 configurations. |
| `occgen.test.js` (39) | The emitted bundle across a 16-config matrix. The data blocks are read back and checked as geometry rather than as text: every loop closes to 1e-6 mm, every arc agrees with its own centre, cutters carry a sane depth range, a crowned piece emits congruent sections, and a configuration regenerates byte-identically. |
| `preview.test.js` (26) | The rendered triangulation matches the plan (this is where phantom-cylinder-class bugs die), including that a crowned piece previews crowned, that every lofted mesh is watertight and outward-facing, and that it encloses the same volume the equivalent extrusion does — the check that catches an inverted void. |
| `units.test.js` (6) | mm ⇄ in round-trips, which fields are lengths, and that the form table can't drift from `LENGTH_FIELDS`. |
| `env.test.js` (4) | `.env` parsing, and that the kernel status object keeps its shape whether or not OpenCascade is installed. |

Above that, `npm run validate` regenerates a 21-configuration matrix and — when
OpenCascade is installed — builds **every piece through the real kernel**,
failing the run if any piece comes back an invalid B-rep. The matrix is chosen
for shape diversity, not coverage optics: it includes the round-cell and
filleted-cell honeycombs, all three chart webs, a segmented bolt hub, a
D-bore, chevron and angled bars across a seam, and the two curved
cross-sections, because those are the profile shapes the kernel sees nowhere
else.

The whole matrix currently builds **21/21, 31 pieces, ~33 s of kernel time**,
every piece a valid B-rep and every STL watertight. It also re-builds each
crowned configuration without its tire tool and fails if that made no
difference — see §12. For contrast, the 19 of those configurations that predate
the backend change managed 14/19 against the hosted KCL engine, with the five
failures being timeouts and dropped connections rather than geometry errors,
and single pieces costing 85–146 s
([zoo-api-notes.md](zoo-api-notes.md#test-surface)). That gap is the reason
for the backend change, and §12 is what it bought.

## 16. Performance

The planner runs on every keystroke, in the browser, on wheels up to 1.5 m:

- The honeycomb lattice sweep rejects whole rings before testing cells and uses
  precomputed vertex offsets — without that, a 3 mm cell on a 1.5 m wheel is
  tens of thousands of candidates per pass.
- Chart webs carry a per-segment void budget (120) and grow cells to meet it.
- The UI debounces replanning by 120 ms.
- A crowned wheel is a single prism plus one revolved cut, so it plans and
  builds at the same cost as a flat one; only a slanted tread still lofts.
- Cell counts are bounded for the browser's sake — the preview triangulates
  every void. Downstream they are boolean tools, but 35 of them cost the
  kernel about a second, so the budget is a rendering limit now rather than a
  CAD one.

## 17. Adding a web style

1. Add the style to `WEB_STYLES` and a parameter group to `DEFAULTS`; put any
   lengths in `LENGTH_FIELDS` (and the matching inputs in `units.js`, which will
   refuse to load if you forget).
2. Lay the pattern out in chart coordinates and map it with `ch.xy` — you get
   the no-overlap guarantee for free. Convert every wall to degrees at the
   innermost radius it touches.
3. Respect `faceMarginAng(r)` and the cell budget; push a note when you change
   what the user asked for.
4. Emit cutters through `loopCutter()` so degenerate loops and bad region seeds
   are dropped rather than emitted as a loop the kernel can't close.
5. Add the style to the overlap/wall property tests, to `preview.test.js`, and
   to `scripts/validate-occ.js` if it produces a cutter shape the matrix doesn't
   already cover.
