"""Compare what each run did with sample-data/scenarios.json.

Reads the workflow's own reports (output/runs/<run>/report.json) and the Airtable
snapshot taken after each run (output/snapshots/<run>.json). Prints one line per check
and exits 1 if any fail. Also checks that no Listing key appears twice in any snapshot.
"""
import argparse
import json
import sys

try:
    from .envfile import ROOT
except ImportError:
    from envfile import ROOT

SCENARIOS = json.loads((ROOT / "sample-data" / "scenarios.json").read_text(encoding="utf-8"))["steps"]


def check_step(step, out):
    results = []
    report_file = out / "runs" / step["run"] / "report.json"
    snap_file = out / "snapshots" / f"{step['run']}.json"
    if not report_file.exists() or not snap_file.exists():
        return [(False, f"{step['run']}: no report or snapshot (not run yet?)")]
    report = {s["source"]: s for s in json.loads(report_file.read_text(encoding="utf-8"))["sources"]}
    snapshot = json.loads(snap_file.read_text(encoding="utf-8"))
    by_key = {row["Listing key"]: row for row in snapshot}

    for source, wanted in step["expect"].items():
        if source == "listings":
            continue
        got = report.get(source)
        if not got:
            results.append((False, f"{step['run']} {source}: missing from report"))
            continue
        for name, value in wanted.items():
            actual = got["outcome"] if name == "outcome" else got["summary"].get(name)
            results.append((actual == value, f"{step['run']} {source} {name}: expected {value}, got {actual}"))

    listings = step["expect"].get("listings", {})
    if "total" in listings:
        results.append((len(snapshot) == listings["total"], f"{step['run']} listings total: expected {listings['total']}, got {len(snapshot)}"))
    for source, count in listings.get("countBySource", {}).items():
        actual = sum(1 for row in snapshot if row.get("Source") == source)
        results.append((actual == count, f"{step['run']} {source} listings: expected {count}, got {actual}"))
    for source, count in listings.get("activeBySource", {}).items():
        actual = sum(1 for row in snapshot if row.get("Source") == source and row.get("Status") == "Active")
        results.append((actual == count, f"{step['run']} {source} active listings: expected {count}, got {actual}"))
    for key, status in listings.get("status", {}).items():
        actual = by_key.get(key, {}).get("Status")
        results.append((actual == status, f"{step['run']} {key} status: expected {status}, got {actual}"))
    for key, fields in listings.get("fields", {}).items():
        for name, value in fields.items():
            actual = by_key.get(key, {}).get(name)
            results.append((actual == value, f"{step['run']} {key} {name}: expected {value}, got {actual}"))
    keys = [row["Listing key"] for row in snapshot]
    results.append((len(keys) == len(set(keys)), f"{step['run']} no duplicate listing keys ({len(keys)} rows, {len(set(keys))} unique)"))
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default="output", help="results folder, relative to the demo (default: output)")
    out = ROOT / parser.parse_args().out
    failed = 0
    total = 0
    for step in SCENARIOS:
        for ok, message in check_step(step, out):
            total += 1
            failed += not ok
            print(f"{'PASS' if ok else 'FAIL'}  {message}")
    print(f"\n{total - failed} of {total} checks passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
