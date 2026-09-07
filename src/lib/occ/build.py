#!/usr/bin/env python3
"""Build every piece in a Wheelwright bundle into STL and STEP.

    python build.py .                    # this directory
    python build.py . --formats stl      # skip STEP
    python build.py . --json             # machine-readable summary on stdout

Each `piece-*.py` in the directory declares `W`, `SECTIONS` and `CUTTERS`; this
runner imports them and hands them to `wheelwright_occ.build`. The Wheelwright
server runs this exact script on the exact files it gives you, so a bundle you
download builds the same solids the app does.
"""

import argparse
import glob
import importlib.util
import json
import os
import sys
import time


def load_piece(path):
    """Import a generated piece module by path (the filenames have hyphens in
    them, so they are not importable by name)."""
    name = "wheelwright_piece_" + os.path.basename(path).replace("-", "_")[:-3]
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build a Wheelwright bundle.")
    ap.add_argument("directory", nargs="?", default=".",
                    help="bundle directory (default: the current one)")
    ap.add_argument("--formats", default="stl,step",
                    help="comma-separated: stl, step (default: both)")
    ap.add_argument("--out", default=None,
                    help="where to write (default: alongside the sources)")
    ap.add_argument("--json", action="store_true",
                    help="print a JSON summary instead of a human one")
    args = ap.parse_args(argv)

    src = os.path.abspath(args.directory)
    out = os.path.abspath(args.out) if args.out else src
    formats = [f.strip() for f in args.formats.split(",") if f.strip()]
    os.makedirs(out, exist_ok=True)

    # The generated pieces do `from wheelwright_occ import ...`, and that file
    # ships in the bundle beside them.
    sys.path.insert(0, src)
    import wheelwright_occ  # noqa: E402  (needs the path above)

    pieces = sorted(glob.glob(os.path.join(src, "piece-*.py")))
    if not pieces:
        print(f"No piece-*.py found in {src}", file=sys.stderr)
        return 2

    report, failed = [], 0
    for path in pieces:
        stem = os.path.basename(path)[:-3]
        started = time.time()
        try:
            mod = load_piece(path)
            shape = wheelwright_occ.build(mod.SECTIONS, mod.CUTTERS, mod.W)
            written = wheelwright_occ.save(shape, stem, formats, out)
            entry = {
                "piece": stem,
                "ok": True,
                "seconds": round(time.time() - started, 2),
                "volumeMm3": round(wheelwright_occ.volume(shape), 1),
                "valid": wheelwright_occ.is_valid(shape),
                "files": [os.path.basename(w) for w in written],
            }
        except Exception as exc:  # a bad piece must not lose the good ones
            failed += 1
            entry = {
                "piece": stem,
                "ok": False,
                "seconds": round(time.time() - started, 2),
                "error": f"{type(exc).__name__}: {exc}",
            }
        report.append(entry)
        if not args.json:
            if entry["ok"]:
                flag = "" if entry["valid"] else "  (WARNING: invalid B-rep)"
                print(f"  {stem:16s} {entry['seconds']:5.2f}s  "
                      f"{entry['volumeMm3']:11.1f} mm^3  "
                      f"{', '.join(entry['files'])}{flag}")
            else:
                print(f"  {stem:16s} FAILED  {entry['error']}", file=sys.stderr)

    if args.json:
        json.dump({"ok": failed == 0, "pieces": report}, sys.stdout)
        sys.stdout.write("\n")
    elif failed:
        print(f"\n{failed} of {len(pieces)} pieces failed.", file=sys.stderr)
    else:
        print(f"\n{len(pieces)} piece(s) built into {out}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
