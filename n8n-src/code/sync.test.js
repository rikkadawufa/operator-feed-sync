// node --test n8n-src/code/sync.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// The modules share globals the same way they do when inlined into one n8n Code node.
Object.assign(global, require('./parse.js'), require('./map.js'), require('./fetch.js'));
const { planSync, runRecords, chunk, listingKey } = require('./plan.js');

const demo = join(__dirname, '..', '..');
const source = (id) => JSON.parse(readFileSync(join(demo, 'sources', `${id}.json`), 'utf8'));
const feed = (path) => readFileSync(join(demo, 'sample-data', 'feeds', path), 'utf8');
const ok = (body) => ({ statusCode: 200, body });

// Applies a plan's writes to an in-memory table, the way the Airtable upsert does.
function apply(table, plan) {
  const byKey = new Map(table.map((record) => [record.fields['Listing key'], record]));
  for (const write of plan.writes) {
    const current = byKey.get(write['Listing key']);
    if (current) Object.assign(current.fields, write);
    else { const record = { id: `rec${byKey.size}`, fields: { ...write } }; byKey.set(write['Listing key'], record); table.push(record); }
  }
  return table;
}
const run = (table, id, body, runId, extra = {}) => {
  const plan = planSync({ source: source(id), fetchResult: typeof body === 'string' ? ok(body) : body, existing: table.filter((r) => r.fields.Source === id), runId, ...extra });
  if (plan.mode !== 'dry run') apply(table, plan);
  return plan;
};
const status = (table, key) => table.find((r) => r.fields['Listing key'] === key).fields.Status;

test('parsers read the three formats', () => {
  assert.equal(parseFeed(feed('day1/northgate.xml'), source('northgate')).rows.length, 12);
  const csv = parseFeed(feed('day1/quayside.csv'), source('quayside'));
  assert.equal(csv.rows.length, 10);
  assert.equal(csv.rows[2].raw['Unit Name'], 'Unit 12, upper deck');
  assert.equal(parseFeed(feed('day7/pinecrest.json'), source('pinecrest')).rows.length, 6);
});

test('cut-off XML is refused, not half read', () => {
  const text = feed('day1/northgate.xml');
  assert.throws(() => parseXml(text.slice(0, text.length / 2), 'listing'), FeedError);
});

test('CSV quoting and BOM', () => {
  const { rows } = parseCsv('﻿a,b\r\n"x, y","say ""hi"""\r\n');
  assert.deepEqual(rows[0].raw, { a: 'x, y', b: 'say "hi"' });
});

test('numbers: prices, decimal commas and ambiguous separators', () => {
  assert.equal(parseNumber('$1,249.50'), 1249.5);
  assert.equal(parseNumber('1.249,50', ','), 1249.5);
  assert.equal(parseNumber('72,50', ','), 72.5);
  assert.ok(Number.isNaN(parseNumber('1,8')));
  assert.ok(Number.isNaN(parseNumber('TBD')));
});

test('mapping: sq ft converted, values translated, problems named', () => {
  const { rows } = parseFeed(feed('day1/quayside.csv'), source('quayside'));
  const { listing, problems } = mapRow(rows[4].raw, source('quayside'));
  assert.deepEqual(problems, []);
  assert.equal(listing.unit_type, 'medium');
  assert.equal(listing.size_m2, 9.3);
  assert.equal(listing.monthly_price, 118);
  assert.equal(listing.climate_controlled, true);
  const bad = mapRow({ ...rows[6].raw, Category: 'Jumbo', 'Monthly Rate': '' }, source('quayside'));
  assert.deepEqual(bad.problems.map((p) => p.field), ['unit_type', 'monthly_price']);
});

test('markup: percent, fixed add and rounding', () => {
  assert.equal(applyMarkup(29, undefined), 29);
  assert.equal(applyMarkup(29, { percent: 30 }), 37.7);
  assert.equal(applyMarkup(29, { percent: 30, add: 2 }), 39.7);
  assert.equal(applyMarkup(29, { percent: 30, round: 'whole' }), 38);
  assert.equal(applyMarkup(29, { percent: 30, round: '99' }), 37.99);
  assert.equal(applyMarkup(30, { round: '99' }), 30.99);
  const marked = { ...source('quayside'), markup: { percent: 25, round: '99' } };
  const { rows } = parseFeed(feed('day1/quayside.csv'), marked);
  assert.equal(mapRow(rows[4].raw, marked).listing.monthly_price, 147.99);
  const below = mapRow(rows[4].raw, { ...marked, markup: { add: -500 } });
  assert.deepEqual(below.problems.map((p) => p.problem), ['price after markup is not a positive number']);
});

test('a markup change updates every price once, then nothing', () => {
  const table = [];
  run(table, 'quayside', feed('day1/quayside.csv'), 'R1');
  const marked = { ...source('quayside'), markup: { percent: 10 } };
  const first = planSync({ source: marked, fetchResult: ok(feed('day1/quayside.csv')), existing: table, runId: 'M1' });
  assert.equal(first.summary.updated, first.summary.feedRows - first.summary.rowErrors);
  apply(table, first);
  const again = planSync({ source: marked, fetchResult: ok(feed('day1/quayside.csv')), existing: table, runId: 'M2' });
  assert.deepEqual([again.summary.updated, again.writes.length], [0, 0]);
});

test('bad markup settings are refused', () => {
  const issues = (markup) => checkSource({ ...source('quayside'), markup });
  assert.deepEqual(issues({ percent: 30, add: 1.5, round: 'whole' }), []);
  assert.equal(issues({ percent: '30' }).length, 1);
  assert.equal(issues({ percent: -100 }).length, 1);
  assert.equal(issues({ round: 'up' }).length, 1);
  assert.equal(issues({ margin: 30 }).length, 1);
  assert.equal(issues(30).length, 1);
});

test('Google Sheets links become the CSV export', () => {
  const sheet = (url, format = 'csv') => ({ ...source('quayside'), url, format });
  const id = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
  assert.equal(feedUrl(sheet(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing`)), `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`);
  assert.equal(feedUrl(sheet(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=1234`)), `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=1234`);
  assert.equal(feedUrl(sheet(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=55#gid=55`)), `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=55`);
  const published = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vQabcdefghijklmnopqrstuvwxyz/pub?output=csv';
  assert.equal(feedUrl(sheet(published)), published);
  assert.equal(feedUrl(source('quayside')), 'http://feeds:8080/feeds/quayside');
  assert.deepEqual(checkFetch(sheet(`https://docs.google.com/spreadsheets/d/${id}/edit`, 'xml')).length, 1);
  assert.deepEqual(checkFetch(sheet(`https://docs.google.com/spreadsheets/d/${id}/edit`)), []);
});

test('a Google Sheets CSV export syncs, a sign-in page stops the source', () => {
  // Sheets exports CRLF line ends, no BOM, and quotes only fields that need it.
  const csv = feed('day1/quayside.csv').replace(/\r?\n/g, '\r\n');
  const plan = planSync({ source: source('quayside'), fetchResult: ok(csv), existing: [], runId: 'GS1' });
  assert.equal(plan.summary.created, 10);
  const signIn = planSync({ source: source('quayside'), fetchResult: ok('<!doctype html><html lang="en"><head><title>Sign in</title>'), existing: [], runId: 'GS2' });
  assert.equal(signIn.outcome, 'Feed unavailable');
});

test('feed auth: header, bearer, basic and query', () => {
  const secrets = { SUPPLIER_KEY: 'k3y/with+chars', SUPPLIER_PASSWORD: 'pässword' };
  const secretFor = (name) => secrets[name] || '';
  const withAuth = (auth, url = 'https://feeds.example.com/stock.csv') => ({ ...source('quayside'), url, auth });
  assert.deepEqual(feedRequest(source('quayside'), secretFor), { url: 'http://feeds:8080/feeds/quayside', headers: {}, secrets: [] });
  assert.deepEqual(feedRequest(withAuth({ type: 'header', name: 'X-API-Key', secret: 'SUPPLIER_KEY' }), secretFor).headers, { 'X-API-Key': 'k3y/with+chars' });
  assert.deepEqual(feedRequest(withAuth({ type: 'bearer', secret: 'SUPPLIER_KEY' }), secretFor).headers, { Authorization: 'Bearer k3y/with+chars' });
  const basic = feedRequest(withAuth({ type: 'basic', user: 'larkspur', secret: 'SUPPLIER_PASSWORD' }), secretFor);
  assert.equal(basic.headers.Authorization, `Basic ${Buffer.from('larkspur:pässword').toString('base64')}`);
  const query = feedRequest(withAuth({ type: 'query', name: 'api_key', secret: 'SUPPLIER_KEY' }, 'https://feeds.example.com/stock?day=1'), secretFor);
  assert.equal(query.url, 'https://feeds.example.com/stock?day=1&api_key=k3y%2Fwith%2Bchars');
  assert.throws(() => feedRequest(withAuth({ type: 'header', name: 'X-API-Key', secret: 'MISSING_KEY' }), secretFor), /MISSING_KEY is not set/);
  for (const text of ['', 'a', 'ab', 'abc', 'abcd', 'é漢']) assert.equal(base64(text), Buffer.from(text).toString('base64'));
});

test('feed auth: secrets stay out of notes', () => {
  const request = feedRequest({ ...source('quayside'), url: 'https://feeds.example.com/s', auth: { type: 'query', name: 'key', secret: 'SUPPLIER_KEY' } }, () => 'top secret');
  assert.equal(redact('GET https://feeds.example.com/s?key=top%20secret failed (top secret)', request.secrets), 'GET https://feeds.example.com/s?key=*** failed (***)');
  const plan = planSync({ source: source('quayside'), fetchResult: { error: 'secret SUPPLIER_KEY is not set' }, existing: [], runId: 'A1' });
  assert.equal(plan.outcome, 'Feed unavailable');
  assert.match(plan.notes[0], /SUPPLIER_KEY is not set/);
});

test('feed auth: bad settings are refused', () => {
  const issues = (auth, url = 'https://feeds.example.com/s') => checkFetch({ ...source('quayside'), url, auth });
  assert.deepEqual(issues({ type: 'header', name: 'X-API-Key', secret: 'SUPPLIER_KEY' }), []);
  assert.deepEqual(issues({ type: 'basic', user: 'larkspur', secret: 'SUPPLIER_PASSWORD' }), []);
  assert.equal(issues({ type: 'header', secret: 'SUPPLIER_KEY' }).length, 1);
  assert.equal(issues({ type: 'header', name: 'X-API-Key', secret: 'sk_live_abc123' }).length, 1);
  assert.equal(issues({ type: 'basic', secret: 'SUPPLIER_PASSWORD' }).length, 1);
  assert.equal(issues({ type: 'oauth', secret: 'SUPPLIER_KEY' }).length, 1);
  assert.equal(issues({ type: 'bearer', secret: 'SUPPLIER_KEY', password: 'x' }).length, 1);
  assert.equal(issues({ type: 'bearer', secret: 'SUPPLIER_KEY' }, 'http://feeds.example.com/s').length, 1);
  const plan = planSync({ source: { ...source('quayside'), auth: { type: 'bearer' } }, fetchResult: ok(feed('day1/quayside.csv')), existing: [], runId: 'A2' });
  assert.equal(plan.outcome, 'Mapping file error');
});

test('sftp sources: a path instead of a url, login in the credential', () => {
  const { url, ...rest } = source('quayside');
  const sftp = (changes) => [...checkSource({ ...rest, transport: 'sftp', path: '/feeds/day1/quayside.csv', ...changes }), ...checkFetch({ ...rest, transport: 'sftp', path: '/feeds/day1/quayside.csv', ...changes })];
  assert.deepEqual(sftp({}), []);
  assert.deepEqual(feedRequest({ ...rest, transport: 'sftp', path: '/x.csv' }, () => ''), { url: '', headers: {}, secrets: [] });
  assert.equal(sftp({ path: 'feeds/stock.csv' }).length, 1);
  assert.equal(sftp({ path: undefined }).length, 1);
  assert.equal(sftp({ url: 'sftp://host/x.csv' }).length, 1);
  assert.equal(sftp({ auth: { type: 'basic', user: 'a', secret: 'SUPPLIER_PASSWORD' } }).length, 1);
  assert.equal(checkFetch({ ...source('quayside'), transport: 'ftp' }).length, 1);
  assert.deepEqual(checkSource(rest), ['missing "url"']);
});

test('feed auth: a bad setting never sends the key', () => {
  const sent = (auth, url = 'https://feeds.example.com/s') => () => feedRequest({ ...source('quayside'), url, auth }, () => 'top secret');
  assert.throws(sent({ type: 'Bearer', secret: 'SUPPLIER_KEY' }), FeedRequestError);
  assert.throws(sent({ type: 'header', secret: 'SUPPLIER_KEY' }), FeedRequestError);
  assert.throws(sent({ type: 'bearer', secret: 'SUPPLIER_KEY' }, 'http://feeds.example.com/s'), FeedRequestError);
  assert.throws(sent({ type: 'bearer', secret: 'SUPPLIER_KEY' }, 'http://localhost:80@feeds.example.com/s'), FeedRequestError);
  assert.throws(sent({ type: 'bearer', secret: 'AKIAIOSFODNN7EXAMPLE' }), FeedRequestError);
  assert.doesNotThrow(sent({ type: 'bearer', secret: 'SUPPLIER_KEY' }, 'http://feeds:8080/feeds/quayside'));
  const plan = planSync({ source: { ...source('quayside'), url: 'https://feeds.example.com/s', auth: { type: 'bearer', secret: 'AKIAIOSFODNN7EXAMPLE' } }, fetchResult: { error: 'mapping has fetch settings problems' }, existing: [], runId: 'A3' });
  assert.equal(plan.outcome, 'Mapping file error');
  assert.ok(!JSON.stringify(plan).includes('AKIAIOSFODNN7EXAMPLE'));
});

test('Google Sheets links from a second signed-in account', () => {
  const id = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
  assert.equal(feedUrl({ url: `https://docs.google.com/spreadsheets/u/1/d/${id}/edit#gid=5` }), `https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=5`);
});

test('R1 creates, R2 changes nothing', () => {
  const table = [];
  const r1 = run(table, 'northgate', feed('day1/northgate.xml'), 'R1');
  assert.equal(r1.summary.created, 12);
  const r2 = run(table, 'northgate', feed('day1/northgate.xml'), 'R2');
  assert.deepEqual([r2.summary.created, r2.summary.updated, r2.summary.unchanged, r2.writes.length], [0, 0, 12, 0]);
  assert.equal(table.length, 12);
});

test('R3 touches only what changed', () => {
  const table = [];
  run(table, 'northgate', feed('day1/northgate.xml'), 'R1');
  const r3 = run(table, 'northgate', feed('day3/northgate.xml'), 'R3');
  assert.deepEqual(
    [r3.summary.created, r3.summary.updated, r3.summary.closed, r3.summary.unchanged],
    [1, 1, 2, 9],
  );
  assert.equal(table.find((r) => r.fields['Listing key'] === 'northgate:NG-105').fields['Close reason'], 'Rented');
  assert.equal(table.find((r) => r.fields['Listing key'] === 'northgate:NG-108').fields['Close reason'], 'Missing from feed');
});

test('broken rows are named and their listings stay as they were', () => {
  const table = [];
  run(table, 'quayside', feed('day1/quayside.csv'), 'R1');
  const r3 = run(table, 'quayside', feed('day3/quayside.csv'), 'R3');
  assert.equal(r3.outcome, 'OK with row errors');
  assert.equal(r3.summary.rowErrors, 4);
  assert.deepEqual([...new Set(r3.rowErrors.map((e) => e.ref))].sort(), ['Q-04', 'Q-07', 'Q-09']);
  assert.equal(r3.summary.closed, 0);
  assert.equal(r3.summary.unchanged, 7);
  for (const ref of ['Q-04', 'Q-07', 'Q-09']) assert.equal(status(table, listingKey('quayside', ref)), 'Active');
});

test('feed down: nothing closed', () => {
  const table = [];
  run(table, 'northgate', feed('day1/northgate.xml'), 'R1');
  const down = run(table, 'northgate', { statusCode: 503, body: 'Service Unavailable' }, 'R4');
  assert.equal(down.outcome, 'Feed unavailable');
  assert.equal(down.writes.length, 0);
  assert.equal(down.alerts.length, 1);
  const empty = run(table, 'northgate', ok('<?xml version="1.0"?><feed></feed>'), 'R4b');
  assert.equal(empty.outcome, 'Feed unavailable');
  assert.ok(table.every((r) => r.fields.Status === 'Active'));
});

// quayside day1: 10 live listings, Q-01 to Q-10, one line each.
const quayLines = () => feed('day1/quayside.csv').trim().split(/\r?\n/);
const quayFeed = (pick) => { const [header, ...lines] = quayLines(); return [header, ...pick(lines)].join('\n'); };
const startQuay = () => { const table = []; run(table, 'quayside', feed('day1/quayside.csv'), 'R1'); return table; };

test('an HTML page is refused for CSV, JSON and XML sources', () => {
  const page = ['<!DOCTYPE html>', '<html><head><title>502 Bad Gateway</title></head>', '<body><p>upstream error</p></body></html>'].join('\n');
  const table = startQuay();
  const csv = run(table, 'quayside', ok('﻿\n  ' + page), 'H1');
  assert.equal(csv.outcome, 'Feed unavailable');
  assert.equal(csv.writes.length, 0);
  assert.match(csv.notes[0], /^feed is an HTML page, not CSV\./);
  const json = planSync({ source: source('pinecrest'), fetchResult: ok('<HTML lang="en"><body>Sign in</body></HTML>'), existing: [], runId: 'H2' });
  assert.match(json.notes[0], /^feed is an HTML page, not JSON\./);
  const xml = planSync({ source: source('northgate'), fetchResult: ok('<?xml version="1.0"?>\n' + page), existing: [], runId: 'H3' });
  assert.match(xml.notes[0], /^feed is an HTML page, not XML\./);
  // A real XML feed also starts with "<", and a CSV header may start with a letter after "<".
  assert.equal(isHtmlPage(feed('day1/northgate.xml'), 'xml'), false);
  assert.equal(isHtmlPage('<body>x</body>', 'xml'), false);
  assert.equal(isHtmlPage('<ab>,c\n1,2', 'csv'), false);
  assert.equal(isHtmlPage('<!-- maintenance -->', 'json'), true);
  assert.ok(table.every((r) => r.fields.Status === 'Active'));
});

test('the ref column missing from the feed is named, with the columns the feed has', () => {
  const table = startQuay();
  const renamed = run(table, 'quayside', feed('day1/quayside.csv').replace('Unit ID', 'Unit Code'), 'M1');
  assert.equal(renamed.outcome, 'Feed unavailable');
  assert.equal(renamed.writes.length, 0);
  assert.match(renamed.notes[0], /^mapping field "Unit ID" is not in the feed; the feed has: Unit Code, Unit Name, Category, Size \(sq ft\), Monthly Rate, Neighborhood, Climate, Photo, Availability\./);
  // Wrong delimiter: the whole header is one column.
  const semicolons = run(table, 'quayside', quayFeed((lines) => lines).replace(/,/g, ';'), 'M2');
  assert.match(semicolons.notes[0], /mapping field "Unit ID" is not in the feed; the feed has: Unit ID;Unit Name;/);
  const xml = planSync({ source: source('northgate'), fetchResult: ok(feed('day1/northgate.xml').replace(/<listing ref=/g, '<listing id=')), existing: [], runId: 'M3' });
  assert.match(xml.notes[0], /^mapping field "ref" is not in the feed; the feed has: id, name, unitType, /);
  const wide = planSync({ source: source('quayside'), fetchResult: ok(Array.from({ length: 12 }, (_, i) => `c${i}`).join(',') + '\n' + '1,'.repeat(11) + '1'), existing: [], runId: 'M4' });
  assert.match(wide.notes[0],/the feed has: c0, c1, c2, c3, c4, c5, c6, c7, c8, c9, …\./);
  assert.ok(table.every((r) => r.fields.Status === 'Active'));
});

test('a ref column with no values stops the feed', () => {
  const table = startQuay();
  const blank = run(table, 'quayside', quayFeed((lines) => lines.map((line) => line.replace(/^Q-\d+/, ''))), 'E1');
  assert.equal(blank.outcome, 'Feed unavailable');
  assert.equal(blank.writes.length, 0);
  assert.match(blank.notes[0], /^no row has a value in "Unit ID"\./);
  assert.equal(blank.alerts.length, 1);
  assert.ok(table.every((r) => r.fields.Status === 'Active'));
});

test('a dry run that stops sends no alert but keeps the note', () => {
  const table = startQuay();
  const dry = run(table, 'quayside', ok('<html><body>Not found</body></html>'), 'D1', { mode: 'dry run' });
  assert.equal(dry.outcome, 'Feed unavailable');
  assert.equal(dry.alerts.length, 0);
  assert.equal(dry.notes.length, 1);
  const down = run(table, 'quayside', { statusCode: 500, body: '' }, 'D2', { mode: 'dry run' });
  assert.deepEqual([down.outcome, down.alerts.length], ['Feed unavailable', 0]);
});

test('duplicate refs cannot make a short feed pass the half-of-live check', () => {
  const table = startQuay();
  // 6 rows, but only 3 distinct refs: 7 of 10 live listings would close.
  const padded = run(table, 'quayside', quayFeed((lines) => [...lines.slice(0, 3), ...lines.slice(0, 3)]), 'P1');
  assert.equal(padded.outcome, 'Removals held');
  assert.deepEqual([padded.summary.closed, padded.summary.held], [0, 7]);
  assert.match(padded.notes.join(' '), /7 of 10 live listings are missing from the feed \(only 3 still in it, below 50%\)/);
  assert.equal(status(table, 'quayside:Q-04'), 'Pending removal');
  assert.equal(status(table, 'quayside:Q-01'), 'Active');
});

test('closing exactly half is allowed, one more is held', () => {
  const half = startQuay();
  const five = run(half, 'quayside', quayFeed((lines) => lines.slice(0, 5)), 'B1');
  assert.deepEqual([five.outcome, five.summary.closed, five.summary.held], ['OK', 5, 0]);
  const more = startQuay();
  const six = run(more, 'quayside', quayFeed((lines) => lines.slice(0, 4)), 'B2');
  assert.deepEqual([six.outcome, six.summary.closed, six.summary.held], ['Removals held', 0, 6]);
});

test('new IDs for most listings: nothing created or closed, matching ones still updated', () => {
  const table = startQuay();
  const body = quayFeed((lines) => lines.map((line, i) => (i < 2 ? line : line.replace(/^Q-(\d+)/, 'QS-$1'))).map((line) => line.replace('Locker 3, lower deck",XS,16,$29.00', 'Locker 3, lower deck",XS,16,$31.00')));
  const renumbered = run(table, 'quayside', body, 'I1');
  assert.equal(renumbered.outcome, 'IDs look changed');
  assert.deepEqual([renumbered.summary.created, renumbered.summary.closed, renumbered.summary.updated, renumbered.summary.held], [0, 0, 1, 0]);
  assert.equal(renumbered.writes.length, 1);
  assert.equal(renumbered.notes[0], '8 of 10 live listings are missing from the feed and 8 refs in it are new. No new listings were created and no missing listing was closed; matching listings were updated');
  assert.match(renumbered.alerts[0], /8 old IDs are missing and 8 new IDs appeared\. Check whether the supplier changed its item IDs/);
  assert.equal(table.length, 10);
  assert.ok(table.every((r) => r.fields.Status === 'Active'));
  // Every ID replaced, same count.
  const all = run(table, 'quayside', quayFeed((lines) => lines.map((line) => line.replace(/^Q-(\d+)/, 'QS-$1'))), 'I2');
  assert.deepEqual([all.outcome, all.summary.created, all.summary.closed, all.writes.length], ['IDs look changed', 0, 0, 0]);
});

test('new IDs on broken rows still count, so no half of the new IDs is created', () => {
  const table = startQuay();
  // Every ID replaced, and 6 of the new rows have a price that can't be read.
  const body = quayFeed((lines) => lines.map((line, i) => line.replace(/^Q-(\d+)/, 'QS-$1').replace(i < 6 ? /\$\d+\.\d+/ : /^$/, 'TBD')));
  const plan = run(table, 'quayside', body, 'I3');
  assert.equal(plan.summary.rowErrors, 6);
  assert.deepEqual([plan.outcome, plan.summary.created, plan.summary.closed, plan.summary.held, plan.writes.length], ['IDs look changed', 0, 0, 0, 0]);
  assert.match(plan.notes[0], /10 of 10 live listings are missing from the feed and 10 refs in it are new/);
  assert.equal(table.length, 10);
});

test('IDs look changed still closes a matching unit the feed marks rented, and says so', () => {
  const table = startQuay();
  const body = quayFeed((lines) => lines.map((line, i) => (i === 0 ? line.replace(/Vacant$/, 'Occupied') : i < 2 ? line : line.replace(/^Q-(\d+)/, 'QS-$1'))));
  const plan = run(table, 'quayside', body, 'I4');
  assert.deepEqual([plan.outcome, plan.summary.created, plan.summary.closed], ['IDs look changed', 0, 1]);
  assert.equal(plan.notes[0], '8 of 10 live listings are missing from the feed and 8 refs in it are new. No new listings were created and no missing listing was closed; matching listings were updated; 1 closed because the feed marks them rented or withdrawn');
  assert.match(plan.alerts[0], /No new listings were created and no missing listing was closed this run\.$/);
  assert.equal(status(table, 'quayside:Q-01'), 'Closed');
  assert.equal(status(table, 'quayside:Q-03'), 'Active');
});

test('dry runs send no Slack alert for a bad mapping file either', () => {
  const broken = { ...source('pinecrest'), values: { status: { free: 'open' } } };
  const plan = planSync({ source: broken, fetchResult: ok(feed('day7/pinecrest.json')), existing: [], runId: 'X', mode: 'dry run' });
  assert.deepEqual([plan.outcome, plan.alerts.length, plan.notes.length], ['Mapping file error', 0, 1]);
  // A mapping that isn't valid JSON is handled in the workflow's Plan changes node, not in plan.js.
  for (const file of ['workflows/wfFeedSync.json', 'workflows-cloud/wfFeedSyncCloud.json']) {
    const node = JSON.parse(readFileSync(join(demo, file), 'utf8')).nodes.find((n) => n.name === 'Plan changes');
    assert.match(node.parameters.jsCode, /brokenFile[\s\S]*alerts: job\.mode === 'dry run' \? \[\] : \[/);
  }
});

test('the row errors alert lists a duplicate ref once', () => {
  const table = startQuay();
  const plan = run(table, 'quayside', feed('day3/quayside.csv'), 'R3');
  // 4 bad rows, but the two copies of Q-09 give one line: 3 lines, nothing left out.
  assert.match(plan.alerts[0], /4 row\(s\) skipped, the rest synced\. Q-04: missing price; Q-07: unknown unit type \("Jumbo"\); Q-09: same ref on rows 9 and 11 \("Q-09"\)$/);
});

test('a few renumbered units below the threshold are created and closed as usual', () => {
  const table = startQuay();
  const some = run(table, 'quayside', quayFeed((lines) => lines.map((line, i) => (i < 7 ? line : line.replace(/^Q-(\d+)/, 'QS-$1')))), 'S1');
  assert.deepEqual([some.outcome, some.summary.created, some.summary.closed], ['OK', 3, 3]);
  assert.equal(status(table, 'quayside:Q-10'), 'Closed');
  assert.equal(status(table, 'quayside:QS-10'), 'Active');
});

test('feed shrinks: updates applied, removals held, then restored', () => {
  const table = [];
  run(table, 'northgate', feed('day1/northgate.xml'), 'R1');
  run(table, 'northgate', feed('day3/northgate.xml'), 'R3');
  const r5 = run(table, 'northgate', feed('day5/northgate.xml'), 'R5');
  assert.equal(r5.outcome, 'Removals held');
  assert.deepEqual([r5.summary.updated, r5.summary.held, r5.summary.closed], [1, 7, 0]);
  assert.equal(r5.notes[0], 'feed has 4 rows but 11 listings are live (below 50%). 7 missing listings marked Pending removal, not closed');
  assert.equal(status(table, 'northgate:NG-110'), 'Pending removal');
  const r6 = run(table, 'northgate', feed('day6/northgate.xml'), 'R6');
  assert.deepEqual([r6.summary.restored, r6.summary.reopened, r6.summary.closed, r6.summary.created], [7, 1, 0, 0]);
  assert.equal(status(table, 'northgate:NG-108'), 'Active');
  assert.equal(table.filter((r) => r.fields.Source === 'northgate').length, 13);
});

test('held listings stay held when a later feed is big enough to close', () => {
  const table = [];
  run(table, 'northgate', feed('day1/northgate.xml'), 'R1');
  run(table, 'northgate', feed('day3/northgate.xml'), 'R3');
  run(table, 'northgate', feed('day5/northgate.xml'), 'R5');
  const held = table.filter((r) => r.fields.Status === 'Pending removal').map((r) => r.fields['External ref']);
  const live = table.filter((r) => r.fields.Source === 'northgate' && ['Active', 'Pending removal'].includes(r.fields.Status)).length;
  // A feed with every Active ref plus enough held ones to pass the half-of-live check.
  const keep = new Set([...table.filter((r) => r.fields.Status === 'Active').map((r) => r.fields['External ref']), ...held.slice(0, Math.ceil(live / 2))]);
  const body = feed('day6/northgate.xml').replace(/\s*<listing ref="([^"]+)">[\s\S]*?<\/listing>/g, (m, ref) => (keep.has(ref) ? m : ''));
  const next = run(table, 'northgate', body, 'R5b');
  assert.equal(next.outcome === 'Removals held', false);
  assert.equal(next.summary.closed, 0);
  for (const ref of held.slice(Math.ceil(live / 2))) assert.equal(status(table, listingKey('northgate', ref)), 'Pending removal');
});

test('new source: draft mapping fails the dry run, fixed one passes', () => {
  const draft = JSON.parse(readFileSync(join(demo, 'sample-data', 'onboarding', 'pinecrest.first-draft.json'), 'utf8'));
  const body = feed('day7/pinecrest.json');
  const dry = planSync({ source: draft, fetchResult: ok(body), existing: [], runId: 'R7a', mode: 'dry run' });
  assert.equal(dry.summary.rowErrors, 6);
  assert.deepEqual([...new Set(dry.rowErrors.map((e) => e.field))].sort(), ['monthly_price', 'size', 'status']);
  assert.equal(dry.alerts.length, 0);
  const fixed = planSync({ source: source('pinecrest'), fetchResult: ok(body), existing: [], runId: 'R7b', mode: 'dry run' });
  assert.deepEqual([fixed.summary.rowErrors, fixed.summary.created, fixed.summary.ignored], [0, 5, 1]);
});

test('a bad mapping file is refused before anything runs', () => {
  const broken = { ...source('pinecrest'), values: { status: { free: 'open' } } };
  const plan = planSync({ source: broken, fetchResult: ok(feed('day7/pinecrest.json')), existing: [], runId: 'X' });
  assert.equal(plan.outcome, 'Mapping file error');
  assert.equal(plan.writes.length, 0);
});

test('run records and batching', () => {
  const plan = planSync({ source: source('quayside'), fetchResult: ok(feed('day3/quayside.csv')), existing: [], runId: 'R3' });
  const { run: record, errors } = runRecords(plan);
  assert.equal(record.Run, 'R3/quayside');
  assert.equal(errors.length, plan.rowErrors.length);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2).map((part) => part.length), [2, 2, 1]);
});
