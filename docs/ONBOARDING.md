# Adding a new operator

Map the fields, check them with a dry run, then go live. You edit one JSON file and leave the workflow as it is. Run R7 in the demo does exactly this with Pinecrest Self Storage.

## 1. Map the fields

Copy an existing file in `sources/` that has the same format (`xml`, `csv` or `json`) and save it as `sources/<operator-id>.json`.

```json
{
  "id": "pinecrest",                       // lowercase, used in every Listing key: pinecrest:PC-A01
  "name": "Pinecrest Self Storage",        // shown in alerts
  "enabled": true,                         // false = skipped by the scheduled run
  "format": "json",                        // xml, csv or json
  "record": "data.units",                  // xml: the record element name; json: where the list is
  "decimal": ",",                          // only if the feed writes 72,50 instead of 72.50
  "url": "https://…",                      // the operator's feed URL
  "fields": {                              // our field → the operator's field (dot paths for nested JSON)
    "external_ref": "unit_code",
    "title": "label",
    "unit_type": "kind",
    "size": "dimensions.area_sqm",
    "monthly_price": "price.amount",
    "area": "location.district",
    "climate_controlled": "features.climate",
    "image_url": "media.main",
    "status": "state"
  },
  "units": { "size": "sqft" },             // only if sizes are in square feet
  "values": {                              // the operator's words → ours
    "unit_type": { "XS": "locker", "S": "small" },
    "status": { "free": "available", "reserved": "rented", "occupied": "rented", "retired": "withdrawn" }
  },
  "safety": { "min_ratio": 0.5, "min_active": 5 }
}
```

The comments above are only there to explain the file. Real JSON files can't contain comments.

- Required: `external_ref`, `title`, `unit_type`, `size`, `monthly_price`, `status`.
- Our unit types are `locker`, `small`, `medium`, `large` and `parking`. Our statuses are `available`, `rented` and `withdrawn`.
- If the operator already uses our words (Pinecrest's `kind` is already `small`, `medium` and so on), leave that part of `values` out.
- `safety`: `min_ratio` is the share of live listings that must still be in the feed. With 0.5, if more than half of them are missing from the feed at once, the missing ones are set to Pending removal for a person to close instead of closing. Units the feed marks rented or withdrawn close as usual and don't count. If the feed also has new refs for at least half of the live listings, no new listings are created and no missing listing is closed (IDs look changed). Both checks apply only when at least `min_active` listings are live.

## Optional settings

Add these to the same file when the operator's feed needs them. A wrong setting is a Mapping file error with a note naming it, and nothing runs for that operator.

| Setting | Example | What it does |
| --- | --- | --- |
| Google Sheets link as `url` | `"url": "https://docs.google.com/spreadsheets/d/<id>/edit#gid=0"`, `"format": "csv"` | The link copied from the browser is turned into the sheet's CSV export (that tab only, from `gid`). The sheet has to be shared as "Anyone with the link can view"; a private sheet answers with a sign-in page, and the run stops for that operator. A "Publish to web" CSV link works as it is. |
| `markup` | `{ "percent": 30, "add": 2, "round": "99" }` | Listing price = feed price × (1 + percent/100) + add, then rounded: `cents` (default), `whole`, or `99` (up to the next .99, never below the marked-up price). Each part is optional. Changing it updates every price in the next run, once. |
| `auth` | `{ "type": "header", "name": "X-API-Key", "secret": "PINECREST_KEY" }` | For a feed behind a key or password. `type` is `header` (needs `name`), `bearer`, `basic` (needs `user`) or `query` (needs `name`, the URL parameter). `secret` is only the name of the secret, in capitals with at least one `_`; the value lives in n8n (below), never in this file. The URL must be `https`. These settings are checked before anything is sent, so a wrong one never sends the key. |
| `transport`, `path` | `"transport": "sftp", "path": "/out/stock.csv"` | Reads the file from an SFTP server instead of a URL. Leave out `url` and `auth`; the server and login are in the n8n credential **Supplier SFTP**. |

Where the secret value for `auth` goes:

- Self-hosted: an environment variable `FEED_SECRET_<secret>` on the n8n container. With the demo's `docker-compose.yml`, add a line under the n8n service's `environment:`, for example `- FEED_SECRET_PINECREST_KEY=${FEED_SECRET_PINECREST_KEY}`, and put the value in `.env` (a value only in `.env` doesn't reach n8n). Then run `docker compose up -d`; `docker compose restart` doesn't pick up new variables.
- n8n Cloud: the **feedSecrets** field of the **Settings** node, as JSON: `{ "PINECREST_KEY": "…" }`.

A missing secret is reported as `secret PINECREST_KEY is not set` and that operator is skipped. Secret values are blanked out (`***`) in notes, Row Errors and Slack. They still pass through n8n: anyone who can open the workflow (Cloud) or its execution log can read them, so use a read-only feed key where the operator offers one.

SFTP: n8n's FTP node takes its server and login from one credential, so all SFTP operators share **Supplier SFTP**. An operator on a different SFTP server needs a copy of the **Fetch over SFTP** node with its own credential and a matching route in **SFTP source?**. If no operator uses SFTP, leave the credential empty; the workflow still publishes and runs.

## 2. Dry run

Call the workflow for this operator only, in dry-run mode:

```
POST http://localhost:5681/webhook/feed-sync
{ "run": "pinecrest-check-1", "mode": "dry run", "sources": ["pinecrest"] }
```

Nothing is written to Listings. You get a report back, a row in Sync Runs (Mode: dry run), and every problem in Row Errors.

In the demo, the first draft rejected all 6 rows:

| Row error | Cause | Fix in the mapping file |
| --- | --- | --- |
| `monthly_price: missing price` | Price path was `price.value`; the feed uses `price.amount` | `"monthly_price": "price.amount"` |
| `size: size is not a positive number ("1,8")` | Feed uses decimal commas | `"decimal": ","` |
| `status: unknown status ("reserved")` | `reserved` wasn't mapped | `"reserved": "rented"` |

Fix the file and dry-run again until Row Errors is empty or lists only rows the operator has to fix on their side. In the demo, the second dry run planned 5 new listings and left out 1 reserved unit.

## 3. Go live

Run the same call without `"mode": "dry run"`. Check that the Sync Runs row says `OK` and that the created count matches what the dry run planned. From then on the scheduled run includes this operator, as long as `"enabled": true`.

## If something looks wrong

A Mapping file error in Sync Runs means the file is missing a required field or maps to a value we don't accept; the note says which one. Feed unavailable means the URL didn't answer 200 (401 or 403: the key is wrong), the secret isn't set, the SFTP file wasn't found, the feed was empty or cut off mid-record (XML, or a CSV quote left open), it was an HTML page, or the ref field wasn't found; nothing changed for this operator. A missing ref field reads `mapping field "unit_code" is not in the feed; the feed has: …` and lists the fields the feed does have, so you can fix `fields.external_ref`. `no row has a value in "unit_code"` means the field is there but empty. [OPERATIONS.md](OPERATIONS.md) covers alerts and held removals.
