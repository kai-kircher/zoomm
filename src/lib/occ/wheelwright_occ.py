"""Wheelwright — piece geometry to an OpenCascade B-rep solid.

This file is shipped verbatim inside every generated bundle and is the same
code the Wheelwright server runs, so what you download is exactly what the app
built. It needs OpenCascade's Python bindings and nothing else:

    pip install cadquery-ocp
    python build.py .

The whole vocabulary a generated `piece-*.py` speaks is small on purpose:

    section  {z, kind: sector|ring|circle, segs|r}   the piece boundary at height z
    seg      {kind: line|arc, a, b, center?, ccw?}   one entity of a closed loop
    cutter   {shape: circle|poly|path, z0, z1}       a prism to subtract
             {shape: revolve, segs}                  a tool of revolution, its
                                                     loop drawn in (r, z)
    zone     {key, material, r0, r1, seam}           one body of a
                                                     multi-material piece

Every piece is then the same two steps — build a blank from the boundary,
subtract the cutters:

    blank = prism(section)            straight tread, one section
          | loft(sections)            slanted tread, several sections
    piece = blank - every cutter

and, when the piece is printed in more than one filament, a third: intersect
that solid with each zone's annulus to get one body per material. Neighbouring
bodies share their boundary cylinder exactly, so a slicer loading them as the
parts of one object finds no gap and no overlap between them.

The tire's running surface is one of those cutters: the crown and every
circumferential groove, as a single solid of revolution whose profile is an
exact arc of the section circle. Nothing about the curve is sampled.

That uniformity is the point. A previous backend had to fold full-depth cuts
into the sketch as extra loops and leave only partial-depth ones as booleans,
because on that engine boolean count was a cliff and any operand with a curved
face was refused outright — which is also why the crown had to be lofted rather
than cut, and why it came out visibly faceted. OpenCascade has neither limit.
"""

import math

from OCP.BRep import BRep_Tool
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common, BRepAlgoAPI_Cut
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_MakeEdge,
    BRepBuilderAPI_Transform,
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakeVertex,
    BRepBuilderAPI_MakeWire,
)
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepOffsetAPI import BRepOffsetAPI_ThruSections
from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism, BRepPrimAPI_MakeRevol
from OCP.GC import GC_MakeArcOfCircle
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_ReturnStatus
from OCP.STEPControl import STEPControl_StepModelType, STEPControl_Writer
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.StlAPI import StlAPI_Writer
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_ListOfShape
from OCP.gp import gp_Ax1, gp_Ax2, gp_Circ, gp_Dir, gp_Pln, gp_Pnt, gp_Trsf, gp_Vec

# Chord height allowed when the solid is triangulated for STL. Well under a
# printer's nozzle, and under the planner's own 1e-3 mm coordinate grid.
STL_DEFLECTION = 0.05
STL_ANGULAR = 0.3

# How near two things have to be before the boolean should treat them as
# touching. The planner rounds every coordinate to 1e-3 mm, so nothing finer
# than that is real, and left at its default the kernel goes hunting for
# intersections down at 1e-7 that the input never expressed — which is where
# it produces slivers. Two crowned wheels in the test matrix came out with
# zero-thickness fragments on a face and a handful of non-manifold edges in
# their STL; at 1e-3 both are clean, with the volume unchanged to the decimal.
# It is still a thousand times finer than the thinnest wall the planner will
# lay down, so nothing real can be merged away by it.
BOOLEAN_FUZZ = 1e-3


# --------------------------------------------------------------- 2D primitives

def _pnt(xy, z=0.0, plane="xy"):
    """Place a 2D loop point in space.

    A section or a prismatic cutter is drawn in an XY plane at height z. A
    revolved tool's profile is drawn in the (r, z) half-plane instead, which is
    the XZ plane at y = 0 — r becomes x, and the sweep is about Z.
    """
    if plane == "xz":
        return gp_Pnt(float(xy[0]), 0.0, float(xy[1]))
    return gp_Pnt(float(xy[0]), float(xy[1]), float(z))


def _arc_params(seg):
    """Centre, radius, start angle and signed sweep of an arc segment.

    The radius is the mean of the two endpoint distances. An arc is
    over-determined by start, end and centre, and the planner rounds all three
    independently to 1e-3 mm, so the two endpoints disagree about their own
    radius by up to about that (measured: 1.07e-3 mm across the test matrix).
    Averaging picks the circle that splits the difference rather than trusting
    whichever endpoint happened to be written first. Only the *midpoint* is
    derived from it — the endpoints themselves are never moved; see
    `wire_from_segs`.
    """
    a, b, c = seg["a"], seg["b"], seg["center"]
    r = (math.dist(a, c) + math.dist(b, c)) / 2.0
    t0 = math.atan2(a[1] - c[1], a[0] - c[0])
    t1 = math.atan2(b[1] - c[1], b[0] - c[0])
    if seg.get("ccw", True):
        sweep = (t1 - t0) % (2 * math.pi)
    else:
        sweep = -((t0 - t1) % (2 * math.pi))
    if abs(sweep) < 1e-12:  # a full circle drawn as one entity
        sweep = 2 * math.pi if seg.get("ccw", True) else -2 * math.pi
    return c, r, t0, sweep


def _polyline(segs, per_arc=12):
    """Dense polyline through a loop — arcs sampled, so the winding test below
    measures the real enclosed area rather than the chords' area."""
    pts = []
    for s in segs:
        if s["kind"] == "line":
            pts.append((s["a"][0], s["a"][1]))
        else:
            c, r, t0, sweep = _arc_params(s)
            for i in range(per_arc):
                t = t0 + sweep * i / per_arc
                pts.append((c[0] + r * math.cos(t), c[1] + r * math.sin(t)))
    return pts


def _signed_area(pts):
    n = len(pts)
    return 0.5 * sum(
        pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1]
        for i in range(n)
    )


def _oriented(wire, is_ccw, want_ccw):
    """Normalise a loop's winding.

    The planner walks some loops clockwise and some counter-clockwise, which is
    free to do because it hands both to a renderer. `BRepBuilderAPI_MakeFace`
    forgives it; `BRepOffsetAPI_ThruSections` does not — a section wire wound
    the wrong way lofts an inside-out solid whose only symptom is a negative
    volume. So every wire is normalised once, here.
    """
    return wire if is_ccw == want_ccw else TopoDS.Wire_s(wire.Reversed())


def wire_from_segs(segs, z=0.0, ccw=True, plane="xy"):
    """Close a {line, arc} loop into a wire, chaining through shared vertices.

    Consecutive entities in a plan loop share their endpoint *exactly* — the
    planner guarantees it and `wheel.test.js` pins it. The job here is not to
    repair that but to avoid destroying it, because the tempting repair is
    fatal: an arc's endpoints disagree with its own centre by ~1e-3 mm
    (`_arc_params`), and projecting them onto a mean radius to fix that — which
    is exactly what a KCL backend has to do, since that solver rejects an
    inconsistent arc — moves them off the neighbours they were sharing. The
    wire then comes back unclosed, and `MakeFace` answers with a degenerate
    sliver rather than an error: a Ø355.6 mm sector prism measures 7 901 mm³
    instead of 612 000.

    So endpoints are never moved. Each edge is built onto its predecessor's
    vertex, which keeps the loop closed by construction, and the arc's radius
    inconsistency is absorbed by fitting a circle through three points instead
    — start, midpoint, end — which needs no agreement between them at all.
    """
    segs = [s for s in segs
            if s["kind"] != "line" or math.dist(s["a"], s["b"]) >= 1e-9]
    n = len(segs)
    if n < 2:
        raise ValueError("a loop needs at least two entities")
    verts = [BRepBuilderAPI_MakeVertex(_pnt(s["a"], z, plane)).Vertex() for s in segs]
    mk = BRepBuilderAPI_MakeWire()
    for i, s in enumerate(segs):
        v0, v1 = verts[i], verts[(i + 1) % n]
        if s["kind"] == "line":
            mk.Add(BRepBuilderAPI_MakeEdge(v0, v1).Edge())
        else:
            c, r, t0, sweep = _arc_params(s)
            tm = t0 + sweep / 2.0
            mid = _pnt((c[0] + r * math.cos(tm), c[1] + r * math.sin(tm)), z, plane)
            curve = GC_MakeArcOfCircle(
                BRep_Tool.Pnt_s(v0), mid, BRep_Tool.Pnt_s(v1)
            ).Value()
            mk.Add(BRepBuilderAPI_MakeEdge(curve, v0, v1).Edge())
    wire = mk.Wire()
    if not wire.Closed():
        raise ValueError(f"loop of {n} entities did not close")
    return _oriented(wire, _signed_area(_polyline(segs)) > 0, ccw)


def wire_circle(center, radius, z=0.0, ccw=True):
    circ = gp_Circ(gp_Ax2(_pnt(center, z), gp_Dir(0, 0, 1)), float(radius))
    wire = BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(circ).Edge()).Wire()
    return _oriented(wire, True, ccw)  # a gp_Circ about +Z is CCW by construction


def wire_poly(pts, z=0.0, ccw=True):
    mk = BRepBuilderAPI_MakeWire()
    n = len(pts)
    verts = [BRepBuilderAPI_MakeVertex(_pnt(p, z)).Vertex() for p in pts]
    for i in range(n):
        if math.dist(pts[i], pts[(i + 1) % n]) < 1e-9:
            continue
        mk.Add(BRepBuilderAPI_MakeEdge(verts[i], verts[(i + 1) % n]).Edge())
    return _oriented(mk.Wire(), _signed_area([tuple(p) for p in pts]) > 0, ccw)


def face_of(outer, holes=(), z=0.0, plane="xy"):
    """A planar face at height z. `outer` arrives CCW and `holes` CW, so the
    material side is decided by the windings rather than by a repair pass."""
    pln = (gp_Pln(gp_Pnt(0, 0, 0), gp_Dir(0, -1, 0)) if plane == "xz"
           else gp_Pln(gp_Pnt(0, 0, z), gp_Dir(0, 0, 1)))
    mk = BRepBuilderAPI_MakeFace(pln, outer)
    for h in holes:
        mk.Add(h)
    return mk.Face()


# ------------------------------------------------------------------- the piece

def section_wire(sec):
    if sec["kind"] == "circle":
        return wire_circle((0, 0), sec["r"], sec["z"])
    return wire_from_segs(sec["segs"], sec["z"])


def cutter_wires(cut, z, ccw=True):
    """(outer, holes) for one cutter profile, drawn at height z."""
    shape = cut["shape"]
    if shape == "circle":
        return wire_circle(cut["c"], cut["r"], z, ccw), []
    if shape == "poly":
        return wire_poly(cut["pts"], z, ccw), []
    if shape == "path":
        return wire_from_segs(cut["segs"], z, ccw), []
    raise ValueError(f"unknown cutter shape {shape!r}")


def revolve_cutter(cut):
    """A tool of revolution — the tire's running surface.

    The profile is a closed loop in the (r, z) half-plane: up the finished
    surface (crown arcs, and a groove floor wherever one falls), then out past
    the rim and back. Swept a full turn about the wheel axis, it removes
    everything outside that surface. Because the crown is carried as a real arc
    rather than sampled at a few heights, the result is exact at any width —
    the lofted approximation it replaces was 2.99 mm off at the shoulder of a
    Ø200 round section, more than that tread was deep.

    The loop closes beyond both faces of the piece, so no face of the tool is
    ever coplanar with a face of the body. `seam` handles the same hazard in
    the other direction: a full revolution's seam is a real edge, and a
    boolean whose body has a planar face in that seam's plane silently does
    nothing at all — the planner picks an angle the piece has no radial face
    at, and the profile is turned to it before sweeping.
    """
    axis = gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1))
    face = face_of(wire_from_segs(cut["segs"], plane="xz"), (), plane="xz")
    seam = float(cut.get("seam", 0.0))
    if seam:
        turn = gp_Trsf()
        turn.SetRotation(axis, math.radians(seam))
        face = BRepBuilderAPI_Transform(face, turn, True).Shape()
    solid = BRepPrimAPI_MakeRevol(face, axis).Shape()
    # A revolve inherits its profile face's orientation, and which way round
    # that comes out depends on the plane's own axes rather than on anything
    # the planner controls. An inverted tool would add material instead of
    # removing it, and the only symptom is the sign of its volume.
    return solid if volume(solid) > 0 else solid.Reversed()


def cutter_solid(cut, width):
    """One cutter as a solid.

    Everything but the tire is prismatic: the planner never varies those cuts
    with height, only the piece's outer boundary. Cuts that run the full width
    overshoot the body by 1 mm at each end, because a tool face exactly
    coplanar with the body's is a classic way to make a boolean ambiguous.
    """
    if cut["shape"] == "revolve":
        return revolve_cutter(cut)
    through = cut["z0"] <= 0 and cut["z1"] >= width
    z0 = -1.0 if through else float(cut["z0"])
    z1 = width + 1.0 if through else float(cut["z1"])
    outer, holes = cutter_wires(cut, z0)
    return BRepPrimAPI_MakePrism(
        face_of(outer, holes, z0), gp_Vec(0, 0, z1 - z0)
    ).Shape()


def build(sections, cutters, width):
    """blank = prism | loft of the boundary;  piece = blank − every cutter."""
    if not sections:
        raise ValueError("a piece needs at least one section")

    if len(sections) == 1:
        sec = sections[0]
        blank = BRepPrimAPI_MakePrism(
            face_of(section_wire(sec), (), sec["z"]), gp_Vec(0, 0, float(width))
        ).Shape()
    else:
        # Ruled, not smoothed: the planner spaces its sections so that straight
        # segments between them are the intended surface, and a smoothed loft
        # would bulge the tread between bar rows.
        lofter = BRepOffsetAPI_ThruSections(True, True, 1e-6)
        for sec in sections:
            lofter.AddWire(section_wire(sec))
        lofter.Build()
        if not lofter.IsDone():
            raise RuntimeError("loft failed")
        blank = lofter.Shape()

    if not cutters:
        return blank

    # One boolean with every tool, not one boolean per tool: OpenCascade fuses
    # the tool list once and cuts in a single pass, which is both faster and
    # less prone to leaving a sliver behind between neighbouring cuts.
    op = BRepAlgoAPI_Cut()
    args, tools = TopTools_ListOfShape(), TopTools_ListOfShape()
    args.Append(blank)
    for cut in cutters:
        tools.Append(cutter_solid(cut, float(width)))
    op.SetArguments(args)
    op.SetTools(tools)
    op.SetRunParallel(True)
    op.SetFuzzyValue(BOOLEAN_FUZZ)
    op.Build()
    if not op.IsDone():
        raise RuntimeError("boolean subtract failed")
    return _unify(op.Shape())


def _unify(shape):
    """Merge the redundant face splits a boolean leaves behind.

    Cutting a curved surface tends to hand it back as several faces on the same
    underlying geometry, and occasionally as two faces covering the *same*
    patch — which triangulates to duplicate triangles and an STL that is not a
    closed manifold. On the crowned Ø200 lugged wheel that showed up as two
    edges belonging to four triangles each.

    Merging faces that share a surface is a change of topology only, so nothing
    about the solid moves. It also leaves fewer faces to mesh and a smaller
    STEP file.
    """
    unify = ShapeUpgrade_UnifySameDomain(shape, True, True, False)
    unify.Build()
    return unify.Shape()



# ------------------------------------------------------------- material zones

def zone_tool(zone, width):
    """The annulus that carves one material's body out of a finished piece.

    A prism of the ring [r0, r1], run past both faces of the piece so that no
    face of the tool is ever coplanar with a face of the body. r0 = 0 makes it
    a plain disc — the innermost zone has no inner wall of its own; the bore is
    already cut, and asking a tool to re-cut a surface the body is bounded by
    is the one thing a boolean reliably gets wrong.

    `seam` moves the circle's seam edge off the piece's radial faces. A prism
    of a full circle carries the same kind of seam edge a revolution does, and
    a revolution's seam lying in the plane of a planar face of the body makes
    the boolean silently do nothing (see `revolve_cutter`). No prismatic tool
    here has been caught doing that — parking one on a sector's own face still
    split correctly when it was tried — so this is a precaution, and cheap.
    What actually proves each build is the volume check in `split_zones`.
    """
    z0, z1 = -1.0, float(width) + 1.0
    holes = []
    r0 = float(zone.get("r0", 0.0))
    if r0 > 1e-9:
        holes.append(wire_circle((0, 0), r0, z0, ccw=False))
    face = face_of(wire_circle((0, 0), float(zone["r1"]), z0), holes, z0)
    seam = float(zone.get("seam", 0.0))
    if seam:
        turn = gp_Trsf()
        turn.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), math.radians(seam))
        face = BRepBuilderAPI_Transform(face, turn, True).Shape()
    return BRepPrimAPI_MakePrism(face, gp_Vec(0, 0, z1 - z0)).Shape()


def split_zones(shape, zones, width):
    """One (zone, solid) per material, from one finished piece.

    The zones tile the piece: they are consecutive rings that start at the axis
    and end past the tread, and neighbours share their boundary cylinder
    exactly. So the bodies must add back up to what they came from, and this
    checks that they do — because the ways this operation fails are quiet ones.
    A tool whose seam lies in the plane of one of the piece's radial faces can
    leave the intersection returning the *whole* body; a tool that misses can
    return nothing. Both hand back a valid, watertight, wheel-shaped solid, and
    both show up immediately in the sum.
    """
    total = volume(shape)
    bodies, accounted = [], 0.0
    for zone in zones:
        op = BRepAlgoAPI_Common()
        args, tools = TopTools_ListOfShape(), TopTools_ListOfShape()
        args.Append(shape)
        tools.Append(zone_tool(zone, width))
        op.SetArguments(args)
        op.SetTools(tools)
        op.SetRunParallel(True)
        op.SetFuzzyValue(BOOLEAN_FUZZ)
        op.Build()
        if not op.IsDone():
            raise RuntimeError(f"zone {zone['key']!r}: intersection failed")
        body = _unify(op.Shape())
        vol = volume(body)
        if vol <= 0:
            raise RuntimeError(
                f"zone {zone['key']!r} ({zone['r0']}-{zone['r1']} mm) came out empty"
            )
        accounted += vol
        bodies.append((zone, body))

    slack = max(1.0, 1e-4 * total)
    if abs(accounted - total) > slack:
        raise RuntimeError(
            f"material zones do not add up to the piece: {accounted:.1f} mm^3 across "
            f"{len(bodies)} bodies against {total:.1f} mm^3 whole "
            f"({accounted - total:+.1f}). The split is wrong, not merely imprecise."
        )
    return bodies


def zone_stem(stem, zone):
    """File stem for one body: which piece, which zone, which spool."""
    return f"{stem}-{zone['key']}-{zone['material']}"


def save_zones(shape, zones, width, stem, formats=("stl", "step"), out_dir="."):
    """Split a piece into its material bodies and write every one."""
    written = []
    for zone, body in split_zones(shape, zones, width):
        written += save(body, zone_stem(stem, zone), formats, out_dir)
    return written


# ------------------------------------------------------------------- reporting

def volume(shape):
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, props)
    return props.Mass()


def is_valid(shape):
    return BRepCheck_Analyzer(shape).IsValid()


def write_stl(shape, path, deflection=STL_DEFLECTION, angular=STL_ANGULAR):
    BRepMesh_IncrementalMesh(shape, deflection, False, angular, True)
    writer = StlAPI_Writer()
    writer.ASCIIMode = False
    if not writer.Write(shape, str(path)):
        raise RuntimeError(f"could not write {path}")


def write_step(shape, path):
    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_StepModelType.STEPControl_AsIs)
    # Write() reports failure in its return status rather than raising, so an
    # unchecked call turns a STEP that was never written into a piece that is
    # simply missing from the export.
    if writer.Write(str(path)) != IFSelect_ReturnStatus.IFSelect_RetDone:
        raise RuntimeError(f"could not write {path}")


# The formats `save` knows how to write. EXPORT_FORMATS in src/lib/occ.js is the
# other half of this; keep the two in step.
WRITERS = {"stl": write_stl, "step": write_step}


def save(shape, stem, formats=("stl", "step"), out_dir="."):
    """Write one piece out, returning the paths written."""
    import os

    written = []
    for fmt in formats:
        if fmt not in WRITERS:
            raise ValueError(
                f"unknown export format {fmt!r} — known: {', '.join(WRITERS)}"
            )
        path = os.path.join(out_dir, f"{stem}.{fmt}")
        WRITERS[fmt](shape, path)
        written.append(path)
    return written
