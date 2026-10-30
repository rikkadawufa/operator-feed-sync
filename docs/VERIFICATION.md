# Verification

Run on 2026-10-30 with n8n 2.44.7 and the simulated feed server in local Docker. The target was a real Airtable base (Larkspur Spaces – Feed Sync Demo, free plan), and alerts went to a real Slack webhook. The operators, feeds and listings are all made up.

## How to run it

```
python scripts/run_scenarios.py --reset   # clear the demo base, then run R1 to R8 in order
python scripts/check_results.py           # compare with sample-data/scenarios.json
node --test n8n-src/code/*.test.js        # unit tests for the sync rules
```

## Results

- `check_results.py`: 105 of 105 checks pass. It checks the numbers in each run's n8n report and an Airtable snapshot read back after each run, and confirms in every run that no Listing key appears twice. Output: [results/check-results.txt](../results/check-results.txt).
- Unit tests: 13 of 13 pass.
- n8n event log: 42 executions of the feed sync workflow that day, all successful. The error workflow never fired. The sequence was run from an empty base several times to take screenshots at each step, and every pass gave the same counts.
- Slack alert node: 22 runs, all successful. Each complete pass through R3 to R5 sends 5 alerts (R3 Quayside's bad rows, R4 Northgate down plus Quayside, R5 removals held plus Quayside), and four passes make 20. The other 2 came from the first R1 attempt described under Fixes. The evidence is the n8n event log; there are no screenshots of Slack.

| Run | Situation | Northgate | Quayside | Pinecrest |
| --- | --- | --- | --- | --- |
| R1 | First sync | 12 created | 10 created | |
| R2 | Same feeds again | 12 unchanged | 10 unchanged | |
| R3 | Normal day | 1 created, 1 updated, 2 closed (rented, gone from the feed), 9 unchanged | 4 bad rows (3 refs) named, 7 unchanged, 0 closed | |
| R4 | Northgate answers HTTP 503 | Feed unavailable, nothing changed | Synced as usual | |
| R5 | Northgate sends 4 rows | 1 updated, 7 removals held (Pending removal), 0 closed | Synced as usual | |
| R6 | Full feed again | 7 restored, 1 reopened (NG-108, same record), 5 unchanged | Rows fixed, 10 unchanged | |
| R7a | New operator, first-draft mapping, dry run | | | All 6 rows flagged (wrong price path, decimal commas, unmapped "reserved") |
| R7b | Fixed mapping, dry run | | | 5 planned, 1 unit not available so not listed, 0 written |
| R7c | Go live | | | 5 created |
| R8 | Everything again | 13 unchanged | 10 unchanged | 5 unchanged |

After R8 the Listings table has 28 rows and no duplicates. Each run's report is in [results/runs/](../results/runs/).

## Fixes

- First R1 attempt: with the response format set to text, the n8n HTTP node puts the body in `data`, not `body`. Plan changes read an empty string, so the safety rule treated both feeds as empty and changed nothing for either operator. That was an unplanned check that an empty feed doesn't wipe listings. The code now reads `data` first and falls back to `body`, and R1 was run again.

## Not built or not tested

- No Sharetribe, Shopify or other marketplace API is connected. Airtable stands in for the client's listings platform.
- The schedule trigger is built but switched off. Every run in the demo was started through the webhook, and the workflow never ran on a schedule.
- Images: only the link is stored. Nothing is downloaded or uploaded to a platform.
- Pending removal has no release button. A person closes those listings in Airtable by hand.
- Reading from Airtable uses pagination, but each operator had at most 13 listings. Large feeds and 429 rate limits weren't tested. Writes are throttled to 4 per second and retried.
- If Airtable can't be read, the workflow stops and alerts, by design. That path wasn't triggered.
- An unreachable feed (DNS failure, timeout) takes the same Feed unavailable path. The live runs tested only HTTP 503; empty and cut-off XML were tested only in unit tests.
- No login protection and no deployment. Everything ran on localhost.
- A listing edited by hand in Airtable isn't overwritten until the feed changes that unit, because the sync compares against the hash it stored last time, not the current cell values.
- A single unit missing from a feed is closed in that run. There is no grace period (for example, missing two runs in a row); if the unit comes back, the same listing reopens.
- Two runs at the same time aren't prevented.
- If someone adds a duplicate Listing key in Airtable by hand, the upsert rejects the whole batch and the run stops with an alert. This wasn't triggered.
