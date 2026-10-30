// Stand-in for the operators' feed URLs. GET /feeds/<source> serves whatever
// sample-data/feeds/state.json says for that source today:
//   { "northgate": { "file": "day3/northgate.xml" }, "quayside": { "status": 503 } }
// The scenario runner edits state.json between runs to simulate outages and partial files.
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = process.env.FEEDS_DIR || path.join(__dirname, '..', 'sample-data', 'feeds');
const types = { '.xml': 'application/xml', '.csv': 'text/csv', '.json': 'application/json' };

http.createServer((req, res) => {
  const match = /^\/feeds\/([a-z0-9-]+)$/.exec(req.url.split('?')[0]);
  let state = {};
  try { state = JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')); } catch { /* no state yet */ }
  const entry = match && state[match[1]];
  if (!entry) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Unknown feed'); return; }
  if (entry.status && entry.status !== 200) { res.writeHead(entry.status, { 'Content-Type': 'text/plain' }); res.end('Service Unavailable'); return; }
  const file = path.join(root, entry.file);
  if (!file.startsWith(root) || !fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Feed file missing'); return; }
  res.writeHead(200, { 'Content-Type': `${types[path.extname(file)] || 'text/plain'}; charset=utf-8` });
  res.end(fs.readFileSync(file));
}).listen(8080, () => console.log(`feed server on :8080, serving ${root}`));
