// Wheelwright preview — renders the exact planner geometry.
// Primary renderer: three.js (CDN). If that import fails (offline demo),
// falls back to a faithful 2D top-view on the same canvas.

const TAU = Math.PI * 2;
const d2r = (d) => (d * Math.PI) / 180;

const angleOf = (p, c) => Math.atan2(p[1] - c[1], p[0] - c[0]);
const unwrapCCW = (a0, a1) => (a1 <= a0 ? a1 + TAU * Math.ceil((a0 - a1) / TAU + 1e-9) : a1);
const unwrapCW = (a0, a1) => (a1 >= a0 ? a1 - TAU * Math.ceil((a1 - a0) / TAU + 1e-9) : a1);

// Split cutters into the bore family (bore + keyway, hugging the piece
// origin), face holes (full-depth, interior) and circumferential grooves,
// which are the only cut left that does not run the full width. Tread bars
// are not here at all — they are notches in the section outlines now.
export function classifyCutters(cutters) {
  const boreFamily = [];
  const holes = [];
  const grooves = [];
  for (const c of cutters) {
    if (c.id.startsWith('groove')) grooves.push(c);
    else if (c.id === 'bore' || c.id === 'keyway') boreFamily.push(c);
    else holes.push(c);
  }
  return { boreFamily, holes, grooves };
}

// Build path commands for a cutter (shared by three.js Path and Path2D).
// emit: { move(x,y), line(x,y), arc(cx,cy,r,a0,a1,ccw) }
function traceCutter(c, emit) {
  if (c.shape === 'circle') {
    emit.move(c.c[0] + c.r, c.c[1]);
    emit.arc(c.c[0], c.c[1], c.r, 0, TAU, true);
  } else if (c.shape === 'poly') {
    emit.move(c.pts[0][0], c.pts[0][1]);
    for (let i = 1; i < c.pts.length; i++) emit.line(c.pts[i][0], c.pts[i][1]);
    emit.line(c.pts[0][0], c.pts[0][1]);
  } else if (c.shape === 'path') {
    traceSegs(c.segs, emit);
  }
}

function traceSegs(segs, emit) {
  emit.move(segs[0].a[0], segs[0].a[1]);
  for (const s of segs) {
    if (s.kind === 'line') emit.line(s.b[0], s.b[1]);
    else {
      const a0 = angleOf(s.a, s.center);
      let a1 = angleOf(s.b, s.center);
      a1 = s.ccw ? unwrapCCW(a0, a1) : unwrapCW(a0, a1);
      emit.arc(s.center[0], s.center[1], s.radius, a0, a1, s.ccw);
    }
  }
}

// Merged bore + keyway as one loop (holes may not overlap each other).
function traceKeyedBore(bore, keyway, emit) {
  if (!keyway) return traceCutter(bore, emit);
  const rb = bore.r;
  // Keyway rect: pts [r0-,r1-,r1+,r0+] in tangential frame; recover axis angle
  const mid = keyway.pts
    .reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0])
    .map((v) => v / keyway.pts.length);
  const keyAng = Math.atan2(mid[1], mid[0]);
  const p1 = keyway.pts[1]; // outer corner, -t side
  const p2 = keyway.pts[2]; // outer corner, +t side
  const hw = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 2;
  const phi = Math.asin(Math.min(0.99, hw / rb));
  const start = keyAng + phi;
  const end = keyAng - phi + TAU;
  emit.move(rb * Math.cos(start), rb * Math.sin(start));
  emit.arc(0, 0, rb, start, end, true); // long way around, CCW
  emit.line(p1[0], p1[1]);
  emit.line(p2[0], p2[1]);
  emit.line(rb * Math.cos(start), rb * Math.sin(start));
}

// ---------------------------------------------------------------------------
// True piece cross-section
// ---------------------------------------------------------------------------
// The planner's sector outline deliberately overshoots the bore: the wedge
// tip reaches rInner (inside the bore) and the KCL bore/keyway cutters trim
// it back (see wheel.js). Handing those cutters to a triangulator as holes
// breaks once a hole loop crosses the outline — ExtrudeGeometry grows side
// walls along the whole loop, which shows up as a phantom thin-walled
// cylinder at every piece tip. The real part (KCL subtract) has no such
// walls, so the preview must not either: every bore-family region is
// star-shaped around the piece origin, so within the sector its true inner
// boundary is the polar curve ρ(θ) = furthest bore boundary along the ray θ.
// We fold that curve straight into the outline and drop the bore cutters
// from the hole list. One-piece wheels keep the bore as a genuine interior
// hole — there it never crosses the outline. Segmented bolt/plain hubs skip
// the overshoot entirely (their concentric bore arc IS the outline, no bore
// cutter emitted), so they take the empty-bore-family fast path below.

const cross2 = (a, b) => a[0] * b[1] - a[1] * b[0];

// Furthest intersection of the ray s·u (s > 0) with a polygon (0 = miss).
function rayPolyExtent(u, pts) {
  let best = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const d = [q[0] - p[0], q[1] - p[1]];
    const denom = cross2(u, d);
    if (Math.abs(denom) < 1e-12) continue;
    const s = cross2(p, d) / denom;
    const t = -cross2(u, p) / denom;
    if (s > best && t >= -1e-9 && t <= 1 + 1e-9) best = s;
  }
  return best;
}

// Boundary distance along u of a D-bore region (major arc + flat chord):
// circle ∩ half-plane, i.e. the nearer of the arc radius and the flat's
// line when the ray faces the flat.
function rayDboreExtent(u, segs) {
  let r = 0;
  let flat = null;
  for (const s of segs) {
    if (s.kind === 'arc') r = s.radius;
    else flat = s;
  }
  if (flat) {
    const d = [flat.b[0] - flat.a[0], flat.b[1] - flat.a[1]];
    const dd = d[0] * d[0] + d[1] * d[1] || 1;
    const t = -(flat.a[0] * d[0] + flat.a[1] * d[1]) / dd;
    const foot = [flat.a[0] + t * d[0], flat.a[1] + t * d[1]]; // ⊥ from origin
    const off = Math.hypot(foot[0], foot[1]) || 1;
    const cos = (u[0] * foot[0] + u[1] * foot[1]) / off;
    if (cos > 1e-6) r = Math.min(r, off / cos);
  }
  return r;
}

// ρ(θ): furthest bore-family boundary along the ray θ (piece frame; bore
// circles are always centered on the piece origin).
function boreRho(boreFamily) {
  return (theta) => {
    const u = [Math.cos(theta), Math.sin(theta)];
    let rho = 0;
    for (const c of boreFamily) {
      if (c.shape === 'circle') rho = Math.max(rho, c.r);
      else if (c.shape === 'poly') rho = Math.max(rho, rayPolyExtent(u, c.pts));
      else if (c.shape === 'path') rho = Math.max(rho, rayDboreExtent(u, c.segs));
    }
    return rho;
  };
}

// Trace the true profile of a piece: the planner outline with the bore
// region folded into the inner boundary. Returns true when the bore family
// was consumed by the outline; false when the caller must render it as
// interior holes instead (one-piece wheels).
export function tracePieceProfile(plan, unique, emit, section = plan.outline) {
  // One-piece wheels: the boundary is the whole rim, either a plain circle or
  // a ring with the tread bars notched into it, and the bore never crosses it.
  if (section.kind === 'circle') {
    emit.move(section.r, 0);
    emit.arc(0, 0, section.r, 0, TAU, true);
    return false;
  }
  if (section.kind === 'ring') {
    traceSegs(section.segs, emit);
    return false;
  }
  const { boreFamily } = classifyCutters(unique.cutters);
  if (!boreFamily.length) {
    traceSegs(section.segs, emit);
    return true;
  }
  const rho = boreRho(boreFamily);
  const rMin = plan.radii.rInner; // safety floor; ρ ≥ boreMinR > rInner
  const A = d2r(plan.segAngle);
  const src = section.segs;
  // All but the planner's inner arc, with the two face ends pulled out of
  // the bore onto ρ. The stitch points always land on the innermost
  // straight face segments (bore < first dovetail).
  const segs = src.slice(0, -1).map((s) => ({ ...s }));
  segs[0].a = [Math.max(rho(0), rMin), 0];
  const rA = Math.max(rho(A), rMin);
  let prev = [rA * Math.cos(A), rA * Math.sin(A)];
  segs[segs.length - 1].b = prev;
  // Inner boundary: ρ(θ) sampled walking back from face A to face 0.
  const steps = Math.max(64, Math.ceil(plan.segAngle / 0.25));
  for (let i = 1; i <= steps; i++) {
    const th = A * (1 - i / steps);
    const r = Math.max(rho(th), rMin);
    const p = [r * Math.cos(th), r * Math.sin(th)];
    segs.push({ kind: 'line', a: prev, b: p });
    prev = p;
  }
  traceSegs(segs, emit);
  return true;
}

// Hole tracers for the bore family when it stays a real hole (N = 1).
function boreHoleTracers(boreFamily) {
  const boreCircle = boreFamily.find((c) => c.shape === 'circle' && c.id === 'bore');
  const keyway = boreFamily.find((c) => c.id === 'keyway');
  if (boreCircle) return [(e) => traceKeyedBore(boreCircle, keyway, e)];
  return boreFamily.map((c) => (e) => traceCutter(c, e));
}

// Adapter: our emit interface onto a THREE.Shape / THREE.Path.
export function shapeEmitter(target) {
  return {
    move: (x, y) => target.moveTo(x, y),
    line: (x, y) => target.lineTo(x, y),
    arc: (cx, cy, r, a0, a1, ccw) => target.absarc(cx, cy, r, a0, a1, !ccw),
  };
}

// Every loop that bounds material in a section: the piece boundary first,
// then the interior holes. `consumed` says whether the bore was folded into
// the boundary (segmented pieces) or is still one of the holes (one-piece).
function pieceLoops(plan, unique, section) {
  const { boreFamily, holes } = classifyCutters(unique.cutters);
  let consumed = false;
  const outer = (emit) => {
    consumed = tracePieceProfile(plan, unique, emit, section);
  };
  const inner = [];
  const probe = { move() {}, line() {}, arc() {} };
  outer(probe); // resolve `consumed` before deciding what the holes are
  if (!consumed && boreFamily.length) inner.push(...boreHoleTracers(boreFamily));
  for (const h of holes) inner.push((e) => traceCutter(h, e));
  return { outer, inner };
}

// Full 2D profile (outline + interior holes) of a piece as a THREE.Shape —
// shared by the 3D renderer and the geometry tests. Defaults to the widest
// section, which is the piece's silhouette.
export function buildPieceShape(THREE, plan, unique, section = plan.outline) {
  const shape = new THREE.Shape();
  const { outer, inner } = pieceLoops(plan, unique, section);
  outer(shapeEmitter(shape));
  for (const fn of inner) {
    const p = new THREE.Path();
    fn(shapeEmitter(p));
    shape.holes.push(p);
  }
  return shape;
}

// --- crowned pieces --------------------------------------------------------
// A crowned piece is lofted in the CAD (see kclgen.js), so the preview lofts
// it too rather than pretending it is a cylinder. Every section is built from
// the same segment structure by construction, so sampling each of them with a
// fixed number of points per segment gives matching rings that stitch
// straight into quad strips. Holes are identical at every height, so their
// walls come out vertical exactly as the CAD builds them.
const ARC_STEPS = 18;

function polylineEmitter(out) {
  return {
    move: (x, y) => out.push([x, y]),
    line: (x, y) => out.push([x, y]),
    arc: (cx, cy, r, a0, a1) => {
      for (let i = 1; i <= ARC_STEPS; i++) {
        const a = a0 + (a1 - a0) * (i / ARC_STEPS);
        out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
      }
    },
  };
}

// Closing the loop lands the last sample back on the first; drop it so the
// stitched quads are never degenerate. Every section samples the same way, so
// this keeps them the same length.
const sampleLoop = (fn) => {
  const pts = [];
  fn(polylineEmitter(pts));
  while (pts.length > 3 && Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) < 1e-7) pts.pop();
  return pts;
};

const signedArea = (pts) => {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
};

// Returns a BufferGeometry, or null when the sections did not sample to
// matching rings — the caller then falls back to a plain extrusion rather
// than drawing something torn.
export function buildLoftGeometry(THREE, plan, unique) {
  const rings = [];
  let inner = null;
  for (const sec of plan.sections) {
    const parts = pieceLoops(plan, unique, sec);
    if (!inner) inner = parts.inner.map(sampleLoop);
    rings.push(sampleLoop(parts.outer));
  }
  if (rings.length < 2 || rings.some((r) => r.length !== rings[0].length || r.length < 3)) return null;

  const loops = [rings[0], ...inner]; // shapes/offsets are the same at every z
  const offsets = [];
  let total = 0;
  for (const l of loops) {
    offsets.push(total);
    total += l.length;
  }
  const K = plan.sections.length;
  const pos = new Float32Array(total * K * 3);
  for (let i = 0; i < K; i++) {
    const z = plan.sections[i].z;
    const ring = [rings[i], ...inner];
    let v = i * total;
    for (const l of ring) {
      for (const [x, y] of l) {
        pos[v * 3] = x;
        pos[v * 3 + 1] = y;
        pos[v * 3 + 2] = z;
        v++;
      }
    }
  }

  const idx = [];
  // Side walls, one quad strip per loop per gap. Winding follows each loop's
  // own orientation so the outer skin and the hole walls both face outwards.
  loops.forEach((l, li) => {
    const flip = signedArea(l) < 0;
    for (let i = 0; i < K - 1; i++) {
      for (let j = 0; j < l.length; j++) {
        const j2 = (j + 1) % l.length;
        const a = i * total + offsets[li] + j;
        const b = i * total + offsets[li] + j2;
        const c = (i + 1) * total + offsets[li] + j2;
        const d = (i + 1) * total + offsets[li] + j;
        if (flip) idx.push(a, c, b, a, d, c);
        else idx.push(a, b, c, a, c, d);
      }
    }
  });
  // Caps. Each end is triangulated from its own ring: an angled tread rotates
  // the notches from section to section, so one end's triangulation laid over
  // the other's points would fold triangles inside out along the bars.
  const holeVecs = inner.map((l) => l.map(([x, y]) => new THREE.Vector2(x, y)));
  const ccw = signedArea(rings[0]) > 0;
  for (const end of [0, K - 1]) {
    const base = end * total;
    const contour = rings[end].map(([x, y]) => new THREE.Vector2(x, y));
    const down = end === 0; // the z = 0 cap faces −Z, the far one +Z
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, holeVecs)) {
      if (down === ccw) idx.push(base + a, base + c, base + b);
      else idx.push(base + a, base + b, base + c);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export async function createPreview(canvas) {
  try {
    const [T, { OrbitControls }] = await Promise.all([
      import('three'),
      import('three/addons/controls/OrbitControls.js'),
    ]);
    return create3D(canvas, { T, OrbitControls });
  } catch (e) {
    console.warn('3D preview unavailable, using 2D fallback:', e);
    return create2D(canvas);
  }
}

// ---------------------------------------------------------------------------
// three.js renderer
// ---------------------------------------------------------------------------
function create3D(canvas, { T: THREE, OrbitControls }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 1, 20000);
  camera.up.set(0, 0, 1);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x141824, 1.15));
  const dir = new THREE.DirectionalLight(0xffffff, 1.6);
  dir.position.set(1, -1.2, 2.2);
  scene.add(dir);
  const dir2 = new THREE.DirectionalLight(0x88aaff, 0.5);
  dir2.position.set(-1.5, 1, -0.6);
  scene.add(dir2);

  const root = new THREE.Group();
  scene.add(root);

  const PIECE_COLORS = [0x5f7db5, 0x49618f, 0x71a0d6, 0x54739f, 0x3e547f, 0x86aede, 0x4a6ea8, 0x62759c];
  const DARK = 0x10141d;

  let state = { plan: null, explode: 0.18, fitView: false, R: 100 };
  let groups = [];

  function buildPieceGeometry(plan, unique) {
    const { grooves } = classifyCutters(unique.cutters);
    // Crowned pieces are lofted; flat ones extrude, which is cheaper and
    // gives the arcs a finer tessellation.
    const geo =
      (plan.sections.length > 1 ? buildLoftGeometry(THREE, plan, unique) : null) ||
      new THREE.ExtrudeGeometry(buildPieceShape(THREE, plan, unique), {
        depth: plan.W,
        bevelEnabled: false,
        curveSegments: 48,
      });
    return { geo, grooves };
  }

  function rebuild() {
    for (const g of groups) root.remove(g);
    groups = [];
    root.clear();
    const plan = state.plan;
    if (!plan) return;
    state.R = plan.radii.R;

    const geoByLabel = new Map();
    for (const u of plan.uniquePieces) geoByLabel.set(u.label, buildPieceGeometry(plan, u));

    const segRad = d2r(plan.segAngle);
    if (!state.fitView) {
      for (const piece of plan.pieces) {
        const { geo, grooves } = geoByLabel.get(piece.label);
        const mat = new THREE.MeshStandardMaterial({
          color: PIECE_COLORS[piece.k % PIECE_COLORS.length],
          roughness: 0.55,
          metalness: 0.15,
        });
        const g = new THREE.Group();
        g.add(new THREE.Mesh(geo, mat));
        // Circumferential grooves are the only cut the mesh does not already
        // carry (tread bars are notches in the profile now), so they stay an
        // overlay — the KCL subtracts them for real.
        const darkMat = new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.9 });
        for (const gr of grooves) {
          const rIn = gr.rIn ?? plan.radii.R - plan.radii.treadEff;
          const ring = new THREE.Mesh(
            new THREE.TorusGeometry((rIn + plan.radii.R) / 2, (gr.z1 - gr.z0) / 2, 8, 64, plan.N === 1 ? TAU : segRad),
            darkMat
          );
          ring.position.z = (gr.z0 + gr.z1) / 2;
          g.add(ring);
        }
        g.userData.k = piece.k;
        g.rotation.z = piece.k * segRad;
        root.add(g);
        groups.push(g);
      }
      applyExplode();
    } else {
      // Printer-fit view: one piece, print-oriented, inside the usable volume.
      const { geo } = geoByLabel.get(plan.uniquePieces[0].label);
      const mat = new THREE.MeshStandardMaterial({ color: PIECE_COLORS[0], roughness: 0.55, metalness: 0.15 });
      const mesh = new THREE.Mesh(geo, mat);
      const g = new THREE.Group();
      g.add(mesh);
      g.rotation.z = d2r(plan.bbox.rotForPrint);
      // center the rotated piece
      const bb = new THREE.Box3().setFromObject(g);
      const c = bb.getCenter(new THREE.Vector3());
      g.position.set(-c.x, -c.y, 0);
      root.add(g);
      const u = plan.fit.usable;
      const bed = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(u.x, u.y, u.z)),
        new THREE.LineBasicMaterial({ color: plan.fit.pieceFits ? 0x4ade80 : 0xf87171 })
      );
      bed.position.z = u.z / 2;
      root.add(bed);
      const grid = new THREE.GridHelper(Math.max(u.x, u.y) * 1.4, 14, 0x2a3347, 0x1c2333);
      grid.rotation.x = Math.PI / 2;
      root.add(grid);
    }
  }

  function applyExplode() {
    if (!state.plan || state.fitView) return;
    const segRad = d2r(state.plan.segAngle);
    for (const g of groups) {
      const mid = (g.userData.k + 0.5) * segRad;
      const dist = state.explode * state.R * 0.45;
      g.position.set(Math.cos(mid) * dist, Math.sin(mid) * dist, 0);
    }
  }

  function frameCamera() {
    const R = state.R * (1 + state.explode * 0.5);
    camera.position.set(R * 1.5, -R * 1.9, R * 1.7);
    controls.target.set(0, 0, state.plan ? state.plan.W / 2 : 0);
    camera.near = R / 100;
    camera.far = R * 30;
    camera.updateProjectionMatrix();
  }

  function resize() {
    const w = canvas.clientWidth || canvas.parentElement.clientWidth;
    const h = canvas.clientHeight || canvas.parentElement.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(canvas.parentElement);
  resize();

  let framed = false;
  (function loop() {
    requestAnimationFrame(loop);
    controls.update();
    renderer.render(scene, camera);
  })();

  return {
    mode: '3D',
    setPlan(plan) {
      const sizeChanged = !state.plan || Math.abs(plan.radii.R - state.R) / plan.radii.R > 0.25;
      state.plan = plan;
      rebuild();
      if (!framed || sizeChanged) {
        frameCamera();
        framed = true;
      }
    },
    setExplode(v) {
      state.explode = v;
      applyExplode();
    },
    setFitView(v) {
      state.fitView = v;
      rebuild();
      frameCamera();
    },
  };
}

// ---------------------------------------------------------------------------
// 2D fallback renderer (top view, same geometry)
// ---------------------------------------------------------------------------
function create2D(canvas) {
  const ctx = canvas.getContext('2d');
  let state = { plan: null, explode: 0.18, fitView: false };

  const PIECE_COLORS = ['#5f7db5', '#49618f', '#71a0d6', '#54739f', '#3e547f', '#86aede', '#4a6ea8', '#62759c'];

  function pathEmitter(p) {
    return {
      move: (x, y) => p.moveTo(x, y),
      line: (x, y) => p.lineTo(x, y),
      arc: (cx, cy, r, a0, a1, ccw) => p.arc(cx, cy, r, a0, a1, !ccw),
    };
  }

  function draw() {
    const plan = state.plan;
    const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
    const h = (canvas.height = canvas.clientHeight * devicePixelRatio);
    ctx.clearRect(0, 0, w, h);
    if (!plan) return;
    const R = plan.radii.R;
    const scale = (Math.min(w, h) / (2.6 * R)) * (1 / (1 + state.explode * 0.5));
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(scale, -scale);

    if (state.fitView) {
      const u = plan.fit.usable;
      ctx.strokeStyle = plan.fit.pieceFits ? '#4ade80' : '#f87171';
      ctx.lineWidth = 2 / scale;
      ctx.strokeRect(-u.x / 2, -u.y / 2, u.x, u.y);
    }

    for (const piece of plan.pieces) {
      if (state.fitView && piece.k > 0) continue;
      const u = plan.uniquePieces.find((q) => q.label === piece.label);
      ctx.save();
      if (state.fitView) {
        ctx.rotate(d2r(plan.bbox.rotForPrint));
        ctx.translate(0, -(plan.radii.rHub + R) / 2);
      } else {
        const mid = d2r((piece.k + 0.5) * plan.segAngle);
        const dist = state.explode * R * 0.45;
        ctx.translate(Math.cos(mid) * dist, Math.sin(mid) * dist);
        ctx.rotate(d2r(piece.k * plan.segAngle));
      }
      const outline = new Path2D();
      const boreConsumed = tracePieceProfile(plan, u, pathEmitter(outline));
      outline.closePath();
      ctx.fillStyle = PIECE_COLORS[piece.k % PIECE_COLORS.length];
      ctx.fill(outline);
      ctx.strokeStyle = '#9fb4dd';
      ctx.lineWidth = 1 / scale;
      ctx.stroke(outline);

      const { boreFamily, holes, grooves } = classifyCutters(u.cutters);
      const hp = new Path2D();
      if (!boreConsumed && boreFamily.length) for (const tr of boreHoleTracers(boreFamily)) tr(pathEmitter(hp));
      for (const c of holes) traceCutter(c, pathEmitter(hp));
      ctx.fillStyle = '#0d1117';
      ctx.fill(hp, 'evenodd');
      ctx.strokeStyle = '#10141d';
      for (const gr of grooves) {
        const rIn = gr.rIn ?? R - plan.radii.treadEff;
        ctx.lineWidth = Math.max(1 / scale, 1.2);
        ctx.beginPath();
        ctx.arc(0, 0, (rIn + R) / 2, 0, plan.N === 1 ? TAU : d2r(plan.segAngle));
        ctx.stroke();
      }
      ctx.restore();
    }
    ctx.restore();
  }

  new ResizeObserver(draw).observe(canvas.parentElement);

  return {
    mode: '2D fallback',
    setPlan(plan) {
      state.plan = plan;
      draw();
    },
    setExplode(v) {
      state.explode = v;
      draw();
    },
    setFitView(v) {
      state.fitView = v;
      draw();
    },
  };
}
