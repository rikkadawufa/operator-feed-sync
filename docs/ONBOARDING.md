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
- `safety`: if the feed has fewer rows than `min_ratio` × the listings currently live, and at least `min_active` listings are live, removals are held instead of applied.

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

A Mapping file error in Sync Runs means the file is missing a required field or maps to a value we don't accept; the note says which one. Feed unavailable means the URL didn't answer 200, or the feed was empty or cut off, and nothing changed for this operator. [OPERATIONS.md](OPERATIONS.md) covers alerts and held removals.
