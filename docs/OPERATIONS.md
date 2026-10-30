# Operations

## Where to look

- Sync Runs has one row per operator per run. The counts (created, updated, unchanged, closed, reopened, restored, held, row errors) are computed in code from what was written. The Notes column says why anything was skipped or held.
- Row Errors lists every skipped row with its unit ref, row number, field, problem and raw value.
- In Listings, `Last changed run` shows which run last touched a listing and `First seen run` shows when it was created.
- `output/runs/<run>/report.txt` on the n8n host has the same summary as plain text.

## Outcomes

| Outcome | Meaning | What to do |
| --- | --- | --- |
| OK | Synced | Nothing |
| OK with row errors | Synced; some rows skipped | Send the Row Errors lines to the operator |
| Feed unavailable | Feed didn't answer 200, or was empty or cut off. Nothing changed for that operator. | If it keeps happening, contact the operator |
| Removals held | Feed had far fewer rows than what's live. Updates applied; missing listings set to Pending removal. | See below |
| Mapping file error | `sources/<id>.json` is invalid or incomplete. Operator skipped. | Fix the file; the note says what's wrong |

## Held removals

A listing in Pending removal stays visible and isn't closed. On the next run, held listings that are back in a complete feed return to Active and are counted as `restored`.

If the operator really did remove those units, close them by hand in Airtable: set Status to `Closed` and Close reason to `Missing from feed`. The demo has no one-click release.

The threshold is `safety.min_ratio` in each mapping file. The default of 0.5 holds removals when the feed has fewer than half as many rows as there are live listings, and the rule only applies when at least `safety.min_active` listings are live.

## Slack alerts

Slack gets a message only when a person should look: feed unavailable, removals held, rows skipped or a mapping file error. If the workflow itself fails (for example Airtable can't be read), the error workflow posts the node name and message, and the run stops there without processing the remaining operators.

## Schedule

The workflow has a disabled Every 6 hours trigger. In the demo every run was started through the webhook. Turn the trigger on in n8n to run on a schedule.

## Known limits

- A listing edited by hand in Airtable isn't overwritten until the operator's feed changes that unit. The sync compares the feed with the hash it stored last time, not with the current cell values.
- A single unit that drops out of a feed is closed on the first run it's missing. There is no grace period; if it comes back, it reopens as the same listing.
- Two runs started at the same time aren't prevented. With a 6-hour schedule that doesn't happen on its own.
- If someone adds a second row with the same Listing key by hand, Airtable's upsert refuses the batch and the run stops with an alert.
