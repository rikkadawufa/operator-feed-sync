# Feed spec for operators

This is what the marketplace needs from each operator's feed. You can use your own field names and your own words for unit types and statuses, and we map them on our side (see [ONBOARDING.md](ONBOARDING.md)). The requirements below still apply.

## Format and delivery

- One URL that returns your complete current list of units every time: all of them, not only what changed since last time. A unit missing from the feed is treated as gone.
- XML, CSV (UTF-8, header row, comma or semicolon) or JSON.
- The URL answers HTTP 200 with the full file. If you're mid-export or down, answer with an error code (503 is fine) rather than an empty or partial file. A login or error web page in place of the feed is treated as unavailable, and nothing changes.

## Fields per unit

| Field | Required | Rules |
| --- | --- | --- |
| Unit ref | yes | Your own ID for the unit. It never changes, is never reused for a different unit, and appears only once per feed. If you ever renumber, tell us first: when more than half of the current refs disappear and new refs replace them, we create no new listings and close none of the missing ones until we check. |
| Title | yes | Plain text |
| Unit type | yes | One consistent set of values, for example `S / M / L` or `Small Unit / Medium Unit` |
| Size | yes | A positive number, in m² or sq ft (tell us which) |
| Monthly price | yes | A positive number. A currency symbol and thousands separators are fine. |
| Status | yes | One consistent set of values meaning available / rented / withdrawn |
| Area | no | Neighborhood or district |
| Climate controlled | no | yes/no, Y/N, true/false |
| Image URL | no | Must start with `https://` |

## What happens to a bad row

We skip the row and log the unit ref, the field and the value we received. Your other units still sync, and the skipped unit's current listing stays as it was until a good row arrives.

## Examples

The demo feeds in `sample-data/feeds/` include one working example of each format:

- `day1/northgate.xml`: XML, ref as an attribute
- `day1/quayside.csv`: CSV, sizes in sq ft
- `day7/pinecrest.json`: JSON, nested fields, decimal commas
