# Results

Live run on 2026-10-30: n8n 2.44.7 in Docker, a real Airtable base, Slack alerts. Operators and listings are made up.

- `runs/R1.txt` to `runs/R8.txt`: the report each run wrote (`output/runs/<run>/report.txt`), as n8n printed it.
- `check-results.txt`: `python scripts/check_results.py` against `sample-data/scenarios.json`. 105 of 105 checks pass.

The sequence was replayed from an empty base several times that day to take screenshots at each step. Every replay gave the same counts; these files are from the last one.

Cloud workflow, 2026-11-01, and again on 2026-11-02 after the sync-rule changes: `workflows-cloud/` on the `n8n-cloudsim` container (n8n 2.44.7 with the default Code-node limits that n8n Cloud also has: no `require`, no `$env`, no files), same Airtable base and feeds. `check-results-cloudsim.txt`: 105 of 105 checks pass, and every run's report matches the self-hosted one exactly. A forced failure (unknown source) reached the error handler and Slack.

n8n Cloud, 2026-11-01: the same three workflows imported into an n8n Cloud trial instance (`<instance>.app.n8n.cloud`), Airtable credential and Slack URL filled in by hand. n8n Cloud can't reach a local feed server, so the feeds came from the test-feeds workflow (`workflows-cloud/test/`) reading the Test Feeds table (`run_scenarios.py --cloud --feeds-table`). `check-results-cloud.txt`: 105 of 105 checks pass; `runs-cloud/` has each run's report, identical to the self-hosted ones. Slack alerts in R3 to R5 went out (a failed alert would have stopped the run), and a forced failure (unknown source) ran the error handler successfully. This n8n Cloud run used the sync rules from before the 2026-11-02 changes (hold count, renumbering, HTML and ref-field checks); those changes were re-run on n8n-cloudsim and self-hosted n8n only, with the same counts.
