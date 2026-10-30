// Compares one source's feed with what the marketplace already has and decides every write.
// Needs parse.js and map.js inlined before it. Pure: no network, so the rules are unit tested.

const STATUS_FOR = { available: 'Active', rented: 'Closed', withdrawn: 'Closed' };
const CLOSE_REASON_FOR = { rented: 'Rented', withdrawn: 'Withdrawn' };
const DEFAULT_SAFETY = { min_ratio: 0.5, min_active: 5 };

function listingKey(sourceId, ref) {
  return `${sourceId}:${ref}`;
}

function contentHash(listing) {
  const ordered = ['external_ref', 'title', 'unit_type', 'size_m2', 'monthly_price', 'area', 'climate_controlled', 'image_url', 'status'];
  const payload = JSON.stringify(ordered.map((name) => listing[name]));
  return require('crypto').createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

function emptySummary(feedRows = 0) {
  return { feedRows, created: 0, updated: 0, unchanged: 0, closed: 0, reopened: 0, restored: 0, held: 0, rowErrors: 0, ignored: 0 };
}

// fetchResult: { statusCode, body, error }  existing: [{ id, fields }] for this source only.
function planSync({ source, fetchResult, existing, runId, mode = 'live' }) {
  const safety = { ...DEFAULT_SAFETY, ...(source.safety || {}) };
  const result = { source: source.id, runId, mode, outcome: 'OK', summary: emptySummary(), writes: [], rowErrors: [], alerts: [], notes: [] };
  const stop = (reason) => {
    result.outcome = 'Feed unavailable';
    result.notes.push(`${reason}. Nothing was changed for ${source.id}; listings stay as they were.`);
    result.alerts.push(`:warning: ${source.name}: feed not used this run (${reason}). No listings were closed.`);
    return result;
  };

  const configIssues = checkSource(source);
  if (configIssues.length) {
    result.outcome = 'Mapping file error';
    result.notes.push(`sources/${source.id}.json: ${configIssues.join('; ')}`);
    result.alerts.push(`:warning: ${source.name}: mapping file has problems, source skipped: ${configIssues.join('; ')}`);
    return result;
  }
  if (fetchResult.error) return stop(`could not fetch feed: ${fetchResult.error}`);
  if (fetchResult.statusCode !== 200) return stop(`feed answered HTTP ${fetchResult.statusCode}`);
  if (!String(fetchResult.body || '').trim()) return stop('feed was empty');

  let parsed;
  try {
    parsed = parseFeed(fetchResult.body, source);
  } catch (error) {
    if (error instanceof FeedError) return stop(`feed could not be read: ${error.message}`);
    throw error;
  }
  const rows = parsed.rows;
  result.summary.feedRows = rows.length;
  if (!rows.length) return stop('feed had no records');

  // Map every row; collect problems per row.
  const mapped = rows.map((entry) => {
    if (entry.shapeError) return { row: entry.row, listing: { external_ref: '' }, problems: [{ field: '(row)', problem: entry.shapeError, raw: '' }] };
    const { listing, problems } = mapRow(entry.raw, source);
    return { row: entry.row, listing, problems };
  });

  // The same ref twice is ambiguous: reject every copy and leave the current listing alone.
  const rowsByRef = new Map();
  for (const item of mapped) {
    if (!item.listing.external_ref) continue;
    rowsByRef.set(item.listing.external_ref, [...(rowsByRef.get(item.listing.external_ref) || []), item.row]);
  }
  for (const item of mapped) {
    const copies = rowsByRef.get(item.listing.external_ref) || [];
    if (copies.length > 1) item.problems.push({ field: 'external_ref', problem: `same ref on rows ${copies.join(' and ')}`, raw: item.listing.external_ref });
  }

  // A ref that is in the feed, even on a broken row, is not "missing".
  const seenRefs = new Set(mapped.map((item) => item.listing.external_ref).filter(Boolean));
  const byKey = new Map(existing.map((record) => [record.fields['Listing key'], record]));
  const live = (record) => ['Active', 'Pending removal'].includes(record.fields.Status);
  const activeBefore = existing.filter(live).length;

  for (const item of mapped) {
    if (item.problems.length) {
      result.summary.rowErrors += 1;
      for (const issue of item.problems) {
        result.rowErrors.push({ ref: item.listing.external_ref || '', row: item.row, field: issue.field, problem: issue.problem, raw: String(issue.raw ?? '') });
      }
      continue;
    }
    const listing = item.listing;
    const key = listingKey(source.id, listing.external_ref);
    const hash = contentHash(listing);
    const status = STATUS_FOR[listing.status];
    const current = byKey.get(key);
    const fields = {
      'Listing key': key, Source: source.id, 'External ref': listing.external_ref, Title: listing.title,
      'Unit type': listing.unit_type, 'Size m2': listing.size_m2, 'Monthly price': listing.monthly_price, Area: listing.area,
      'Climate controlled': listing.climate_controlled, 'Image URL': listing.image_url || null,
      Status: status, 'Close reason': CLOSE_REASON_FOR[listing.status] || null, 'Content hash': hash, 'Last changed run': runId,
    };

    if (!current) {
      if (status !== 'Active') { result.summary.ignored += 1; continue; }
      result.writes.push({ ...fields, 'First seen run': runId });
      result.summary.created += 1;
      continue;
    }
    const was = current.fields.Status;
    if (current.fields['Content hash'] === hash && was === status) { result.summary.unchanged += 1; continue; }
    result.writes.push(fields);
    if (was === 'Closed' && status === 'Active') result.summary.reopened += 1;
    else if (was === 'Pending removal' && status === 'Active') result.summary.restored += 1;
    else if (was !== 'Closed' && status === 'Closed') result.summary.closed += 1;
    else result.summary.updated += 1;
  }

  // Listings the feed no longer has. If the feed suddenly shrank, hold instead of closing.
  const missing = existing.filter((record) => live(record) && !seenRefs.has(record.fields['External ref']));
  const shrank = activeBefore >= safety.min_active && rows.length < safety.min_ratio * activeBefore;
  if (missing.length && shrank) {
    result.outcome = 'Removals held';
    for (const record of missing) {
      if (record.fields.Status !== 'Pending removal') result.writes.push({ 'Listing key': record.fields['Listing key'], Status: 'Pending removal', 'Last changed run': runId });
      result.summary.held += 1;
    }
    const note = `feed has ${rows.length} rows but ${activeBefore} listings are live (below ${Math.round(safety.min_ratio * 100)}%). ${missing.length} missing listings marked Pending removal, not closed`;
    result.notes.push(note);
    result.alerts.push(`:warning: ${source.name}: ${note}. Check the feed before releasing them.`);
  } else {
    for (const record of missing) {
      result.writes.push({ 'Listing key': record.fields['Listing key'], Status: 'Closed', 'Close reason': 'Missing from feed', 'Last changed run': runId });
      result.summary.closed += 1;
    }
  }

  if (result.summary.ignored) result.notes.push(`${result.summary.ignored} new row(s) not available yet, so not listed`);
  if (result.summary.rowErrors) {
    if (result.outcome === 'OK') result.outcome = 'OK with row errors';
    const first = result.rowErrors.slice(0, 3).map((error) => `${error.ref || 'row ' + error.row}: ${error.problem}${error.raw ? ` ("${error.raw}")` : ''}`);
    result.alerts.push(`:memo: ${source.name}: ${result.summary.rowErrors} row(s) skipped, the rest synced. ${first.join('; ')}${result.rowErrors.length > 3 ? '; …' : ''}`);
  }
  if (mode === 'dry run') {
    result.notes.push(`dry run: ${result.writes.length} write(s) planned, none made`);
    result.alerts = [];
  }
  return result;
}

// Records for the Sync Runs and Row Errors tables.
function runRecords(plan) {
  const s = plan.summary;
  const run = {
    Run: `${plan.runId}/${plan.source}`, Source: plan.source, Mode: plan.mode, Outcome: plan.outcome,
    'Rows in feed': s.feedRows, Created: s.created, Updated: s.updated, Unchanged: s.unchanged, Closed: s.closed,
    Reopened: s.reopened, Restored: s.restored, Held: s.held, 'Row errors': s.rowErrors, Notes: plan.notes.join('\n'),
  };
  const errors = plan.rowErrors.map((error, index) => ({
    Error: `${plan.runId}/${plan.source}/${index + 1}`, Run: `${plan.runId}/${plan.source}`, Source: plan.source,
    'External ref': error.ref, Row: error.row, Field: error.field, Problem: error.problem, 'Raw value': error.raw,
  }));
  return { run, errors };
}

function chunk(list, size = 10) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

if (typeof module !== 'undefined') module.exports = { listingKey, contentHash, planSync, runRecords, chunk };
