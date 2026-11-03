# Setup

These steps take an empty machine to the R1 to R8 results. Commands are for PowerShell on Windows and work in bash too. In Git Bash, set `MSYS_NO_PATHCONV=1` before `docker compose exec` commands with `/files/...` paths.

## Requirements

- Docker Desktop
- Python 3.12 and Node.js 24 (standard library only, nothing to install)
- A free Airtable account
- A Slack incoming webhook for alerts

## 1. Airtable base

Create a base with three tables. Field names must match exactly; types are in brackets.

- Listings: Listing key (text, primary), Source (single select), External ref (text), Title (text), Unit type (single select), Size m2 (number, 1 decimal), Monthly price (currency), Area (text), Climate controlled (checkbox), Image URL (URL), Status (single select: Active, Pending removal, Closed), Close reason (single select: Rented, Withdrawn, Missing from feed), Content hash (text), First seen run (text), Last changed run (text)
- Sync Runs: Run (text, primary), Source (text), Mode (single select), Outcome (single select), Rows in feed, Created, Updated, Unchanged, Closed, Reopened, Restored, Held, Row errors (numbers), Notes (long text)
- Row Errors: Error (text, primary), Run, Source, External ref (text), Row (number), Field, Problem, Raw value (text)

Writes use `typecast`, so new select options (a new operator id, for example) are added automatically.

Then create a personal access token at https://airtable.com/create/tokens with the scopes `data.records:read` and `data.records:write`, limited to this base.

## 2. `.env`

Copy `.env.example` to `.env`:

| Variable | Value |
| --- | --- |
| `AIRTABLE_TOKEN` | The token from step 1 |
| `AIRTABLE_BASE_ID` | From the base URL, starts with `app` |
| `SLACK_WEBHOOK_URL` | Your incoming webhook |
| `N8N_ENCRYPTION_KEY` | Any long random string. Keep it: if it changes later, n8n can't read its stored credentials. |
| `N8N_VERSION` | `2.44.7` was used for testing |
| `GENERIC_TIMEZONE` | For example `Asia/Taipei` |

## 3. Start and import

```powershell
node n8n-src/build-workflows.mjs
python sample-data/make_feeds.py
docker compose up -d
python scripts/n8n_setup.py
```

n8n runs at http://localhost:5681. The simulated operator feeds are at http://localhost:8081/feeds/<id>. A test SFTP server (service `sftp`) serves the same files under `/feeds`, and `n8n_setup.py` adds its test login as the **Supplier SFTP** credential. The two `FEED_SECRET_DEMO_*` variables in `docker-compose.yml` are the test keys of the simulated feeds; a real install puts its operators' keys there ([ONBOARDING.md](ONBOARDING.md#optional-settings)).

## 4. Run the demo days

```powershell
python scripts/run_scenarios.py --reset
python scripts/check_results.py
node --test n8n-src/code/*.test.js
python scripts/run_extras.py
```

`--reset` deletes every row in the three tables first, so use it only on the demo base. `run_extras.py` checks the optional feed settings (keys, SFTP, Google Sheets, markup) with dry runs, which write nothing to Listings.
