# Operator Feed Sync (n8n + Airtable)

Self-initiated portfolio project. The marketplace (Larkspur Spaces), the three storage operators and all their listings are made up.

A marketplace lists storage units from several operators. Each operator publishes its own feed: one sends XML, one sends CSV, one has a JSON API, and no two use the same field names. This n8n workflow reads every feed on a schedule and keeps the marketplace's Listings table in step with it:

- New units are created, changed units are updated, and units nobody touched are left alone.
- Each listing is matched on `operator + the operator's own unit ref`, so running the sync again never creates a duplicate.
- A unit marked rented or withdrawn, or one that drops out of the feed, is closed. If it comes back later, the same listing is reopened.
- A broken row (missing price, unknown unit type, the same ref twice) is skipped and listed in Row Errors with the field and the value. The rest of the feed still syncs, and the broken row's listing stays as it was.
- If a feed is down, empty, cut off mid-record (XML, or a CSV quote left open), an HTML page instead of the feed, or missing the unit ref column, nothing changes for that operator and the note says which.
- If more than half of an operator's live listings are missing from the feed at once, updates still go through, but the missing ones are set to Pending removal for a person to close, and Slack gets an alert. Any that come back in the feed return to Active on their own. Units the feed itself marks rented or withdrawn close as usual and don't count toward this.
- If that happens and the feed also has new refs for at least half of the live listings, it looks like the operator renumbered its units: no new listings are created and no missing listing is closed, matching listings are still updated, and Slack asks someone to check.
- These two checks only apply once an operator has at least 5 live listings (`safety.min_active`).
- Adding an operator means adding one mapping file in `sources/` and checking it with a dry run. The workflow itself stays the same.

There is also an n8n Cloud version in `workflows-cloud/`: the same sync rules, with mappings kept in an Airtable table instead of files. It passed the same 105 checks on an n8n Cloud trial instance. Setup: [docs/SETUP-CLOUD.md](docs/SETUP-CLOUD.md).

## What was run

Ten runs (R1 to R8, including two dry runs) against a real Airtable base, with Slack alerts. Each run's result is compared with the expected numbers in `sample-data/scenarios.json`, and all 105 of 105 checks pass. Each run's report and the checker output are in [results/](results/README.md); notes on what was and wasn't tested are in [docs/VERIFICATION.md](docs/VERIFICATION.md).

| Run | Feed situation | What happened |
| --- | --- | --- |
| R1 | First sync | 22 listings created |
| R2 | Same feeds again | 0 created, 0 updated, 22 unchanged |
| R3 | Price change, unit rented, unit gone, new unit, 3 broken rows | Only those listings changed; 4 broken rows named (one ref is on two rows), their listings untouched |
| R4 | Northgate feed returns HTTP 503 | Northgate untouched, Quayside synced as usual |
| R5 | Northgate sends 4 of 11 units | 1 price update applied, 7 removals held |
| R6 | Full feed again | 7 held listings back to Active, 1 closed listing reopened (same record) |
| R7a to R7c | New operator: draft mapping, dry run, fix, dry run, go live | Draft problems listed before anything was written; then 5 listings created |
| R8 | Everything again | 0 changes across 28 listings |

## How it works

`n8n-src/code/` holds the sync rules as plain JavaScript with unit tests (`node --test n8n-src/code/sync.test.js`, 26 tests). `n8n-src/build-workflows.mjs` puts that code into the n8n workflow files in `workflows/`.

The workflow handles one operator at a time:

1. Fetch feed: an HTTP request to the operator's URL.
2. Read current listings: everything in Airtable for that operator. If this fails, the run stops, because guessing would create duplicates.
3. Plan changes: parse the feed, map it with the operator's mapping file, check each row, compare with what is live, and apply the safety rules.
4. Write to Airtable: upsert listings in batches of 10 on `Listing key`, then log the run in Sync Runs and any bad rows in Row Errors.
5. Alert: post to Slack, only when something needs a person.

Each listing stores a content hash, so the sync can tell a changed unit from an identical one. A repeat run reports those rows as unchanged and writes nothing.

## Files

| Path | What it is |
| --- | --- |
| `sources/*.json` | One mapping file per operator |
| `docs/ONBOARDING.md` | Adding a new operator, step by step |
| `docs/FEED-SPEC.md` | What an operator's feed needs to contain |
| `docs/OPERATIONS.md` | Reading the run log, alerts and held removals |
| `docs/SETUP.md` | Running the demo locally |
| `sample-data/feeds/` | The made-up feeds for each demo day (`make_feeds.py` writes them) |
| `sample-data/scenarios.json` | Each demo run and its expected result |
| `scripts/` | Setup, scenario runner, result checker |

## Running this for your own team

This repo runs a demo for a made-up storage marketplace on localhost. Putting it to work for a real team takes more:

- Hosting n8n somewhere it runs on schedule, with access protection
- Connecting your real platform (for example the Sharetribe Integration API or Shopify) in place of the Airtable table, with your own accounts and keys
- Writing mapping files for your actual operators and agreeing on a feed spec with them
- Deciding how images are handled on your platform
- Testing with real feeds before going live, and keeping it running afterward

This is the part I do for clients.

## License

Copyright © 2026 rikkadawufa. All rights reserved. No license is granted to use, copy, modify, or distribute this code.
