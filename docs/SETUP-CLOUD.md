# Setup on n8n Cloud

n8n Cloud doesn't let Code nodes read files, load Node modules or read environment variables, so the self-hosted workflow won't run there. `workflows-cloud/` holds a version that needs none of those. The sync rules are the same code (`n8n-src/code/`), so it gives the same results.

What changes:

| | Self-hosted | n8n Cloud |
| --- | --- | --- |
| Supplier mappings | `sources/<id>.json` files | One row per supplier in the **Feed Sources** table |
| Airtable base ID, Slack URL | Environment variables | The **Settings** node (one in each workflow) |
| Run report | Written to `output/runs/<run>/` and returned | Returned by the webhook; Sync Runs and Row Errors as before |
| Error workflow | Linked on import | Picked by hand in the workflow settings |

## 1. Airtable

Use the same three tables as in [SETUP.md](SETUP.md), plus a fourth:

- Feed Sources: Source (text, primary), Enabled (checkbox), Mapping (long text)

`Source` is the id (for example `northgate`). `Mapping` is the mapping as JSON, the same as a `sources/<id>.json` file without `id` and `enabled`. A mapping that isn't valid JSON is reported for that source; the others still run.

## 2. n8n Cloud

1. Create an Airtable credential (Personal Access Token) with `data.records:read` and `data.records:write` on the base.
2. Import `workflows-cloud/wfSyncErrorsCloud.json`, then `workflows-cloud/wfFeedSyncCloud.json`.
3. In each workflow, open **Settings** and fill in the Airtable base ID (starts with `app`) and the Slack incoming webhook.
4. In the feed sync, pick the Airtable credential on **Read feed sources**, **Read current listings** and **Write to Airtable**.
5. Publish the error handler first (n8n only offers published error workflows), then in the feed sync's workflow settings set **Error Workflow** to "Feed sync (Cloud): error handler".
6. Publish both. For production, enable **Every 6 hours** (or your own schedule).

Supplier feed URLs have to be reachable from the internet, since n8n Cloud can't see your local network.

## 3. Check it

```powershell
python scripts/run_scenarios.py --reset --cloud --webhook https://<instance>.app.n8n.cloud/webhook/feed-sync --feeds-base https://<public feed server> --out output/cloud
python scripts/check_results.py --out output/cloud
```

`--cloud` copies `sources/*.json` into Feed Sources before each step, with the feed URLs pointed at `--feeds-base`. If you have no public feed server, add `--feeds-table`: the runner writes each day's feeds into a **Test Feeds** table (Source, Status, Content type, Body), and the test-feeds workflow (`workflows-cloud/test/`, publish it too) serves them at `https://<instance>.app.n8n.cloud/webhook/<its webhook id>/feeds/<source>`; pass `https://<instance>.app.n8n.cloud/webhook/<its webhook id>` as `--feeds-base`. That's how the 2026-11-01 Cloud run was done. To test the Cloud workflow without a Cloud account, `docker compose --profile cloudsim up -d` starts an n8n with Cloud's Code-node limits on port 5682, and `python scripts/n8n_setup.py --cloudsim` imports and publishes it there. Use `--webhook http://localhost:5682/webhook/feed-sync` and leave out `--feeds-base`.
