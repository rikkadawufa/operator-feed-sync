// Compares one source's feed with what the marketplace already has and decides every write.
// Needs parse.js, map.js and fetch.js inlined before it. Pure: no network, so the rules are unit tested.

const STATUS_FOR = { available: 'Active', rented: 'Closed', withdrawn: 'Closed' };
const CLOSE_REASON_FOR = { rented: 'Rented', withdrawn: 'Withdrawn' };
// min_ratio: share of live listings that must still be in the feed, or the missing ones are held
// (0.5 = closing more than half is held). min_active: smaller sources are never held.
const DEFAULT_SAFETY = { min_ratio: 0.5, min_active: 5 };

function listingKey(sourceId, ref) {
  return `${sourceId}:${ref}`;
}

function contentHash(listing) {
  const ordered = ['external_ref', 'title', 'unit_type', 'size_m2', 'monthly_price', 'area', 'climate_controlled', 'image_url', 'status'];
  const payload = JSON.stringify(ordered.map((name) => listing[name]));
  return sha1Hex(payload).slice(0, 16);
}

// Plain-JS SHA-1 (same output as crypto's) so the Code node needs no require(); n8n Cloud allows none.
function sha1Hex(text) {
  const bytes = Array.from(unescape(encodeURIComponent(text)), (c) => c.charCodeAt(0));
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let shift = 56; shift >= 0; shift -= 8) bytes.push(Math.floor(bitLength / 2 ** shift) & 0xff);
  const rotl = (n, s) => (n << s) | (n >>> (32 - s));
  let [h0, h1, h2, h3, h4] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const w = new Array(80);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = (bytes[offset + i * 4] << 24) | (bytes[offset + i * 4 + 1] << 16) | (bytes[offset + i * 4 + 2] << 8) | bytes[offset + i * 4 + 3];
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
    for (let i = 0; i < 80; i++) {
      const [f, k] = i < 20 ? [(b & c) | (~b & d), 0x5a827999] : i < 40 ? [b ^ c ^ d, 0x6ed9eba1] : i < 60 ? [(b & c) | (b & d) | (c & d), 0x8f1bbcdc] : [b ^ c ^ d, 0xca62c1d6];
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      [e, d, c, b, a] = [d, c, rotl(b, 30), a, t];
    }
    [h0, h1, h2, h3, h4] = [(h0 + a) | 0, (h1 + b) | 0, (h2 + c) | 0, (h3 + d) | 0, (h4 + e) | 0];
  }
  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}

function emptySummary(feedRows = 0) {
  return { feedRows, created: 0, updated: 0, unchanged: 0, closed: 0, reopened: 0, restored: 0, held: 0, rowErrors: 0, ignored: 0 };
}

// Why no row can name its listing: the mapped ref field isn't in the feed at all, or it is but is
// always empty. Returns '' when at least one row has a ref.
function refFieldIssue(parsed, refPath) {
  const rows = parsed.rows.filter((entry) => !entry.shapeError);
  const values = rows.map((entry) => getPath(entry.raw, refPath));
  const present = parsed.headers ? parsed.headers.includes(refPath) : values.some((value) => value !== undefined);
  if (!present) {
    const names = parsed.headers || Object.keys((rows[0] || parsed.rows[0]).raw);
    return `mapping field "${refPath}" is not in the feed; the feed has: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ', …' : ''}`;
  }
  if (!values.some((value) => value != null && String(value).trim() !== '')) return `no row has a value in "${refPath}"`;
  return '';
}

// fetchResult: { statusCode, body, error }  existing: [{ id, fields }] for this source only.
function planSync({ source, fetchResult, existing, runId, mode = 'live' }) {
  const safety = { ...DEFAULT_SAFETY, ...(source.safety || {}) };
  const result = { source: source.id, runId, mode, outcome: 'OK', summary: emptySummary(), writes: [], rowErrors: [], alerts: [], notes: [] };
  const stop = (reason) => {
    result.outcome = 'Feed unavailable';
    result.notes.push(`${reason}. Nothing was changed for ${source.id}; listings stay as they were.`);
    if (mode !== 'dry run') result.alerts.push(`:warning: ${source.name}: feed not used this run (${reason}). No listings were closed.`);
    return result;
  };

  const configIssues = [...checkSource(source), ...checkFetch(source)];
  if (configIssues.length) {
    result.outcome = 'Mapping file error';
    result.notes.push(`${source.configLabel || `sources/${source.id}.json`}: ${configIssues.join('; ')}`);
    if (mode !== 'dry run') result.alerts.push(`:warning: ${source.name}: mapping file has problems, source skipped: ${configIssues.join('; ')}`);
    return result;
  }
  if (fetchResult.error) return stop(`could not fetch feed: ${fetchResult.error}`);
  if (fetchResult.statusCode !== 200) return stop(`feed answered HTTP ${fetchResult.statusCode}`);
  if (!String(fetchResult.body || '').trim()) return stop('feed was empty');
  if (isHtmlPage(fetchResult.body, source.format)) return stop(`feed is an HTML page, not ${source.format.toUpperCase()}`);

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
  // Without the ref column the feed can't say which listings are still there (renamed column,
  // wrong delimiter), so it is not used at all.
  const refIssue = refFieldIssue(parsed, source.fields.external_ref);
  if (refIssue) return stop(refIssue);

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
  const creates = new Set();
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
      const write = { ...fields, 'First seen run': runId };
      result.writes.push(write);
      creates.add(write);
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

  // Listings the feed no longer has (live, and their ref is on no row). If this run would close too
  // many of them, hold instead of closing. safety.min_ratio is the share of live listings that must
  // still be in the feed: with 0.5, closing more than half of them is held. Counting distinct refs
  // means duplicate or unreadable rows can't make a short feed look full.
  const missing = existing.filter((record) => live(record) && !seenRefs.has(record.fields['External ref']));
  const stillThere = activeBefore - missing.length;
  const percent = Math.round(safety.min_ratio * 100);
  const tooMany = activeBefore >= safety.min_active && stillThere < safety.min_ratio * activeBefore;
  // As many new refs as missing ones looks like the supplier renumbered its items: creating and
  // closing would swap every listing for a copy, so this run only updates the listings that match.
  // New refs on broken rows count too, or a renumbered feed with bad rows would slip through.
  const newRefs = [...seenRefs].filter((ref) => !byKey.has(listingKey(source.id, ref)));
  const idsChanged = tooMany && newRefs.length >= activeBefore - safety.min_ratio * activeBefore;
  if (idsChanged) {
    result.outcome = 'IDs look changed';
    result.writes = result.writes.filter((write) => !creates.has(write));
    result.summary.created = 0;
    result.summary.held = missing.filter((record) => record.fields.Status === 'Pending removal').length;
    const kept = 'No new listings were created and no missing listing was closed';
    const closedByFeed = result.summary.closed ? `; ${result.summary.closed} closed because the feed marks them rented or withdrawn` : '';
    result.notes.push(`${missing.length} of ${activeBefore} live listings are missing from the feed and ${newRefs.length} refs in it are new. ${kept}; matching listings were updated${closedByFeed}`);
    result.alerts.push(`:warning: ${source.name}: ${missing.length} old IDs are missing and ${newRefs.length} new IDs appeared. Check whether the supplier changed its item IDs. ${kept} this run.`);
  } else if (missing.length && tooMany) {
    result.outcome = 'Removals held';
    for (const record of missing) {
      if (record.fields.Status !== 'Pending removal') result.writes.push({ 'Listing key': record.fields['Listing key'], Status: 'Pending removal', 'Last changed run': runId });
      result.summary.held += 1;
    }
    // A short feed keeps the original wording; a feed with enough rows but too few known refs says so.
    const note = rows.length < safety.min_ratio * activeBefore
      ? `feed has ${rows.length} rows but ${activeBefore} listings are live (below ${percent}%). ${missing.length} missing listings marked Pending removal, not closed`
      : `${missing.length} of ${activeBefore} live listings are missing from the feed (only ${stillThere} still in it, below ${percent}%). ${missing.length} missing listings marked Pending removal, not closed`;
    result.notes.push(note);
    result.alerts.push(`:warning: ${source.name}: ${note}. Check the feed before releasing them.`);
  } else {
    // A held listing only closes when a person closes it, even after the feed recovers.
    const stillHeld = missing.filter((record) => record.fields.Status === 'Pending removal');
    for (const record of missing) {
      if (record.fields.Status === 'Pending removal') continue;
      result.writes.push({ 'Listing key': record.fields['Listing key'], Status: 'Closed', 'Close reason': 'Missing from feed', 'Last changed run': runId });
      result.summary.closed += 1;
    }
    if (stillHeld.length) {
      result.summary.held += stillHeld.length;
      result.notes.push(`${stillHeld.length} listing(s) still Pending removal, waiting for a person to close them`);
    }
  }

  if (result.summary.ignored) result.notes.push(`${result.summary.ignored} new row(s) not available yet, so not listed`);
  if (result.summary.rowErrors) {
    if (result.outcome === 'OK') result.outcome = 'OK with row errors';
    // Both copies of a duplicate ref report the same line, so list each line once.
    const lines = [...new Set(result.rowErrors.map((error) => `${error.ref || 'row ' + error.row}: ${error.problem}${error.raw ? ` ("${error.raw}")` : ''}`))];
    result.alerts.push(`:memo: ${source.name}: ${result.summary.rowErrors} row(s) skipped, the rest synced. ${lines.slice(0, 3).join('; ')}${lines.length > 3 ? '; …' : ''}`);
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

if (typeof module !== 'undefined') module.exports = { listingKey, contentHash, sha1Hex, planSync, runRecords, chunk };
