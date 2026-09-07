# How Wheelwright works

Wheelwright turns a handful of numbers into printable CAD. This document is the
engineering tour: the data model, the geometry, the CAD-generation rules, and
why each of them is the way it is. The [user guide](user-guide.md) covers using
the app; [zoo-api-notes.md](zoo-api-notes.md) covers what we learned about the
Zoo platform underneath.

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
  preview.js                    kclgen.js
  three.js (2D fallback)        KCL + ASSEMBLY.md + manifest
                                       │
                                       ▼
                                 Zoo engine → STL
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
| `src/lib/kclgen.js` | ~240 | Plan → KCL text, `ASSEMBLY.md`, JSON manifest. |
| `src/lib/units.js` | ~96 | mm ⇄ inch form rewriting; single source of "what is a length". |
| `src/lib/zoo.js` | ~105 | Zoo CLI discovery, token resolution, `kcl export` invocation. |
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
one KCL file:

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

The lattice, auxetic and voronoi webs are laid out in an **unrolled** band:

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

### 9.5 Voronoi

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
crown is applied before the tread and the bar floors ride it, so bars stand
proud at the centreline and fade out at the shoulders as a moulded tire's do.
The drop is capped so a rim band and a web always survive beneath it.

Anything that varies with height turns the piece from one profile into
several — `plan.sections` — and those are lofted rather than extruded (§12).
Two rules keep the loft buildable:

- **Sections must stay congruent.** A loft can only raise a surface between
  profiles that match entity for entity, so a bar window may never leave its
  own pitch cell. With an auto bar count the planner *spaces the bars out* to
  grant the angle asked for; pin `treadCount` and the angle gives way instead,
  with a note. `wheel.test.js` sweeps 2520 combinations asserting congruence.
- **Circumferential grooves are the one tread feature that can still be a
  boolean**, and only on a flat profile, where the solid is prismatic. On a
  crowned one nothing may be subtracted at all (§12), so grooves are rolled
  into the section radius as a parabolic dip — round-shouldered, and capped at
  two because each costs three more profiles to loft through.

Flat grooves are emitted as a **sector wedge**, not a full ring: subtracting a
360° ring from a 60° sector is a sliver boolean, and that is what used to hang
a plain ribbed wheel past the five-minute CLI budget.

## 11. Bores, and the boolean we don't ask for

Two schemes, chosen by bore family:

| Bore | Scheme | Why |
| --- | --- | --- |
| keyed, hex, D | Wedge **overshoots** inward past the bore; a bore-shaped cutter trims the tip | Their features cross seam lines, and the keyway tool's face is tangent to the wedge-tip arc — the trim has to stay. |
| plain, bolt pilot | The sector outline **carries the bore arc directly**; no cutter at all | The bore boundary inside a wedge is just an arc, so the trim is unnecessary — and asking the engine to shave that razor-thin coaxial sliver is a boolean it rejects. See [WW-1](zoo-api-notes.md#ww-1--razor-thin-coaxial-subtractions-are-rejected). |

One-piece wheels keep the bore as a real through-hole in both cases: a full
circle outline needs one.

The upshot is visible in the output — `piece-A.kcl` of a segmented bolt wheel
contains `piece = blank` and no boolean whatsoever.

## 12. Generating KCL

The emitter (`src/lib/kclgen.js`) is deliberately boring, and that is the
strategy: *every* number is precomputed by the planner, so the generated file
has nothing for the solver to solve and nothing ambiguous for the engine.

**Booleans are the scarce resource, not entities.** The engine gets slow and
then unreliable as the tool list grows: the demo wheel's twelve cutters took
~80 s, and busier wheels came back `Batch edit result is not valid`, hung
mid-subtract, or dropped the modeling connection. So every cut that runs the
full depth of the piece — bore, keyway, bolt holes, every web void, every
tread bar — is emitted as **another loop in the same sketch**, and `region()`
resolves the material face between them in one pass. Same wheel, same
500-triangle solid, 3 s instead of 80 s. Only genuinely partial-depth cuts
survive as tools.

```kcl
@settings(defaultLengthUnit = mm, kclVersion = 1.0)

sec1Sk = sketch(on = XY) {
  e1 = line(start = [9.2, 0], end = [16.346, 0])          // dovetail pocket
  …
  e10 = arc(start = [177.8, 0], end = [177.664, 6.965], center = [0, 0])
  e11 = line(start = [177.664, 6.965], end = [174.166, 6.828])   // bar wall
  e12 = arc(start = [174.166, 6.828], end = [173.781, 13.437], center = [0, 0])
  …
  h1 = circle(start = [10.2, 0], center = [0, 0])         // bore — a loop
  h2_1 = line(…)                                          // keyway
  h3_1 = line(…)                                          // web void
}
sec1 = region(point = [147.099, 84.928], sketch = sec1Sk)
hide(sec1Sk)
blank = extrude(sec1, length = 50)
piece = blank
```

A curved cross-section is `loft`ed through one such sketch per z level instead
of extruded:

```kcl
blank = loft([sec1, sec2, sec3, sec4, sec5])
```

That is forced, not stylistic. The engine refuses any boolean whose operands
carry curved faces — revolved *and* lofted tools alike, and `intersect` as well
as `subtract` — so a crown can never be cut in; it has to be in the profile
from the start. See [WW-12](zoo-api-notes.md#ww-12--booleans-reject-any-operand-with-curved-faces).
Lofting costs minutes per
piece against seconds for a flat wheel, which is why flat wheels keep the
single-extrude fast path and the export timeout is 900 s.

House rules, each one earned:

| Rule | Reason |
| --- | --- |
| Only `sketch`, `region`, `extrude`, `loft`, `offsetPlane`, `circle`, `line`, `arc`, `subtract`, `hide` | The most battle-tested operations in the engine. No fillets, no shells, no sweeps to go wrong. |
| Full-depth cuts are sketch loops, never tools | Boolean count is what breaks the engine; entity count is not. |
| Arcs emitted **start → end CCW** | KCL solver arcs always sweep counter-clockwise; the planner walks some loops clockwise, so those endpoints are swapped at emit time. |
| Arc endpoints snapped onto a common radius | An arc is over-determined by start + end + center; a micron of disagreement is rejected, and reported as a bad region query point. See [WW-3](zoo-api-notes.md#ww-3--a-1-µm-arc-inconsistency-is-reported-as-a-bad-region-query-point). |
| Region seeding: `region(segments = […])` for a lone closed curve, `region(point = …, sketch = …)` otherwise | The seed must be solid in *every* section, so it sits in the rim band — under the deepest tread valley and over the web. A seed that lands in a void resolves to the wrong face. |
| Cutters overshoot the part in Z (`z0 = −1`, `z1 = W + 1`) | Faces exactly coplanar with the body are a known engine failure class. |
| `subtract` batched at 12 tools per call | Long tool lists are a documented-by-experience failure. Rarely reached now — most wheels emit no boolean at all. |
| Numbers rounded to 6 decimals | A thousandth of a micron: far below any printer, and far below the arc tolerance above. A rim carries fifty-odd tread arcs and a loop is only as closed as its worst entity. |
| Every file opens with a comment header | The file names the wheel, the piece and its print quantity, so it survives being separated from the bundle. |

Alongside the `.kcl` files the generator emits `ASSEMBLY.md` (print settings,
adhesive, glue-up order, export commands, warnings) and `wheelwright.json` (the
full parameter set and piece list — the machine-readable half of the bundle).

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
- The KCL emitter rounds identically everywhere (`fmt()`), so re-running a
  configuration produces byte-identical files. That is what makes
  "these five configs regenerate byte-identical" a usable regression test.

## 15. Testing strategy

`npm test` runs 116 `node:test` cases with no dependencies and no network:

| Suite | What it pins |
| --- | --- |
| `wheel.test.js` (38) | Chunking math, joint clearance, dedupe, bolt/seam clearance, bore schemes, and the web patterns' guarantees — cell-to-cell wall, no overlap, no nesting, no self-crossing loops, band containment, seam clearance, measured on the finished millimetre geometry across 31 configurations. |
| `kclgen.test.js` (7) | KCL well-formedness across a config matrix: balanced blocks, entity naming, arc winding, arc-endpoint radius agreement, batch sizes, that full-depth cuts are sketch loops rather than tools, and that a crowned piece lofts instead of extruding. |
| `preview.test.js` (10) | The rendered triangulation matches the plan (this is where phantom-cylinder-class bugs die), including that a crowned piece previews crowned, that every lofted mesh is watertight and outward-facing, and that it encloses the same volume the equivalent extrusion does — the check that catches an inverted void. |
| `units.test.js` (6) | mm ⇄ in round-trips, which fields are lengths, and that the form table can't drift from `LENGTH_FIELDS`. |
| `env.test.js` (4) | `.env` parsing and token resolution precedence. |

Above that, `npm run validate:kcl` regenerates a 19-configuration matrix and —
when a Zoo CLI and token are present — round-trips **every piece through the
real engine**. The matrix is chosen for shape diversity, not coverage optics: it
includes the round-cell and filleted-cell honeycombs, all three chart webs, a
segmented bolt hub, a D-bore, chevron and angled bars across a seam, and the
two curved cross-sections, because those are the profile shapes the engine sees
nowhere else. Live results, including a reproducible engine hang, are in
[zoo-api-notes.md](zoo-api-notes.md#test-surface).

## 16. Performance

The planner runs on every keystroke, in the browser, on wheels up to 1.5 m:

- The honeycomb lattice sweep rejects whole rings before testing cells and uses
  precomputed vertex offsets — without that, a 3 mm cell on a 1.5 m wheel is
  tens of thousands of candidates per pass.
- Chart webs carry a per-segment void budget (120) and grow cells to meet it.
- The UI debounces replanning by 120 ms.
- Cell counts are bounded for the engine's sake as much as the browser's: every
  void is a boolean tool downstream.

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
   are dropped rather than emitted as KCL the engine can't resolve.
5. Add the style to the overlap/wall property tests, to `preview.test.js`, and
   to `scripts/validate-kcl.js` if it produces a cutter shape the matrix doesn't
   already cover.
