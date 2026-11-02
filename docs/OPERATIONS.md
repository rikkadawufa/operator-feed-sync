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
| Feed unavailable | Feed didn't answer 200, was empty or cut off mid-record (XML, or a CSV quote left open), or couldn't say which units exist. Nothing changed for that operator. | Read the note (see below); if it keeps happening, contact the operator |
| Removals held | More than half of the live listings are missing from the feed at once. Updates applied; missing listings set to Pending removal. | See below |
| IDs look changed | Removals would be held, and the feed has new refs for at least half of the live listings. Matching listings updated; no new listings created, no missing listing closed. | See below |
| Mapping file error | `sources/<id>.json` is invalid or incomplete. Operator skipped. | Fix the file; the note says what's wrong |

## Held removals

A listing in Pending removal stays visible and isn't closed. On the next run, held listings that are back in the feed return to Active and are counted as `restored`. Held listings still missing from a later feed stay in Pending removal, even when that feed is big enough for normal closing: the sync never closes them on its own, and the run notes say how many are still waiting.

If the operator really did remove those units, close them by hand in Airtable: set Status to `Closed` and Close reason to `Missing from feed`. The demo has no one-click release.

The threshold is `safety.min_ratio` in each mapping file: the share of live listings (Active or Pending removal) that must still be in the feed. With the default of 0.5, when more than half of them are missing from the feed at once, those removals are held; exactly half missing still closes. Only listings missing from the feed count. A unit the feed itself marks rented or withdrawn closes as usual and isn't part of the threshold. The count uses distinct unit refs, so a short feed padded with repeated or unreadable rows is still held. Neither this check nor the one below applies while fewer than `safety.min_active` listings (default 5) are live; then missing listings simply close.

## IDs look changed

When removals would be held and the feed also has new refs for at least (1 − `min_ratio`) × the live listings (half of them at the default 0.5, so 5 or more new refs for 10 live listings), the operator has probably renumbered its units. New refs on rows with errors count too. Creating the new ones and closing the old ones would replace every listing with a copy, so that run creates no new listings and closes no missing ones. Listings whose refs still match are updated as usual, and one the feed marks rented or withdrawn still closes; the note gives that count. The note and the Slack alert give both counts, for example `8 old IDs are missing and 8 new IDs appeared`.

Ask the operator whether they changed their IDs. If they did, close the old listings by hand in Airtable (Status `Closed`, Close reason `Missing from feed`); the next run then creates the new ones. Every run until then reports IDs look changed again.

## Feed unavailable notes

| Note starts with | Meaning |
| --- | --- |
| `feed answered HTTP 503`, `could not fetch feed` | The URL is down or unreachable |
| `feed was empty`, `feed had no records`, `feed could not be read` | The file arrived empty, cut off mid-record or malformed |
| `feed is an HTML page, not CSV` (or JSON, XML) | The URL returned a web page, such as a login or error page, instead of the feed |
| `mapping field "Unit ID" is not in the feed; the feed has: …` | The ref column was renamed, or the delimiter is wrong. Fix the mapping file or ask the operator |
| `no row has a value in "Unit ID"` | The ref column is there but empty on every row |

A dry run that stops this way writes the note but sends no Slack alert.

## Slack alerts

Slack gets a message only when a person should look: feed unavailable, removals held, IDs look changed, rows skipped or a mapping file error. Dry runs send none. If the workflow itself fails (for example Airtable can't be read), the error workflow posts the node name and message, and the run stops there without processing the remaining operators.

## Schedule

The workflow has a disabled Every 6 hours trigger. In the demo every run was started through the webhook. Turn the trigger on in n8n to run on a schedule.

## Known limits

- A listing edited by hand in Airtable isn't overwritten until the operator's feed changes that unit. The sync compares the feed with the hash it stored last time, not with the current cell values.
- A single unit that drops out of a feed is closed on the first run it's missing. There is no grace period; if it comes back, it reopens as the same listing.
- Two runs started at the same time aren't prevented. With a 6-hour schedule that doesn't happen on its own.
- If someone adds a second row with the same Listing key by hand, Airtable's upsert refuses the batch and the run stops with an alert.
