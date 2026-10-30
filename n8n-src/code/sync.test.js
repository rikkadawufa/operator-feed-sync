// node --test n8n-src/code
const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

// The modules share globals the same way they do when inlined into one n8n Code node.
Object.assign(global, require('./parse.js'), require('./map.js'));
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

test('feed shrinks: updates applied, removals held, then restored', () => {
  const table = [];
  run(table, 'northgate', feed('day1/northgate.xml'), 'R1');
  run(table, 'northgate', feed('day3/northgate.xml'), 'R3');
  const r5 = run(table, 'northgate', feed('day5/northgate.xml'), 'R5');
  assert.equal(r5.outcome, 'Removals held');
  assert.deepEqual([r5.summary.updated, r5.summary.held, r5.summary.closed], [1, 7, 0]);
  assert.equal(status(table, 'northgate:NG-110'), 'Pending removal');
  const r6 = run(table, 'northgate', feed('day6/northgate.xml'), 'R6');
  assert.deepEqual([r6.summary.restored, r6.summary.reopened, r6.summary.closed, r6.summary.created], [7, 1, 0, 0]);
  assert.equal(status(table, 'northgate:NG-108'), 'Active');
  assert.equal(table.filter((r) => r.fields.Source === 'northgate').length, 13);
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
