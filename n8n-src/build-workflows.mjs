// Generates workflows/*.json. Code-node logic lives in n8n-src/code/*.js so it can be unit tested.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = dirname(fileURLToPath(import.meta.url));
const outputDir = join(root, '..', 'workflows');
const CREDS = { airtable: { airtableTokenApi: { id: 'airtableTokenCred01', name: 'Airtable (demo base)' } } };

const id = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const stableUuid = (value) => createHash('sha1').update(value).digest('hex').slice(0, 32).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
const at = (node, x, y) => ({ ...node, position: [x, y] });
const edge = (node, index = 0) => ({ node, type: 'main', index });
const note = (name, content, x, y, width, height, color) => ({ id: `note-${id(name)}`, name, type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [x, y], parameters: { content, width, height, color } });

// Strip the CommonJS export line so the module bodies can be inlined into a Code node.
const source = (...names) => names.map((name) => readFileSync(join(root, 'code', `${name}.js`), 'utf8').replace(/^if \(typeof module !== 'undefined'\).*$/m, '').trim()).join('\n\n');

const code = (name, jsCode, extra = {}) => ({ id: id(name), name, type: 'n8n-nodes-base.code', typeVersion: 2, position: [0, 0], parameters: { jsCode }, ...extra });
const ifNode = (name, leftValue, operator, rightValue = '') => ({
  id: id(name), name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [0, 0],
  parameters: { conditions: { options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: [{ id: `${id(name)}-condition`, leftValue, rightValue, operator }], combinator: 'and' }, options: {} },
});
const greater = { type: 'number', operation: 'gt' };
const slack = (name, textExpression) => ({
  id: id(name), name, type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0], retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
  parameters: { method: 'POST', url: '={{ $env.SLACK_WEBHOOK_URL }}', sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify({ text: ${textExpression} }) }}`, options: {} },
});
const airtableAuth = { authentication: 'predefinedCredentialType', nodeCredentialType: 'airtableTokenApi' };
const workflow = (wfId, name, nodes, connections, errorWorkflow = true) => ({
  id: wfId, name, active: false,
  settings: { executionOrder: 'v1', ...(errorWorkflow ? { errorWorkflow: 'wfSyncErrors' } : {}) },
  nodes, connections, pinData: {}, versionId: '1',
});

function feedSync() {
  const nodes = [
    note('About', '## Feed sync\nReads each operator feed listed in `sources/*.json`, maps it to the listing format, and keeps the **Listings** table in step: create, update, close, reopen. One source at a time; a broken feed or row never stops the others.\n\nThe webhook is for on-demand runs and the test runner. In production the schedule replaces it.', -120, -260, 820, 220, 7),
    note('Safety', '## Safety rules (in **Plan changes**)\n- Feed down, empty or unreadable: nothing changes for that source.\n- Feed far smaller than what is live: updates go through, removals are **held** as Pending removal.\n- Bad row: skipped and named in Row Errors; its listing is not closed.\n- If current listings can\'t be read, the run stops instead of creating duplicates.', 760, -260, 900, 220, 5),
    at({ id: 'run-now', name: 'Run now (webhook)', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [0, 0], webhookId: stableUuid('feed-sync'), parameters: { httpMethod: 'POST', path: 'feed-sync', responseMode: 'responseNode', options: {} } }, 0, 100),
    at({ id: 'every-6-hours', name: 'Every 6 hours', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [0, 0], disabled: true, parameters: { rule: { interval: [{ field: 'hours', hoursInterval: 6 }] } } }, 0, 300),
    at(code('Load sources', `const fs = require('fs');
const body = ($input.first().json.body) || {};
const runId = String(body.run || new Date().toISOString().slice(0, 16).replace(':', ''));
if (!/^[A-Za-z0-9._-]{1,40}$/.test(runId)) throw new Error('run id may only use letters, digits, dot, dash and underscore');
const mode = body.mode === 'dry run' ? 'dry run' : 'live';
const only = Array.isArray(body.sources) ? body.sources : null;
const dir = '/files/sources';
const sources = fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort().map((file) => {
  try { return JSON.parse(fs.readFileSync(dir + '/' + file, 'utf8')); }
  catch (error) { return { id: file.replace(/\\.json$/, ''), name: file, brokenFile: error.message }; }
});
const picked = sources.filter((s) => (only ? only.includes(s.id) : s.enabled !== false));
if (!picked.length) throw new Error('no sources to run' + (only ? ': ' + only.join(', ') : ''));
fs.mkdirSync('/files/output/runs/' + runId, { recursive: true });
return picked.map((s) => ({ json: { runId, mode, source: s } }));`), 220, 200),
    at({ id: 'each-source', name: 'Each source', type: 'n8n-nodes-base.splitInBatches', typeVersion: 3, position: [0, 0], parameters: { batchSize: 1, options: {} } }, 440, 200),
    at({
      id: 'fetch-feed', name: 'Fetch feed', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0],
      retryOnFail: true, maxTries: 2, waitBetweenTries: 3000, onError: 'continueRegularOutput',
      parameters: { method: 'GET', url: "={{ $json.source.url || 'http://invalid.local/' }}", options: { timeout: 15000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'text' } } } },
    }, 680, 100),
    at({
      id: 'read-current-listings', name: 'Read current listings', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0],
      retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, credentials: CREDS.airtable, alwaysOutputData: true,
      parameters: {
        method: 'GET', url: "={{ 'https://api.airtable.com/v0/' + $env.AIRTABLE_BASE_ID + '/Listings' }}", ...airtableAuth,
        sendQuery: true, queryParameters: { parameters: [
          { name: 'filterByFormula', value: "={{ \"{Source}='\" + $('Each source').first().json.source.id + \"'\" }}" },
          { name: 'pageSize', value: '100' },
        ] },
        options: { pagination: { pagination: {
          parameters: { parameters: [{ type: 'qs', name: 'offset', value: '={{ $response.body.offset }}' }] },
          paginationCompleteWhen: 'other', completeExpression: '={{ !$response.body.offset }}', limitPagesFetched: true, maxRequests: 50,
        } } },
      },
    }, 900, 100),
    at(code('Plan changes', `${source('parse', 'map', 'plan')}

const fs = require('fs');
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
  ? { source: job.source.id, runId: job.runId, mode: job.mode, outcome: 'Mapping file error', summary: { feedRows: 0, created: 0, updated: 0, unchanged: 0, closed: 0, reopened: 0, restored: 0, held: 0, rowErrors: 0, ignored: 0 }, writes: [], rowErrors: [], notes: ['sources/' + job.source.id + '.json is not valid JSON: ' + job.source.brokenFile], alerts: [':warning: ' + job.source.id + ': mapping file is not valid JSON, source skipped'] }
  : planSync({ source: job.source, fetchResult, existing, runId: job.runId, mode: job.mode });
const { run, errors } = runRecords(plan);
fs.writeFileSync('/files/output/runs/' + job.runId + '/' + job.source.id + '.json', JSON.stringify({ ...plan, existingBefore: existing.length }, null, 2), 'utf8');

// One item per Airtable request, in order: listings first, then the run log.
const requests = [];
if (plan.mode === 'live') {
  for (const batch of chunk(plan.writes, 10)) requests.push({ method: 'PATCH', table: 'Listings', body: { performUpsert: { fieldsToMergeOn: ['Listing key'] }, typecast: true, records: batch.map((fields) => ({ fields })) } });
}
requests.push({ method: 'POST', table: 'Sync Runs', body: { typecast: true, records: [{ fields: run }] } });
for (const batch of chunk(errors, 10)) requests.push({ method: 'POST', table: 'Row Errors', body: { typecast: true, records: batch.map((fields) => ({ fields })) } });
return requests.map((request) => ({ json: request }));`), 1120, 100),
    at({
      id: 'write-to-airtable', name: 'Write to Airtable', type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, position: [0, 0],
      retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, credentials: CREDS.airtable,
      parameters: {
        method: '={{ $json.method }}', url: "={{ 'https://api.airtable.com/v0/' + $env.AIRTABLE_BASE_ID + '/' + encodeURIComponent($json.table) }}", ...airtableAuth,
        sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.body) }}',
        // Airtable allows 5 requests per second per base.
        options: { batching: { batch: { batchSize: 1, batchInterval: 250 } } },
      },
    }, 1340, 100),
    at(code('Collect alerts', `const job = $('Each source').first().json;
const plan = JSON.parse(require('fs').readFileSync('/files/output/runs/' + job.runId + '/' + job.source.id + '.json', 'utf8'));
return [{ json: { source: plan.source, outcome: plan.outcome, alerts: plan.alerts } }];`, { executeOnce: true }), 1560, 100),
    at(ifNode('Any alerts?', '={{ $json.alerts.length }}', greater, 0), 1780, 100),
    at(slack('Send alert', "'[' + $('Each source').first().json.runId + '] ' + $json.alerts.join('\\n')"), 2000, 0),
    at(code('Build report', `const fs = require('fs');
const runId = $('Load sources').first().json.runId;
const dir = '/files/output/runs/' + runId;
const plans = $('Load sources').all().map((item) => JSON.parse(fs.readFileSync(dir + '/' + item.json.source.id + '.json', 'utf8')));
const cols = ['feedRows', 'created', 'updated', 'unchanged', 'closed', 'reopened', 'restored', 'held', 'rowErrors'];
const lines = ['Run ' + runId + ' (' + plans[0].mode + ')', '', 'source      outcome              ' + cols.join(' ')];
for (const p of plans) lines.push(p.source.padEnd(12) + p.outcome.padEnd(21) + cols.map((c) => String(p.summary[c]).padStart(c.length)).join(' '));
for (const p of plans) for (const n of p.notes) lines.push('  ' + p.source + ': ' + n);
const report = { runId, mode: plans[0].mode, sources: plans.map((p) => ({ source: p.source, outcome: p.outcome, summary: p.summary, notes: p.notes, rowErrors: p.rowErrors })) };
fs.writeFileSync(dir + '/report.txt', lines.join('\\n') + '\\n', 'utf8');
fs.writeFileSync(dir + '/report.json', JSON.stringify(report, null, 2), 'utf8');
return [{ json: report }];`), 680, 380),
    at({ id: 'reply', name: 'Reply with report', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [0, 0], parameters: { respondWith: 'json', responseBody: '={{ JSON.stringify($json) }}', options: {} } }, 900, 380),
  ];
  return workflow('wfFeedSync', 'Feed sync: operator feeds to Listings', nodes, {
    'Run now (webhook)': { main: [[edge('Load sources')]] },
    'Every 6 hours': { main: [[edge('Load sources')]] },
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
    note('About', '## Error handler\nIf the feed sync itself fails (for example Airtable can\'t be read or written), Slack gets the node name and message, and the run stops before anything is guessed.', -80, -60, 900, 140, 1),
    at({ id: 'error-trigger', name: 'Error trigger', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 0], parameters: {} }, 0, 200),
    at(code('Format alert', `const e = $input.first().json;
const node = (e.execution && e.execution.lastNodeExecuted) || 'unknown node';
const message = String((e.execution && e.execution.error && e.execution.error.message) || 'no message').replace(/pat[A-Za-z0-9.]{20,}/g, '***').slice(0, 300);
const text = ':rotating_light: Feed sync stopped at "' + node + '": ' + message + '. No further sources were processed in this run.';
const fs = require('fs');
fs.mkdirSync('/files/output', { recursive: true });
fs.appendFileSync('/files/output/errors.jsonl', JSON.stringify({ ts: new Date().toISOString(), node, message }) + '\\n', 'utf8');
return [{ json: { text } }];`), 220, 200),
    at(slack('Send alert', '$json.text'), 440, 200),
  ];
  return workflow('wfSyncErrors', 'Feed sync: error handler', nodes, {
    'Error trigger': { main: [[edge('Format alert')]] },
    'Format alert': { main: [[edge('Send alert')]] },
  }, false);
}

function buildWorkflows(destination = outputDir) {
  const workflows = [feedSync(), errorHandler()];
  mkdirSync(destination, { recursive: true });
  for (const item of workflows) writeFileSync(join(destination, `${item.id}.json`), `${JSON.stringify(item, null, 2)}\n`, 'utf8');
  return workflows;
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const built = buildWorkflows();
  console.log(`Wrote ${built.length} workflows: ${built.map((item) => item.id).join(', ')}`);
}
export { buildWorkflows };
