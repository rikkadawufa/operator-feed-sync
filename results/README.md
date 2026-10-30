# Results

Live run on 2026-10-30: n8n 2.44.7 in Docker, a real Airtable base, Slack alerts. Operators and listings are made up.

- `runs/R1.txt` to `runs/R8.txt`: the report each run wrote (`output/runs/<run>/report.txt`), as n8n printed it.
- `check-results.txt`: `python scripts/check_results.py` against `sample-data/scenarios.json`. 105 of 105 checks pass.

The sequence was replayed from an empty base several times that day to take screenshots at each step. Every replay gave the same counts; these files are from the last one.
