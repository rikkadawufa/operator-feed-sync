// Where and how to fetch one source's feed. feedRequest runs in "Load sources", before the HTTP
// request; checkFetch runs with checkSource in planSync.

// A Google Sheets link as people copy it from the browser or the Share dialog
// (…/spreadsheets/d/<id>/edit#gid=<tab>) becomes the sheet's CSV export URL. The sheet must be
// shared as "Anyone with the link"; otherwise Google answers with a sign-in page, which the
// HTML check in planSync stops. "Publish to web" links (…/d/e/<id>/pub?output=csv) already are
// CSV and don't match here.
// Browsers signed in to several Google accounts insert /u/<n>/ before /d/.
const SHEETS_LINK = /^https:\/\/docs\.google\.com\/spreadsheets\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})(?:[/?#].*)?$/;

// A feed behind a key or password names its secret in the mapping ("auth"); the value itself
// lives outside the mapping: an environment variable FEED_SECRET_<name> on self-hosted n8n, the
// feedSecrets field of the Settings node on n8n Cloud.
//   { "type": "header", "name": "X-API-Key", "secret": "NORTHGATE_KEY" }
//   { "type": "bearer", "secret": "NORTHGATE_TOKEN" }
//   { "type": "basic", "user": "larkspur", "secret": "NORTHGATE_PASSWORD" }
//   { "type": "query", "name": "api_key", "secret": "NORTHGATE_KEY" }
const AUTH_TYPES = ['header', 'bearer', 'basic', 'query'];
// "transport": "sftp" with a "path" reads the file through the workflow's SFTP branch instead.
const TRANSPORTS = ['http', 'sftp'];
// A name has at least one "_" (SUPPLIER_KEY), so a key pasted here by mistake (most keys have
// none) is refused instead of being echoed into notes and alerts as "secret <key> is not set".
const SECRET_NAME = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/;

class FeedRequestError extends Error {}

function feedUrl(source) {
  const url = String(source.url || '').trim();
  const match = SHEETS_LINK.exec(url);
  if (!match) return url;
  const tab = /[?&#]gid=(\d+)/.exec(url);
  return `https://docs.google.com/spreadsheets/d/${match[1]}/export?format=csv${tab ? `&gid=${tab[1]}` : ''}`;
}

// UTF-8 text → base64, without Buffer or btoa (n8n Cloud's Code node may have neither).
function base64(text) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = unescape(encodeURIComponent(text)).split('').map((char) => char.charCodeAt(0));
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    out += chars[a >> 2] + chars[((a & 3) << 4) | ((b || 0) >> 4)];
    out += b === undefined ? '=' : chars[((b & 15) << 2) | ((c || 0) >> 6)];
    out += c === undefined ? '=' : chars[c & 63];
  }
  return out;
}

// secretFor(name) returns the secret's value, or '' when it isn't set.
// Returns { url, headers, secrets }; secrets lists every value to keep out of notes and alerts.
function feedRequest(source, secretFor) {
  // A bad fetch setting must stop before any key is sent; planSync reports the details.
  if (checkFetch(source).length) throw new FeedRequestError('mapping has fetch settings problems');
  if (source.transport === 'sftp') return { url: '', headers: {}, secrets: [] };
  const url = feedUrl(source);
  const auth = source.auth;
  if (!auth) return { url, headers: {}, secrets: [] };
  const value = String(secretFor(auth.secret) || '');
  if (!value) throw new FeedRequestError(`secret ${auth.secret} is not set`);
  if (auth.type === 'header') return { url, headers: { [auth.name]: value }, secrets: [value] };
  if (auth.type === 'bearer') return { url, headers: { Authorization: `Bearer ${value}` }, secrets: [value] };
  if (auth.type === 'basic') {
    const token = base64(`${auth.user}:${value}`);
    return { url, headers: { Authorization: `Basic ${token}` }, secrets: [value, token] };
  }
  const joined = `${url}${url.includes('?') ? '&' : '?'}${encodeURIComponent(auth.name)}=${encodeURIComponent(value)}`;
  return { url: joined, headers: {}, secrets: [value, encodeURIComponent(value)] };
}

function redact(text, secrets = []) {
  return secrets.filter(Boolean).reduce((out, secret) => out.split(secret).join('***'), String(text));
}

function checkFetch(source) {
  const issues = [];
  if (SHEETS_LINK.test(String(source.url || '').trim()) && source.format !== 'csv') issues.push('a Google Sheets link is read as CSV, so "format" must be "csv"');
  if (source.transport !== undefined && !TRANSPORTS.includes(source.transport)) issues.push(`transport must be one of ${TRANSPORTS.join(', ')}`);
  if (source.transport === 'sftp') {
    if (!/^\/\S+$/.test(String(source.path || ''))) issues.push('an sftp source needs "path", the full file path on the server (for example /out/stock.csv)');
    if (source.url) issues.push('an sftp source takes "path", not "url"; the server and login are in the Supplier SFTP credential');
    if (source.auth) issues.push('an sftp source logs in through the Supplier SFTP credential, not "auth"');
    return issues;
  }
  const auth = source.auth;
  if (auth === undefined) return issues;
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return [...issues, 'auth must be an object like { "type": "header", "name": "X-API-Key", "secret": "SUPPLIER_KEY" }'];
  if (!AUTH_TYPES.includes(auth.type)) issues.push(`auth.type must be one of ${AUTH_TYPES.join(', ')}`);
  if (!SECRET_NAME.test(String(auth.secret || ''))) issues.push('auth.secret must name the secret in capitals, digits and _ (for example SUPPLIER_KEY), not hold the key itself');
  if (['header', 'query'].includes(auth.type) && !/^[A-Za-z0-9_-]{1,60}$/.test(String(auth.name || ''))) issues.push(`auth.name is required for ${auth.type} auth (the ${auth.type === 'header' ? 'header' : 'query parameter'} name)`);
  if (auth.type === 'basic' && (!auth.user || String(auth.user).includes(':'))) issues.push('auth.user is required for basic auth and may not contain ":"');
  for (const key of Object.keys(auth)) if (!['type', 'name', 'user', 'secret'].includes(key)) issues.push(`auth.${key} is not an auth setting (type, name, user, secret)`);
  // The demo's local feed server (http://feeds:8080) and localhost are exempt, unless the URL
  // hides another host behind them (http://localhost@supplier.example/).
  const authority = (/^https?:\/\/([^/?#]*)/i.exec(String(source.url || '')) || [])[1] || '';
  const host = authority.split('@').pop().split(':')[0].toLowerCase();
  const local = !authority.includes('@') && ['feeds', 'localhost', '127.0.0.1'].includes(host);
  if (!/^https:\/\//i.test(String(source.url || '')) && !local) issues.push('a feed with auth must use https, or the key travels unencrypted');
  return issues;
}

if (typeof module !== 'undefined') module.exports = { FeedRequestError, feedUrl, feedRequest, redact, base64, checkFetch };
