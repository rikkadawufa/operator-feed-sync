// Feed parsers. Each returns { rows: [{ row, raw }] } or throws FeedError, so a broken
// feed stops that source before anything is compared or written.

class FeedError extends Error {}

function decodeEntities(text) {
  return text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner) => inner)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// Flat record XML: <root><record><field>value</field>…</record>…</root>. Attributes on the
// record element become fields too (for example <listing ref="NG-101">).
function parseXml(text, recordTag) {
  const body = String(text || '').replace(/<\?xml[\s\S]*?\?>/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!body.startsWith('<')) throw new FeedError('not an XML document');
  const opened = (body.match(new RegExp(`<${recordTag}[\\s>]`, 'g')) || []).length;
  const closed = (body.match(new RegExp(`</${recordTag}>`, 'g')) || []).length;
  if (opened !== closed) throw new FeedError(`XML is cut off or malformed: ${opened} <${recordTag}> opened, ${closed} closed`);
  const rows = [];
  const recordPattern = new RegExp(`<${recordTag}((?:\\s+[\\w:-]+="[^"]*")*)\\s*>([\\s\\S]*?)</${recordTag}>`, 'g');
  let match;
  while ((match = recordPattern.exec(body))) {
    const raw = {};
    for (const [, name, value] of match[1].matchAll(/([\w:-]+)="([^"]*)"/g)) raw[name] = decodeEntities(value);
    for (const [, name, value] of match[2].matchAll(/<([\w:-]+)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) raw[name] = decodeEntities(value).trim();
    for (const [, name] of match[2].matchAll(/<([\w:-]+)(?:\s[^>]*)?\/>/g)) if (!(name in raw)) raw[name] = '';
    rows.push({ row: rows.length + 1, raw });
  }
  if (opened && rows.length !== opened) throw new FeedError(`could not read ${opened - rows.length} of ${opened} <${recordTag}> records`);
  return { rows };
}

// RFC 4180 CSV with a header row. Quoted fields may contain the delimiter, quotes ("") and newlines.
function parseCsv(text, delimiter = ',') {
  const source = String(text || '').replace(/^﻿/, '');
  const records = [];
  let field = '';
  let record = [];
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === delimiter) { record.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i += 1;
      record.push(field); field = '';
      if (record.some((value) => value !== '')) records.push(record);
      record = [];
    } else field += char;
  }
  if (quoted) throw new FeedError('CSV ends inside a quoted field');
  record.push(field);
  if (record.some((value) => value !== '')) records.push(record);
  if (!records.length) return { rows: [] };
  const headers = records[0].map((name) => name.trim());
  const rows = records.slice(1).map((values, index) => {
    if (values.length !== headers.length) return { row: index + 1, raw: {}, shapeError: `has ${values.length} columns, header has ${headers.length}` };
    return { row: index + 1, raw: Object.fromEntries(headers.map((name, column) => [name, values[column].trim()])) };
  });
  return { rows, headers };
}

function getPath(value, path) {
  return String(path).split('.').reduce((current, key) => (current == null ? undefined : current[key]), value);
}

// JSON API response: records live at `recordPath` (dot path), each an object.
function parseJson(text, recordPath) {
  let data;
  try { data = JSON.parse(text); } catch (error) { throw new FeedError(`not valid JSON (${error.message})`); }
  const list = recordPath ? getPath(data, recordPath) : data;
  if (!Array.isArray(list)) throw new FeedError(`no list found at "${recordPath}"`);
  return { rows: list.map((raw, index) => ({ row: index + 1, raw: raw && typeof raw === 'object' ? raw : {} })) };
}

// An HTML page (a login wall, a 200 error page) served where a feed should be. Follows the HTML
// patterns of the WHATWG MIME sniffing rules: after a BOM and leading whitespace, one of these
// tags followed by a space or ">". XML feeds start with "<" too, so they only stop on <!DOCTYPE html or <html.
const HTML_STARTS = ['!DOCTYPE HTML', 'HTML', 'HEAD', 'SCRIPT', 'IFRAME', 'H1', 'DIV', 'FONT', 'TABLE', 'A', 'STYLE', 'TITLE', 'B', 'BODY', 'BR', 'P'];

function isHtmlPage(text, format) {
  let start = String(text || '').replace(/^\uFEFF/, '').replace(/^[\t\n\f\r ]+/, '');
  if (format === 'xml') {
    start = start.replace(/^<\?xml[\s\S]*?\?>\s*/, '');
    return /^<(!DOCTYPE\s+html|html)[\s>]/i.test(start);
  }
  if (start.startsWith('<!--')) return true;
  return HTML_STARTS.some((tag) => start.toUpperCase().startsWith('<' + tag) && /^[\s>]/.test(start.slice(tag.length + 1)));
}

function parseFeed(text, source) {
  if (source.format === 'xml') return parseXml(text, source.record);
  if (source.format === 'csv') return parseCsv(text, source.delimiter || ',');
  if (source.format === 'json') return parseJson(text, source.record);
  throw new FeedError(`unknown feed format "${source.format}"`);
}

if (typeof module !== 'undefined') module.exports = { FeedError, parseXml, parseCsv, parseJson, parseFeed, getPath, isHtmlPage };
