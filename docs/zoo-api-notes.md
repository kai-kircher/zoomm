# Zoo platform field notes — bugs, friction, and suggestions

Everything we learned about Zoo's APIs while building Wheelwright, written so a
Zoo engineer can act on each item. Every finding here is first-hand: a repro we
ran, a measurement we took, or a workaround that is in this repository and can
be deleted the day the underlying issue is fixed — which is the correct fate of
a workaround.

Wheelwright is an unusual load for the engine. It doesn't hand-write one model;
it *generates* CAD from a solver, so a bad afternoon produces a hundred variants
of the same shape with the numbers moved. That makes it good at finding the
edges of a CAD kernel, and most of what follows was found that way.

## Test surface

| Component | Version / how | How hard we leaned on it |
| --- | --- | --- |
| Design API engine | `zoo` CLI **0.2.186**, `zoo kcl export --output-format=stl` | 13-configuration matrix (`npm run validate:kcl`) plus ~35 individual exports during bisection, all on 2026-08-05 |
| KCL language | solver-sketch dialect, `@settings(defaultLengthUnit = mm, kclVersion = 1.0)` | every generated piece; 105 offline tests assert its well-formedness |
| `zoo kcl lint` | CLI 0.2.186, no token | probed as an offline validation story |
| Zoo CLI packaging | `scripts/setup-zoo.mjs`, KittyCAD/cli GitHub releases | per-platform install for anyone cloning the repo |

Severity: 🔴 blocks a class of geometry · 🟠 costs retries, time or credits ·
🟡 papercut.

### The 2026-08-05 matrix run

Thirteen configurations, every unique piece exported through the live engine.
Times are wall-clock for the config; ✗ 300 s means our client timeout fired
with **no output of any kind** from the CLI.

| Config | Tools in the heaviest piece | Result |
| --- | ---: | --- |
| `one-piece-plain` | 24 | ✓ 12.8 s |
| `rover-tpu-flexweb-hex` | 6 | ✓ 4.8 s |
| `caster-bolt-honeycomb` | 69 | ✓ 84.7 s |
| `wagon-bolt-segmented` | 9 | ✓ 7.0 s |
| `cart-bolt-segmented` | 1 | ✓ 4.3 s |
| `cart-14in-keyed` | 12 | ✗ hang, killed at 300 s, no stderr |
| `honeycomb-round-cells` | 37 | ✗ hang, killed at 300 s, no stderr |
| `dbore-diamond-solid` | 35 | ✗ hang, killed at 300 s, no stderr |
| `honeycomb-filleted-cells` | 36 | ✗ 8.5 s — `Unable to create a region that contains the requested query point` → [WW-3](#ww-3--a-1-µm-arc-inconsistency-is-reported-as-a-bad-region-query-point) |
| `lattice-woven-tpu` | 16 | ✗ 3.4 s — `Batch edit result is not valid` → [WW-4](#ww-4--batch-edit-result-is-not-valid-on-subtract-with-no-further-information) |
| `lattice-chevron-sharp` | 14 | ✗ 5.1 s — `Batch edit result is not valid` |
| `auxetic-reentrant-hex` | 58 | ✗ 104.9 s — `engine hangup: modeling connection interrupted; please reconnect and retry` |
| `voronoi-organic-bolt` | 46 | ✗ 81.1 s — same hangup |

**Honesty about the setup:** during part of that run we were bisecting failures
in a second process on the same token, so some exports overlapped. Every failure
below was afterwards reproduced **serially, with nothing else in flight**, and
the reproductions are what the findings rest on. One finding (WW-3) was our bug
as much as Zoo's; it is fixed in this repo and reported here anyway, because the
error message is what made it expensive.

---

## Part 1 — Engine reports

### WW-1 · Razor-thin coaxial subtractions are rejected

*Severity: 🔴 — worked around by design change*

- **Error:** `engine: The Zoo engine cannot handle this 3D subtraction yet`
- **Repro shape:** subtract a bore-sized cylinder from a sector wedge whose tip
  extends *just* past it, so the tool shaves a thin coaxial sliver:

  ```kcl
  // sector wedge, N = 8 (45°), tip at rInner = 5.2
  piece = subtract([blank], tools = [cut1])   // cut1 = circle r = 6.2, concentric
  ```

  The tool's surface runs parallel to the blank's inner cylinder, 1.0 mm away.
- **Actual:** rejected — with a single tool, so this is not a batch-size issue.
- **The interesting part — it is threshold-dependent.** The *same topology*
  succeeds at keyed-hub dimensions (bore 10.2, wedge tip 9.2, 60° sectors) and
  fails at pilot-bore dimensions (6.2 / 5.2, 45°) on engine 0.2.186. Whatever
  the internal tolerance is, users cross it by changing a diameter — and get an
  error that reads like the operation is unsupported in principle.
- **Workaround (shipped):** don't ask for the boolean. For bore families that
  are concentric circles (plain bores, bolt pilots) the exact bore boundary
  inside a wedge is just an arc, so the sector outline carries that arc directly
  and the cutter is dropped ([`src/lib/wheel.js:562`](../src/lib/wheel.js)).
  Piece A of a segmented bolt wheel now contains `piece = blank` and no boolean
  at all. Shaped bores (keyed, hex, D) keep the overshoot-and-trim scheme,
  because their features cross seam lines. Locked by a test
  ([`test/kclgen.test.js`](../test/kclgen.test.js), *"segmented bolt pieces
  never subtract the pilot bore"*) and by a matrix config.
- **Suggested fix:** tolerant CSG for parallel-surface slivers; failing that,
  document the minimum thickness and make the error name the two surfaces —
  `subtract: tool 'cut1' leaves a 1.0 mm sliver against face #3 of 'blank'`
  would have been a five-minute fix instead of a bisection session.

### WW-2 · Export time is wildly unpredictable, and sometimes never ends

*Severity: 🔴 — this is the one that hurts most*

Measured on 2026-08-05, engine 0.2.186, same machine, same token:

| Input | Result |
| --- | --- |
| 15-line file: one rounded-hexagon prism, 12 entities | **417.6 s** ✓ |
| The same class of file, other cells | 1.1 – 1.4 s ✓ |
| Wheel piece, 151 lines, 12 tools (`cart-14in-keyed` A) | **killed at 300 s**, no output |
| The same piece reduced to 3 lug cutters | **killed at 420 s**, no output |
| The same piece reduced to **9** lug cutters (strictly more work) | 11.7 s ✓ |
| One lattice void prism (`lat2`) alone | 339.9 s, then `engine hangup: Modeling command failed: websocket closed early` |
| The same prism plus another (`lat2` + `lat3`) | 6.1 s ✓ |
| 69-cutter honeycomb wheel | 84.7 s ✓ |

So: **runtime is not a function of model complexity**, a smaller input can be
orders of magnitude slower than a larger one, and 3 of 13 matrix configurations
never returned at all. While hung, the CLI pins a CPU core (241 s wall ≈ 238 s
CPU) — so from the client side there is no way to distinguish "working hard"
from "wedged".

Two adjacent failure modes with the same flavour:

- `engine hangup: modeling connection interrupted; please reconnect and retry
  (API call ID: c654d375-…)` after 80–105 s on the auxetic and voronoi wheels.
  The CLI does not reconnect and retry; it exits.
- `engine hangup: Modeling command failed: websocket closed early` after 340 s.

- **Cost to us:** `/api/export/stl` is synchronous, so a hung session is a
  spinner that never resolves. Our 300 s client-side timeout is the only bound,
  and killing the CLI mid-session yields **no stderr**, so the user gets
  `zoo kcl export failed: unknown error` — the least useful sentence we ship.
- **Suggested fixes**, in the order we'd want them:
  1. **Server-side liveness.** If a modeling session makes no progress, kill it
     and return an error. Silence is the worst possible outcome.
  2. **An async job mode for `kcl export`** — the ML endpoints already work this
     way. `POST` → job id → poll. Then retry, resume and progress reporting are
     the platform's job instead of every client's.
  3. **`--timeout` and automatic reconnect in the CLI**, so `engine hangup`
     retries once before it becomes the user's problem.
  4. **Honest p99 numbers in the docs.** "Usually seconds" set expectations that
     the 417 s single hexagon does not meet.

### WW-3 · A 1 µm arc inconsistency is reported as a bad region query point

*Severity: 🟠 — the geometry was ours; the error message is the bug*

- **Error:** `engine: Unable to create a region that contains the requested
  query point`
- **Minimal repro** — a rounded hexagon, seed at its exact centre. Fails in
  1.1 s, every time:

  ```kcl
  @settings(defaultLengthUnit = mm, kclVersion = 1.0)

  cut4Sk = sketch(on = XY) {
    e1  = line(start = [9.67, 1.25],    end = [5.918, 7.75])
    e2  = arc(start = [5.918, 7.75],    end = [3.752, 9.0],   center = [3.752, 6.5])
    e3  = line(start = [3.752, 9.0],    end = [-3.753, 9.0])
    e4  = arc(start = [-3.753, 9.0],    end = [-5.918, 7.75], center = [-3.753, 6.5])
    e5  = line(start = [-5.918, 7.75],  end = [-9.671, 1.25])
    e6  = arc(start = [-9.671, 1.25],   end = [-9.671, -1.25], center = [-7.506, 0.0])
    e7  = line(start = [-9.671, -1.25], end = [-5.918, -7.75])
    e8  = arc(start = [-5.918, -7.75],  end = [-3.753, -9.0], center = [-3.753, -6.5])
    e9  = line(start = [-3.753, -9.0],  end = [3.752, -9.0])
    e10 = arc(start = [3.752, -9.0],    end = [5.918, -7.75], center = [3.752, -6.5])
    e11 = line(start = [5.918, -7.75],  end = [9.67, -1.25])
    e12 = arc(start = [9.67, -1.25],    end = [9.67, 1.25],   center = [7.505, 0.0])
  }
  cut4 = extrude(region(point = [0, 0], sketch = cut4Sk), length = 10)
  ```

- **What we ruled out first**, because the message pointed at the query point:
  moving the seed off centre (still fails), translating the whole profile to the
  origin (still fails), reversing every arc's direction (still fails), replacing
  the fillets with sharp corners (**passes**, 1.2 s).
- **The actual cause:** `e1`'s endpoints are 2.500811 mm and 2.500000 mm from
  its stated centre. The arc is over-determined by start + end + center, and our
  generator had rounded the fillet tangent points and centres to 0.001 mm
  independently, so they disagreed by **8.1 × 10⁻⁴ mm**. Snap the endpoints onto
  a common radius and the same shape exports in 1.4 s.
- **Where the tolerance is:** 8.1e-4 mm rejected, 5.5e-5 mm accepted (we
  measured both, same profile).
- **Fixed on our side:** the emitter now projects arc endpoints onto the mean
  radius and drags the neighbouring entities with them
  ([`src/lib/kclgen.js:22`](../src/lib/kclgen.js), `snapArcEndpoints`), and a
  test asserts < 1e-4 mm across every configuration that emits arcs. The
  previously failing `honeycomb-filleted-cells` config now exports.
- **Suggested fix:** say what is wrong. `arc e1: endpoints differ from center by
  8.1e-4 mm (tolerance 1e-4)` turns an afternoon into a minute. Better still,
  snap within tolerance and warn — an over-determined arc from a code generator
  is going to be inconsistent in the last digit essentially always, and the
  tolerance is not documented anywhere we could find. A `kcl lint` rule for it
  would catch it offline, for free.

### WW-4 · `Batch edit result is not valid` on subtract, with no further information

*Severity: 🔴*

- **Error:** `engine: Batch edit result is not valid`, pointing at the subtract
  line. The same string zapim (our sibling project) sees for `union` of many
  solids — one message, several causes.
- **Repro** (serial, nothing else in flight), all from the same generated piece,
  varying only which void prisms are subtracted:

  | Tools in the call | Result |
  | --- | --- |
  | `lat1` | ✓ 4.6 s |
  | `lat3` | ✓ 4.6 s |
  | `lat2` + `lat3` | ✓ 6.1 s |
  | `lat1` + `lat2` | ✗ `Batch edit result is not valid`, 3.0 s |
  | `lat1` + `lat2` + `lat3` | ✗ same, 3.0 s |
  | bore + keyway + 9 lug prisms (11 tools) | ✓ 3.7 s |
  | `lat2` alone | ✗ 339.9 s, then `engine hangup: Modeling command failed: websocket closed early` |

- **So it is not a tool-count limit** — eleven tools pass where two fail. We also
  regenerated the same wheel with the emitter's batch size reduced from 12 to 8
  tools per `subtract`; it fails identically. Note the last row: the tool that
  appears in both failing combinations also killed the session on its own, in a
  different way, and yet succeeded when paired with `lat3` — so this may be the
  same nondeterminism as [WW-2](#ww-2--export-time-is-wildly-unpredictable-and-sometimes-never-ends)
  wearing a different error string. We can't tell from the client side, which is
  the point of [WW-5](#ww-5--engine-errors-carry-no-entity-information-the-meta-report).
- **The profiles are clean by every check we can run offline**: closed loops, no
  duplicate vertices, no self-intersections (all vertex pairs tested), the region
  seed strictly inside, minimum edge 0.3 mm, minimum interior angle 24°. Those
  are properties our test suite asserts for every web pattern, and we re-verified
  this exact file with a standalone checker before filing. `zoo kcl lint` is
  silent on it.
- **Suggested fix:** name the operand and the operation. "Batch edit result is
  not valid" tells the user nothing about *which* tool, *which* body, or what
  "not valid" means — and because the same string covers union-arity failures,
  two unrelated bugs look like one. If there is a batch limit, document the
  number; if there is a geometric precondition, say which tool violated it.

### WW-5 · Engine errors carry no entity information (the meta-report)

*Severity: 🟠*

WW-1 through WW-4 produce **four error strings between them**, and not one names
a solid, a face, a tool, or an entity. Parse errors, by contrast, are excellent:
miette-style diagnostics with source ranges and a caret under the offending
expression. The engine layer would be transformative with the same treatment,
because a generated model is where you *most* need it — there is no human who
"knows what they just drew".

Ranked by how much time each cost us: WW-3 (misdirected us for an afternoon),
WW-4 (still unexplained), WW-2 (silence is worse than any message), WW-1
(clear-ish, but no dimensions).

---

## Part 2 — Tooling and packaging

### WW-6 · `zoo kcl lint` is parse-only, and its output is a Rust `Debug` dump

*Severity: 🟡*

Verified on CLI 0.2.186, no token — so it *is* an offline validation story,
which we're glad exists. Two gaps:

```sh
$ zoo kcl lint broken.kcl        # subtract([blank], tools = [missingTool])
$ echo $?
0                                 # undefined variable: not caught
```

```sh
$ zoo kcl lint syntax.kcl
syntax: KclErrorDetails { source_ranges: [SourceRange([104, 105, 0])],
  backtrace: [BacktraceItem { source_range: SourceRange([104, 105, 0]), fn_name: None }],
  message: "Missing comma between arguments, try adding a comma in" }
$ echo $?
1
```

- **Suggested fixes:** (1) run the semantic pass — `@kittycad/kcl-wasm-lib`
  already offers mock execution, so the CLI could catch undefined variables,
  unknown functions and bad keyword args offline; a `zoo kcl check` would let
  CI reject bad generated code without spending engine time. (2) Print human
  diagnostics like the export path does (file:line:col, a caret) and offer
  `--format json` for tooling — byte offsets in a Rust struct dump means every
  client writes an offset→line:col mapper.

### WW-7 · There is no HTTP way to execute KCL, so every server ships a 104 MB binary

*Severity: 🟡*

Executing KCL means driving the modeling WebSocket API, and the supported client
for that is the CLI. For a web app that means the server shells out to a
**104 MB** platform binary. Our `npm run setup:zoo` downloads it from the
`KittyCAD/cli` GitHub releases by Rust target triple (`zoo-x86_64-pc-windows-gnu`,
`zoo-aarch64-apple-darwin`, `zoo-x86_64-unknown-linux-musl`, …), which we learned
by reading the release page, not the docs.

- **Suggested fixes:** a documented request/response endpoint for "here is KCL,
  give me a mesh" (even one capped at small models) would remove the binary from
  every deployment; failing that, an npm-installable launcher (`npx @zoo/cli`)
  and a docs page that states the asset-naming scheme.

### WW-8 · `zoo kcl export` always writes `output.<ext>`

*Severity: 🟡*

```
$ zoo kcl export --output-format=stl piece-A.kcl outdir/
Wrote file: outdir/output.stl
```

The input name is discarded, so exporting several pieces into one directory
overwrites the previous result, and clients can't predict the filename in
advance — we scan the directory for `*.stl` afterwards and use one temp
directory per piece ([`src/lib/zoo.js:93`](../src/lib/zoo.js)).

- **Suggested fix:** name the output after the input, add `--output-name`, or
  print a machine-readable line (`{"files":["…"]}`) with `--format json`.

### WW-9 · Three token environment variables, no stated canonical one

*Severity: 🟡*

`ZOO_API_TOKEN`, `ZOO_TOKEN` and `KITTYCAD_API_TOKEN` all appear in the wild and
the CLI accepts more than one. We resolve all three, in that order, because we
couldn't find a statement of which is current
([`src/lib/zoo.js:19`](../src/lib/zoo.js)). One line in the docs — "canonical:
`ZOO_API_TOKEN`; the others are legacy aliases" — retires the guesswork.

### WW-10 · Three version numbering schemes with no compatibility statement

*Severity: 🟡*

The CLI is `0.2.186`. The language pragma we write is `kclVersion = 1.0`. The
npm validator is `@kittycad/kcl-wasm-lib` `0.1.x`. Nothing states how these
relate, and a KCL file's durability depends on it: our sibling project observed
Text-to-CAD emitting `kclVersion = 2.0` in the same week. We pin `1.0` because
Zoo's shipping samples do, which is inference, not documentation.

- **Suggested fix:** a compatibility table (CLI ⇄ kcl-lib ⇄ engine ⇄ language
  version), and a statement of what an executor does when it meets a newer
  `kclVersion` than it speaks.

### WW-11 · Authoring rules a code generator needs, currently found by experiment

*Severity: 🟡*

Things we established empirically and now encode in the emitter:

| Rule | How we learned it |
| --- | --- |
| Arcs sweep **CCW from start to end** — a clockwise loop must swap endpoints | Trial and error |
| `region(segments = [sk.c1])` for a single closed curve; `region(point = …, sketch = …)` otherwise, and the point must be strictly inside | Trial and error |
| Arc endpoints must be equidistant from the centre to ~1e-4 mm | [WW-3](#ww-3--a-1-µm-arc-inconsistency-is-reported-as-a-bad-region-query-point) |
| Cutters should overshoot the body in Z — coplanar faces are a known failure class | Sibling project's bisection |

A "generating KCL programmatically" page collecting these — plus whatever limits
exist on tool counts and profile complexity — would be the single highest-value
documentation addition for API users, and would have saved this project several
sessions.

---

## Part 3 — What's already excellent

Credit where it's due; these are why the project is built on Zoo at all.

- **KCL is source code, and the artifact is the source.** Wheelwright ships
  `.kcl` files, not meshes: a user can open a generated wheel in Design Studio,
  change a number, and re-export. No other CAD API we looked at makes the
  generated model *editable by the person who received it*.
- **The solver-sketch dialect is genuinely readable.** Keyword arguments and
  named entities mean generated files look like something a human wrote —
  `e10 = arc(start = …, end = …, center = …)`, not a stream of opcodes. Our
  emitter is ~240 lines because the language does the work.
- **Parse diagnostics are best-in-class.** Source ranges, carets, and a
  suggested fix in the message. (Which is exactly why the engine-layer silence
  in WW-2/WW-4/WW-5 stands out so much — the bar was set by the same product.)
- **Exit codes that mean things, and stdin support.** `zoo kcl export … - out/`
  makes the CLI composable; a 40-line script pins a platform binary per OS.
- **The `kcl` subcommand family is a whole toolbox** — `volume`, `mass`,
  `center-of-mass`, `surface-area`, `bounding-box`, `snapshot`, `lint`. We
  originally planned to compute print mass ourselves; we're switching to
  `zoo kcl mass` instead. More of the platform's value is in that list than the
  docs suggest.
- **Design Studio as the escape hatch.** Every failure mode in Part 1 has the
  same fallback: hand the user the KCL and let them open it in the browser. A
  platform where the degraded path is still a good experience is a rare thing.

## Part 4 — If we could pick three

1. **WW-2 — bound the export.** Server-side liveness, or an async job mode.
   Everything else here is a bad hour; this one is an unbounded wait with no
   signal, and it is the only issue that reaches our end users directly.
2. **WW-5 / WW-4 — name the entity in engine errors.** Four opaque strings
   across four distinct bugs is what turns a five-minute fix into a bisection
   session. Parse errors already show how good this can be.
3. **WW-3 / WW-11 — write down the numeric contract.** Arc consistency
   tolerance, sliver thickness, batch limits, region-seed rules. Code generators
   are a growing share of Zoo's users and they need the tolerances, not just the
   grammar.

---

## Reproducing all of this

```sh
npm run validate:kcl          # 13 configs; with a token, every piece round-trips through the engine
```

The KCL for every configuration lands in `out/validate/…` and is byte-stable
across runs, so any file mentioned above can be regenerated and re-sent. Each
finding's repro is either that matrix, or the minimal file quoted inline.

Environment for every measurement in this document: Zoo CLI 0.2.186 on
Windows 11 (x86_64), `api.zoo.dev`, 2026-08-05, single user token, exports run
serially unless noted.
