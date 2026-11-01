"""Run the demo days R1 to R8 against n8n and save what happened.

For each step: point the feed URLs at that day's files (or an outage), call the
workflow's webhook, save its report, then snapshot the Listings table.
  python scripts/run_scenarios.py --reset      # clear the demo base first, then run all
  python scripts/run_scenarios.py R3 R4        # run only some steps
Results land in output/runs/<run>/ and output/snapshots/<run>.json.

The Cloud version reads its mappings from the Feed Sources table instead of sources/,
so --cloud copies sources/*.json there before each step:
  python scripts/run_scenarios.py --reset --cloud --webhook https://<instance>/webhook/feed-sync \\
      --feeds-base https://<public feed server> --out output/cloud
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

LOCAL_WEBHOOK = "http://localhost:5681/webhook/feed-sync"
LOCAL_FEEDS = "http://feeds:8080"
STATE = ROOT / "sample-data" / "feeds" / "state.json"
SCENARIOS = json.loads((ROOT / "sample-data" / "scenarios.json").read_text(encoding="utf-8"))["steps"]


def call_webhook(webhook, body):
    request = urllib.request.Request(webhook, data=json.dumps(body).encode(), method="POST", headers={"Content-Type": "application/json", "User-Agent": "feed-sync-tests"})
    with urllib.request.urlopen(request, timeout=300) as response:
        return json.loads(response.read())


def push_sources(airtable, feeds_base, draft=None):
    """Write sources/*.json (or a step's first-draft mapping) into the Feed Sources table."""
    rows = []
    for path in sorted((ROOT / "sources").glob("*.json")):
        if draft and path.stem == draft:
            path = ROOT / "sample-data" / "onboarding" / f"{draft}.first-draft.json"
        mapping = json.loads(path.read_text(encoding="utf-8"))
        source_id = mapping.pop("id")
        enabled = mapping.pop("enabled", True)
        mapping["url"] = mapping["url"].replace(LOCAL_FEEDS, feeds_base)
        rows.append({"Source": source_id, "Enabled": enabled, "Mapping": json.dumps(mapping, indent=2)})
    airtable.upsert("Feed Sources", "Source", rows)


TYPES = {".xml": "application/xml", ".csv": "text/csv", ".json": "application/json"}


def push_test_feeds(airtable, feeds):
    """What each feed URL answers today, for the Cloud test-feeds workflow (same rules as feed-server/server.js)."""
    rows = []
    for source_id, entry in feeds.items():
        if entry.get("status", 200) != 200:
            rows.append({"Source": source_id, "Status": entry["status"], "Content type": "text/plain", "Body": "Service Unavailable"})
        else:
            path = ROOT / "sample-data" / "feeds" / entry["file"]
            rows.append({"Source": source_id, "Status": 200, "Content type": f"{TYPES.get(path.suffix, 'text/plain')}; charset=utf-8", "Body": path.read_text(encoding="utf-8")})
    airtable.upsert("Test Feeds", "Source", rows)


def run_step(step, airtable, args, out_root):
    STATE.write_text(json.dumps(step["feeds"], indent=2), encoding="utf-8")
    if args.feeds_table:
        push_test_feeds(airtable, step["feeds"])
    draft = step.get("useDraft")
    body = {"run": step["run"], "mode": step.get("mode", "live"), "sources": step["sources"]}
    out = out_root / "runs" / step["run"]
    out.mkdir(parents=True, exist_ok=True)
    if args.cloud:
        push_sources(airtable, args.feeds_base, draft)
        try:
            report = call_webhook(args.webhook, body)
        finally:
            if draft:
                push_sources(airtable, args.feeds_base)
        # The Cloud workflow can't write files, so the runner saves its report.
        text = report.pop("text", "")
        (out / "report.txt").write_text(text, encoding="utf-8")
        (out / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    else:
        live_config = ROOT / "sources" / f"{draft}.json" if draft else None
        backup = None
        if draft:
            # Simulates the team's first attempt at a mapping file; the committed file is the fixed one.
            backup = live_config.read_text(encoding="utf-8")
            shutil.copyfile(ROOT / "sample-data" / "onboarding" / f"{draft}.first-draft.json", live_config)
        try:
            report = call_webhook(args.webhook, body)
        finally:
            if backup is not None:
                live_config.write_text(backup, encoding="utf-8")
        # The self-hosted workflow writes its report to output/runs/; copy it when --out points elsewhere.
        written = ROOT / "output" / "runs" / step["run"]
        if written.resolve() != out.resolve():
            for name in ("report.txt", "report.json"):
                if (written / name).exists():
                    shutil.copyfile(written / name, out / name)
    (out / "response.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    snapshot = sorted(({"id": r["id"], **r["fields"]} for r in airtable.records("Listings")), key=lambda r: r.get("Listing key", ""))
    snap_dir = out_root / "snapshots"
    snap_dir.mkdir(parents=True, exist_ok=True)
    (snap_dir / f"{step['run']}.json").write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
    text = (out / "report.txt").read_text(encoding="utf-8") if (out / "report.txt").exists() else json.dumps(report)
    print(f"--- {step['run']}: {step['title']}\n{text}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("runs", nargs="*", help="step ids to run (default: all)")
    parser.add_argument("--reset", action="store_true", help="delete all rows in the demo base before running")
    parser.add_argument("--cloud", action="store_true", help="test the Cloud workflow: mappings go through the Feed Sources table")
    parser.add_argument("--webhook", default=LOCAL_WEBHOOK, help=f"workflow webhook (default: {LOCAL_WEBHOOK})")
    parser.add_argument("--feeds-base", default=LOCAL_FEEDS, help="feed server address n8n can reach (with --cloud)")
    parser.add_argument("--feeds-table", action="store_true", help="serve the feeds from the Test Feeds table (with --cloud, when n8n can't reach the local feed server)")
    parser.add_argument("--out", default="output", help="results folder, relative to the demo (default: output)")
    args = parser.parse_args()
    out_root = ROOT / args.out
    airtable = Airtable()
    if args.reset:
        for table in TABLES:
            print(f"Cleared {airtable.clear(table)} rows from {table}")
        shutil.rmtree(out_root / "runs", ignore_errors=True)
        shutil.rmtree(out_root / "snapshots", ignore_errors=True)
    steps = [s for s in SCENARIOS if not args.runs or s["run"] in args.runs]
    for step in steps:
        run_step(step, airtable, args, out_root)


if __name__ == "__main__":
    main()
