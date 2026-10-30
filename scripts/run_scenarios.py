"""Run the demo days R1 to R8 against the local n8n and save what happened.

For each step: point the feed URLs at that day's files (or an outage), call the
workflow's webhook, save its report, then snapshot the Listings table.
  python scripts/run_scenarios.py --reset      # clear the demo base first, then run all
  python scripts/run_scenarios.py R3 R4        # run only some steps
Results land in output/runs/<run>/ and output/snapshots/<run>.json.
"""
import argparse
import json
import shutil
import urllib.request

try:
    from .airtable import TABLES, Airtable
    from .envfile import ROOT
except ImportError:
    from airtable import TABLES, Airtable
    from envfile import ROOT

WEBHOOK = "http://localhost:5681/webhook/feed-sync"
STATE = ROOT / "sample-data" / "feeds" / "state.json"
SCENARIOS = json.loads((ROOT / "sample-data" / "scenarios.json").read_text(encoding="utf-8"))["steps"]


def call_webhook(body):
    request = urllib.request.Request(WEBHOOK, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.loads(response.read())


def run_step(step, airtable):
    STATE.write_text(json.dumps(step["feeds"], indent=2), encoding="utf-8")
    draft = step.get("useDraft")
    live_config = ROOT / "sources" / f"{draft}.json" if draft else None
    backup = None
    if draft:
        # Simulates the team's first attempt at a mapping file; the committed file is the fixed one.
        backup = live_config.read_text(encoding="utf-8")
        shutil.copyfile(ROOT / "sample-data" / "onboarding" / f"{draft}.first-draft.json", live_config)
    try:
        report = call_webhook({"run": step["run"], "mode": step.get("mode", "live"), "sources": step["sources"]})
    finally:
        if backup is not None:
            live_config.write_text(backup, encoding="utf-8")
    out = ROOT / "output" / "runs" / step["run"]
    out.mkdir(parents=True, exist_ok=True)
    (out / "response.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    snapshot = sorted(({"id": r["id"], **r["fields"]} for r in airtable.records("Listings")), key=lambda r: r.get("Listing key", ""))
    snap_dir = ROOT / "output" / "snapshots"
    snap_dir.mkdir(parents=True, exist_ok=True)
    (snap_dir / f"{step['run']}.json").write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
    text = (out / "report.txt").read_text(encoding="utf-8") if (out / "report.txt").exists() else json.dumps(report)
    print(f"--- {step['run']}: {step['title']}\n{text}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("runs", nargs="*", help="step ids to run (default: all)")
    parser.add_argument("--reset", action="store_true", help="delete all rows in the demo base before running")
    args = parser.parse_args()
    airtable = Airtable()
    if args.reset:
        for table in TABLES:
            print(f"Cleared {airtable.clear(table)} rows from {table}")
        shutil.rmtree(ROOT / "output" / "runs", ignore_errors=True)
        shutil.rmtree(ROOT / "output" / "snapshots", ignore_errors=True)
    steps = [s for s in SCENARIOS if not args.runs or s["run"] in args.runs]
    for step in steps:
        run_step(step, airtable)


if __name__ == "__main__":
    main()
