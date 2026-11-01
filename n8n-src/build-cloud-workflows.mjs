// Generates workflows-cloud/*.json: the same sync for n8n Cloud, which allows no file access,
// no require() and no $env in Code nodes. Mapping files live in an Airtable table (Feed Sources),
// the base ID and Slack URL in a Settings node, and each run's plan travels between nodes.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDS, id, stableUuid, at, edge, note, source, code, ifNode, greater, airtableAuth } from './build-workflows.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const outputDir = join(root, '..', 'workflows-cloud');
const BASE = "$('Settings').first().json.airtableBaseId";

const settings = (fields, x, y) => at({
  id: 'settings', name: 'Settings', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [0, 0],
  parameters: { assignments: { assignments: fields.map(([name, value]) => ({ id: `settings-${id(name)}`, name, value, type: 'string' })) }, options: {} },
}, x, y);
const slack = (name, textExpression) => ({
  id: id(name), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0], retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
  parameters: { method: 'POST', url: "={{ $('Settings').first().json.slackWebhookUrl }}", sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify({ text: ${textExpression} }) }}`, options: {} },
});
const airtableList = (name, table, query, x, y) => at({
  id: id(name), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0],
  retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, credentials: CREDS.airtable, alwaysOutputData: true,
  parameters: {
    method: 'GET', url: `={{ 'https://api.airtable.com/v0/' + ${BASE} + '/${table}' }}`, ...airtableAuth,
    sendQuery: true, queryParameters: { parameters: [...query, { name: 'pageSize', value: '100' }] },
    options: { pagination: { pagination: {
      parameters: { parameters: [{ type: 'qs', name: 'offset', value: '={{ $response.body.offset }}' }] },
      paginationCompleteWhen: 'other', completeExpression: '={{ !$response.body.offset }}', limitPagesFetched: true, maxRequests: 50,
    } } },
  },
}, x, y);
const workflow = (wfId, name, nodes, connections, extraSettings = {}) => ({
  id: wfId, name, active: false, settings: { executionOrder: 'v1', ...extraSettings }, nodes, connections, pinData: {}, versionId: '1',
});

function feedSync() {
  const nodes = [
    note('About', '## Feed sync (n8n Cloud)\nReads every enabled row of the **Feed Sources** table (one mapping per supplier), maps each feed to the listing format, and keeps the **Listings** table in step: create, update, close, reopen. One source at a time; a broken feed or row never stops the others.\n\nFill in **Settings** once. The webhook is for on-demand runs; turn on the schedule for production.', -340, -260, 900, 220, 7),
    note('Safety', '## Safety rules (in **Plan changes**)\n- Feed down, empty or unreadable: nothing changes for that source.\n- Feed far smaller than what is live: updates go through, removals are **held** as Pending removal.\n- Bad row: skipped and named in Row Errors; its listing is not closed.\n- If current listings can\'t be read, the run stops instead of creating duplicates.', 760, -260, 900, 220, 5),
    at({ id: 'run-now', name: 'Run now (webhook)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: stableUuid('feed-sync-cloud'), parameters: { httpMethod: 'POST', path: 'feed-sync', responseMode: 'responseNode', options: {} } }, -440, 100),
    at({ id: 'every-6-hours', name: 'Every 6 hours', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0], disabled: true, parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 6 }] } } }, -440, 300),
    settings([['airtableBaseId', 'appXXXXXXXXXXXXXX'], ['slackWebhookUrl', 'https://hooks.slack.com/services/XXX']], -220, 200),
    airtableList('Read feed sources', 'Feed%20Sources', [], 0, 200),
    at(code('Load sources', `const trigger = $('Run now (webhook)').isExecuted ? $('Run now (webhook)').first().json : {};
const body = trigger.body || {};
const runId = String(body.run || new Date().toISOString().slice(0, 16).replace(':', ''));
if (!/^[A-Za-z0-9._-]{1,40}$/.test(runId)) throw new Error('run id may only use letters, digits, dot, dash and underscore');
const mode = body.mode === 'dry run' ? 'dry run' : 'live';
const only = Array.isArray(body.sources) ? body.sources : null;
const rows = $input.all().flatMap((item) => item.json.records || []);
const sources = rows.map((record) => {
  const sourceId = String(record.fields.Source || '').trim();
  const configLabel = 'Feed Sources row "' + sourceId + '"';
  try { return { ...JSON.parse(record.fields.Mapping || ''), id: sourceId, enabled: record.fields.Enabled === true, configLabel }; }
  catch (error) { return { id: sourceId, name: sourceId, enabled: record.fields.Enabled === true, configLabel, brokenFile: error.message }; }
}).filter((s) => s.id).sort((a, b) => a.id.localeCompare(b.id));
const picked = sources.filter((s) => (only ? only.includes(s.id) : s.enabled));
if (!picked.length) throw new Error('no sources to run' + (only ? ': ' + only.join(', ') : ''));
return picked.map((s) => ({ json: { runId, mode, source: s } }));`), 220, 200),
    at({ id: 'each-source', name: 'Each source', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [0, 0], parameters: { batchSize: 1, options: {} } }, 440, 200),
    at({
      id: 'fetch-feed', name: 'Fetch feed', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0],
      retryOnFail: true, maxTries: 2, waitBetweenTries: 3000, onError: 'continueRegularOutput',
      parameters: { method: 'GET', url: "={{ $json.source.url || 'http://invalid.local/' }}", options: { timeout: 15000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'text' } } } },
    }, 680, 100),
    airtableList('Read current listings', 'Listings', [{ name: 'filterByFormula', value: "={{ \"{Source}='\" + $('Each source').first().json.source.id + \"'\" }}" }], 900, 100),
    at(code('Plan changes', `${source('parse', 'map', 'plan')}

const job = $('Each source').first().json;
const response = $('Fetch feed').first().json;
const fetchResult = response.error
  ? { error: String(response.error.message || response.error).slice(0, 200) }
  : (() => {
      // With responseFormat "text" n8n puts the body in \`data\`; keep \`body\` as a fallback.
      const raw = response.data !== undefined ? response.data : response.body;
      return { statusCode: response.statusCode, body: raw == null ? '' : (typeof raw === 'string' ? raw : JSON.stringify(raw)) };
    })();
const existing = $input.all().flatMap((item) => item.json.records || []);
const plan = job.source.brokenFile
  ? { source: job.source.id, runId: job.runId, mode: job.mode, outcome: 'Mapping file error', summary: { feedRows: 0, created: 0, updated: 0, unchanged: 0, closed: 0, reopened: 0, restored: 0, held: 0, rowErrors: 0, ignored: 0 }, writes: [], rowErrors: [], notes: [job.source.configLabel + ': Mapping is not valid JSON: ' + job.source.brokenFile], alerts: [':warning: ' + job.source.id + ': mapping is not valid JSON, source skipped'] }
  : planSync({ source: job.source, fetchResult, existing, runId: job.runId, mode: job.mode });
const { run, errors } = runRecords(plan);

// One item per Airtable request, in order: listings first, then the run log.
// The plan rides on the first item so later nodes can read it without a file.
const requests = [];
if (plan.mode === 'live') {
  for (const batch of chunk(plan.writes, 10)) requests.push({ method: 'PATCH', table: 'Listings', body: { performUpsert: { fieldsToMergeOn: ['Listing key'] }, typecast: true, records: batch.map((fields) => ({ fields })) } });
}
requests.push({ method: 'POST', table: 'Sync Runs', body: { typecast: true, records: [{ fields: run }] } });
for (const batch of chunk(errors, 10)) requests.push({ method: 'POST', table: 'Row Errors', body: { typecast: true, records: batch.map((fields) => ({ fields })) } });
const { writes, ...kept } = plan;
requests[0].plan = { ...kept, writesPlanned: writes.length, existingBefore: existing.length };
return requests.map((request) => ({ json: request }));`), 1120, 100),
    at({
      id: 'write-to-airtable', name: 'Write to Airtable', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0],
      retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, credentials: CREDS.airtable,
      parameters: {
        method: '={{ $json.method }}', url: `={{ 'https://api.airtable.com/v0/' + ${BASE} + '/' + encodeURIComponent($json.table) }}`, ...airtableAuth,
        sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}',
        // Airtable allows 5 requests per second per base.
        options: { batching: { batch: { batchSize: 1, batchInterval: 250 } } },
      },
    }, 1340, 100),
    at(code('Collect alerts', `return [{ json: $('Plan changes').first().json.plan }];`, { executeOnce: true }), 1560, 100),
    at(ifNode('Any alerts?', '={{ $json.alerts.length }}', greater, 0), 1780, 100),
    at(slack('Send alert', "'[' + $('Each source').first().json.runId + '] ' + $json.alerts.join('\\n')"), 2000, 0),
    at(code('Build report', `// Collect alerts ran once per source; read each loop pass by its run index.
const runId = $('Load sources').first().json.runId;
const plans = $('Load sources').all().map((_, i) => $('Collect alerts').all(0, i)[0].json);
const cols = ['feedRows', 'created', 'updated', 'unchanged', 'closed', 'reopened', 'restored', 'held', 'rowErrors'];
const lines = ['Run ' + runId + ' (' + plans[0].mode + ')', '', 'source      outcome              ' + cols.join(' ')];
for (const p of plans) lines.push(p.source.padEnd(12) + p.outcome.padEnd(21) + cols.map((c) => String(p.summary[c]).padStart(c.length)).join(' '));
for (const p of plans) for (const n of p.notes) lines.push('  ' + p.source + ': ' + n);
return [{ json: { runId, mode: plans[0].mode, sources: plans.map((p) => ({ source: p.source, outcome: p.outcome, summary: p.summary, notes: p.notes, rowErrors: p.rowErrors })), text: lines.join('\\n') + '\\n' } }];`), 680, 380),
    at({ id: 'reply', name: 'Reply with report', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [0, 0], parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} } }, 900, 380),
  ];
  return workflow('wfFeedSyncCloud', 'Feed sync (Cloud): supplier feeds to Listings', nodes, {
    'Run now (webhook)': { main: [[edge('Settings')]] },
    'Every 6 hours': { main: [[edge('Settings')]] },
    Settings: { main: [[edge('Read feed sources')]] },
    'Read feed sources': { main: [[edge('Load sources')]] },
    'Load sources': { main: [[edge('Each source')]] },
    'Each source': { main: [[edge('Build report')], [edge('Fetch feed')]] },
    'Fetch feed': { main: [[edge('Read current listings')]] },
    'Read current listings': { main: [[edge('Plan changes')]] },
    'Plan changes': { main: [[edge('Write to Airtable')]] },
    'Write to Airtable': { main: [[edge('Collect alerts')]] },
    'Collect alerts': { main: [[edge('Any alerts?')]] },
    'Any alerts?': { main: [[edge('Send alert')], [edge('Each source')]] },
    'Send alert': { main: [[edge('Each source')]] },
    'Build report': { main: [[edge('Reply with report')]] },
  });
}

function errorHandler() {
  const nodes = [
    note('About', '## Error handler (n8n Cloud)\nIf the feed sync itself fails (for example Airtable can\'t be read or written), Slack gets the node name and message, and the run stops before anything is guessed.\n\nFill in **Settings**, then pick this workflow as the Error Workflow in the feed sync\'s settings.', -80, -100, 900, 180, 1),
    at({ id: 'error-trigger', name: 'Error trigger', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 0], parameters: {} }, 0, 200),
    settings([['slackWebhookUrl', 'https://hooks.slack.com/services/XXX']], 220, 200),
    at(code('Format alert', `const e = $('Error trigger').first().json;
const node = (e.execution && e.execution.lastNodeExecuted) || 'unknown node';
const message = String((e.execution && e.execution.error && e.execution.error.message) || 'no message').replace(/pat[A-Za-z0-9.]{20,}/g, '***').slice(0, 300);
return [{ json: { text: ':rotating_light: Feed sync stopped at "' + node + '": ' + message + '. No further sources were processed in this run.' } }];`), 440, 200),
    at(slack('Send alert', '$json.text'), 660, 200),
  ];
  return workflow('wfSyncErrorsCloud', 'Feed sync (Cloud): error handler', nodes, {
    'Error trigger': { main: [[edge('Settings')]] },
    Settings: { main: [[edge('Format alert')]] },
    'Format alert': { main: [[edge('Send alert')]] },
  });
}

// Test only: stands in for the supplier feed URLs on n8n Cloud, which can't reach a local feed server.
// GET /webhook/<id>/feeds/<source> answers with that source's row in the Test Feeds table.
function testFeeds() {
  const nodes = [
    note('About', '## Test feeds (testing only)\nServes the simulated supplier feeds for `scripts/run_scenarios.py --cloud --feeds-table`. The runner writes what each feed answers today into the **Test Feeds** table before each run. Not part of the delivered sync.', -80, -120, 760, 160, 3),
    at({ id: 'feed-url', name: 'Feed URL', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: stableUuid('feed-sync-test-feeds'), parameters: { httpMethod: 'GET', path: 'feeds/:source', responseMode: 'responseNode', options: {} } }, 0, 100),
    settings([['airtableBaseId', 'appXXXXXXXXXXXXXX']], 220, 100),
    airtableList('Read test feed', 'Test%20Feeds', [{ name: 'filterByFormula', value: "={{ \"{Source}='\" + $('Feed URL').first().json.params.source + \"'\" }}" }], 440, 100),
    at(code('Pick answer', `const record = $input.all().flatMap((item) => item.json.records || [])[0];
if (!record) return [{ json: { status: 404, type: 'text/plain', body: 'Unknown feed' } }];
return [{ json: { status: record.fields.Status || 200, type: record.fields['Content type'] || 'text/plain', body: record.fields.Body || '' } }];`), 660, 100),
    at({ id: 'answer', name: 'Answer', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [0, 0], parameters: { respondWith: 'text', responseBody: '={{ $json.body }}', options: { responseCode: '={{ $json.status }}', responseHeaders: { entries: [{ name: 'Content-Type', value: '={{ $json.type }}' }] } } } }, 880, 100),
  ];
  return workflow('wfTestFeeds', 'Feed sync (Cloud): test feeds', nodes, {
    'Feed URL': { main: [[edge('Settings')]] },
    Settings: { main: [[edge('Read test feed')]] },
    'Read test feed': { main: [[edge('Pick answer')]] },
    'Pick answer': { main: [[edge('Answer')]] },
  });
}

function buildCloudWorkflows(destination = outputDir) {
  const workflows = [feedSync(), errorHandler()];
  mkdirSync(join(destination, 'test'), { recursive: true });
  for (const item of workflows) writeFileSync(join(destination, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`, 'utf8');
  const test = testFeeds();
  writeFileSync(join(destination, 'test', `${test.id}.json`), `${JSON.stringify(test, null, 2)}\n`, 'utf8');
  return [...workflows, test];
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const built = buildCloudWorkflows();
  console.log(`Wrote ${built.length} workflows: ${built.map((item) => item.id).join(', ')}`);
}
export { buildCloudWorkflows };
