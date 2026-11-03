"""Live checks for the optional feed settings: auth, SFTP, Google Sheets links and price markup.

Every check is a dry run, so the Listings table is never written (each run still logs one
row in Sync Runs). Each check adds a temporary mapping (a copy of Quayside with one setting
changed), points the demo feed server at Quayside's day-1 file, runs it and compares the
workflow's report with what should happen.
  python scripts/run_extras.py                     # self-hosted n8n on localhost:5681
  python scripts/run_extras.py --cloud --webhook http://localhost:5682/webhook/feed-sync
The Google Sheets check reads Google's public sample sheet, so it needs internet access.
"""
import argparse
import json
import sys

try:
    from .airtable import Airtable
    from .envfile import ROOT
    from .run_scenarios import LOCAL_WEBHOOK, STATE, call_webhook
except ImportError:
    from airtable import Airtable
    from envfile import ROOT
    from run_scenarios import LOCAL_WEBHOOK, STATE, call_webhook

QUAYSIDE = json.loads((ROOT / "sources" / "quayside.json").read_text(encoding="utf-8"))
DAY1 = {"file": "day1/quayside.csv"}
# Google's public sample sheet (used in the Sheets API quickstart). Its columns aren't storage
# units, so every row fails the mapping; the check is that n8n follows Google's redirect and reads it.
GOOGLE_SAMPLE = "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=0"


def mapping(source_id, **changes):
    return {**QUAYSIDE, "id": source_id, "name": f"Check {source_id}", "enabled": False, "url": f"http://feeds:8080/feeds/{source_id}", **changes}


SHEET = {**QUAYSIDE, "url": GOOGLE_SAMPLE, "fields": {**QUAYSIDE["fields"], "external_ref": "Student Name", "title": "Student Name", "unit_type": "Class Level"}}

# (mapping, what the feed server answers, expected report fields)
CHECKS = [
    (mapping("x-header", auth={"type": "header", "name": "X-API-Key", "secret": "DEMO_KEY"}),
     {**DAY1, "auth": {"header": "X-API-Key", "value": "demo-key-123"}}, {"outcome": "OK", "created": 10}),
    (mapping("x-bearer", auth={"type": "bearer", "secret": "DEMO_KEY"}),
     {**DAY1, "auth": {"bearer": "demo-key-123"}}, {"outcome": "OK", "created": 10}),
    (mapping("x-basic", auth={"type": "basic", "user": "larkspur", "secret": "DEMO_PASSWORD"}),
     {**DAY1, "auth": {"basic": "larkspur:demo-pass-456"}}, {"outcome": "OK", "created": 10}),
    (mapping("x-query", auth={"type": "query", "name": "api_key", "secret": "DEMO_KEY"}),
     {**DAY1, "auth": {"query": "api_key", "value": "demo-key-123"}}, {"outcome": "OK", "created": 10}),
    (mapping("x-wrong-key", auth={"type": "header", "name": "X-API-Key", "secret": "DEMO_PASSWORD"}),
     {**DAY1, "auth": {"header": "X-API-Key", "value": "demo-key-123"}}, {"outcome": "Feed unavailable", "note": "HTTP 401", "hidden": "demo-pass-456"}),
    (mapping("x-no-secret", auth={"type": "header", "name": "X-API-Key", "secret": "NOT_SET_ANYWHERE"}),
     {**DAY1, "auth": {"header": "X-API-Key", "value": "demo-key-123"}}, {"outcome": "Feed unavailable", "note": "NOT_SET_ANYWHERE is not set"}),
    (mapping("x-markup", markup={"percent": 25, "round": "99"}), DAY1, {"outcome": "OK", "created": 10, "price": {"Q-05": 147.99}}),
    ({**{k: v for k, v in QUAYSIDE.items() if k != "url"}, "id": "x-sftp", "name": "Check x-sftp", "enabled": False, "transport": "sftp", "path": "/feeds/day1/quayside.csv"},
     None, {"outcome": "OK", "created": 10}),
    ({**{k: v for k, v in QUAYSIDE.items() if k != "url"}, "id": "x-sftp-missing", "name": "Check x-sftp-missing", "enabled": False, "transport": "sftp", "path": "/feeds/day1/not-there.csv"},
     None, {"outcome": "Feed unavailable"}),
    ({**SHEET, "id": "x-sheet", "name": "Check x-sheet", "enabled": False}, None, {"outcomeNot": "Feed unavailable", "feedRowsAtLeast": 20}),
]


def check(report, wanted, plan_file):
    results = []
    summary = report["summary"]
    notes = " ".join(report["notes"])
    if "outcome" in wanted:
        results.append((report["outcome"] == wanted["outcome"], f"outcome {report['outcome']!r}, expected {wanted['outcome']!r}"))
    if "outcomeNot" in wanted:
        results.append((report["outcome"] != wanted["outcomeNot"], f"outcome {report['outcome']!r}, must not be {wanted['outcomeNot']!r}"))
    if "created" in wanted:
        results.append((summary["created"] == wanted["created"], f"created {summary['created']}, expected {wanted['created']}"))
    if "feedRowsAtLeast" in wanted:
        results.append((summary["feedRows"] >= wanted["feedRowsAtLeast"], f"read {summary['feedRows']} rows, expected at least {wanted['feedRowsAtLeast']}"))
    if "note" in wanted:
        results.append((wanted["note"] in notes, f"note mentions {wanted['note']!r}"))
    if "hidden" in wanted:
        results.append((wanted["hidden"] not in json.dumps(report), "secret value not in the report"))
    if "price" in wanted:
        if plan_file is None or not plan_file.exists():
            results.append((None, "price check needs the self-hosted plan file; skipped"))
        else:
            writes = {w["Listing key"].split(":", 1)[1]: w for w in json.loads(plan_file.read_text(encoding="utf-8"))["writes"]}
            for ref, price in wanted["price"].items():
                got = writes.get(ref, {}).get("Monthly price")
                results.append((got == price, f"{ref} monthly price {got}, expected {price}"))
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cloud", action="store_true", help="the Cloud workflow: mappings go through the Feed Sources table")
    parser.add_argument("--webhook", default=LOCAL_WEBHOOK)
    parser.add_argument("--run", default="X1", help="run id prefix (default: X1)")
    args = parser.parse_args()
    airtable = Airtable() if args.cloud else None
    STATE.write_text(json.dumps({m["id"]: served for m, served, _ in CHECKS if served}, indent=2), encoding="utf-8")
    failed = 0
    for source, _, wanted in CHECKS:
        run_id = f"{args.run}-{source['id']}"
        temp = ROOT / "sources" / f"{source['id']}.json"
        if args.cloud:
            fields = {k: v for k, v in source.items() if k not in ("id", "enabled")}
            airtable.upsert("Feed Sources", "Source", [{"Source": source["id"], "Enabled": False, "Mapping": json.dumps(fields, indent=2)}])
        else:
            temp.write_text(json.dumps(source, indent=2), encoding="utf-8")
        try:
            response = call_webhook(args.webhook, {"run": run_id, "mode": "dry run", "sources": [source["id"]]})
        finally:
            if args.cloud:
                airtable.delete_where("Feed Sources", f"{{Source}}='{source['id']}'")
            else:
                temp.unlink()
        report = response["sources"][0]
        plan_file = None if args.cloud else ROOT / "output" / "runs" / run_id / f"{source['id']}.json"
        for ok, text in check(report, wanted, plan_file):
            mark = "skip" if ok is None else ("ok  " if ok else "FAIL")
            failed += ok is False
            print(f"{mark} {source['id']}: {text}")
    print(f"\n{failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
