"""Wheelwright — piece geometry to an OpenCascade B-rep solid.

This file is shipped verbatim inside every generated bundle and is the same
code the Wheelwright server runs, so what you download is exactly what the app
built. It needs OpenCascade's Python bindings and nothing else:

    pip install cadquery-ocp
    python build.py .

The whole vocabulary a generated `piece-*.py` speaks is small on purpose:

    section  {z, kind: sector|ring|circle, segs|r}   the piece boundary at height z
    seg      {kind: line|arc, a, b, center?, ccw?}   one entity of a closed loop
    cutter   {shape: circle|poly|path|annulus, z0, z1}  a prism to subtract

Every piece is then the same two steps — build a blank from the boundary,
subtract the cutters:

    blank = prism(section)            flat pieces, one section
          | loft(sections)            crowned / round pieces, several sections
    piece = blank - every cutter

That uniformity is the point. A previous backend had to fold full-depth cuts
into the sketch as extra loops and leave only partial-depth ones as booleans,
because on that engine boolean count was a cliff and any operand with a curved
face was refused outright. OpenCascade has neither limit: the busiest wheel in
the test matrix subtracts 35 tools from a lofted solid in about a second.
"""

import math

from OCP.BRep import BRep_Tool
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_MakeEdge,
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakeVertex,
    BRepBuilderAPI_MakeWire,
)
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepGProp import BRepGProp
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepOffsetAPI import BRepOffsetAPI_ThruSections
from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism
from OCP.GC import GC_MakeArcOfCircle
from OCP.GProp import GProp_GProps
from OCP.STEPControl import STEPControl_StepModelType, STEPControl_Writer
from OCP.StlAPI import StlAPI_Writer
from OCP.TopoDS import TopoDS
from OCP.TopTools import TopTools_ListOfShape
from OCP.gp import gp_Ax2, gp_Circ, gp_Dir, gp_Pln, gp_Pnt, gp_Vec

# Chord height allowed when the solid is triangulated for STL. Well under a
# printer's nozzle, and under the planner's own 1e-3 mm coordinate grid.
STL_DEFLECTION = 0.05
STL_ANGULAR = 0.3


# --------------------------------------------------------------- 2D primitives

def _pnt(xy, z=0.0):
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


def wire_from_segs(segs, z=0.0, ccw=True):
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
    verts = [BRepBuilderAPI_MakeVertex(_pnt(s["a"], z)).Vertex() for s in segs]
    mk = BRepBuilderAPI_MakeWire()
    for i, s in enumerate(segs):
        v0, v1 = verts[i], verts[(i + 1) % n]
        if s["kind"] == "line":
            mk.Add(BRepBuilderAPI_MakeEdge(v0, v1).Edge())
        else:
            c, r, t0, sweep = _arc_params(s)
            tm = t0 + sweep / 2.0
            mid = _pnt((c[0] + r * math.cos(tm), c[1] + r * math.sin(tm)), z)
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


def face_of(outer, holes=(), z=0.0):
    """A planar face at height z. `outer` arrives CCW and `holes` CW, so the
    material side is decided by the windings rather than by a repair pass."""
    mk = BRepBuilderAPI_MakeFace(gp_Pln(gp_Pnt(0, 0, z), gp_Dir(0, 0, 1)), outer)
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
    if shape == "annulus":
        return (wire_circle((0, 0), cut["rOut"], z, ccw),
                [wire_circle((0, 0), cut["rIn"], z, not ccw)])
    raise ValueError(f"unknown cutter shape {shape!r}")


def cutter_prism(cut, width):
    """One cutter as a solid prism.

    Every cutter is prismatic: the planner never varies a cut with height, only
    the piece's outer boundary. Cuts that run the full width overshoot the body
    by 1 mm at each end, because a tool face exactly coplanar with the body's
    is a classic way to make a boolean ambiguous.
    """
    through = cut["shape"] != "annulus" and cut["z0"] <= 0 and cut["z1"] >= width
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
        tools.Append(cutter_prism(cut, float(width)))
    op.SetArguments(args)
    op.SetTools(tools)
    op.SetRunParallel(True)
    op.Build()
    if not op.IsDone():
        raise RuntimeError("boolean subtract failed")
    return op.Shape()


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
    writer.Write(str(path))


def save(shape, stem, formats=("stl", "step"), out_dir="."):
    """Write one piece out, returning the paths written."""
    import os

    written = []
    for fmt in formats:
        path = os.path.join(out_dir, f"{stem}.{fmt}")
        (write_stl if fmt == "stl" else write_step)(shape, path)
        written.append(path)
    return written
