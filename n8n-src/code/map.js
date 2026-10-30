// Turns one operator's raw feed row into the marketplace's listing shape, using that
// operator's mapping file (sources/<id>.json). Everything operator-specific lives in the
// mapping file; this code is the same for every source.
// Needs getPath from parse.js (inlined before this file in the n8n Code node).

const UNIT_TYPES = ['locker', 'small', 'medium', 'large', 'parking'];
const FEED_STATUSES = ['available', 'rented', 'withdrawn'];
const SQFT_TO_M2 = 0.09290304;

function text(value) {
  return value == null ? '' : String(value).trim();
}

// "$1,249.50", "1.249,50 €" (decimal ","), "129" → number. Returns NaN when it isn't a number.
// A thousands separator must be followed by exactly three digits, so "1,8" with decimal "."
// is rejected instead of silently read as 18.
function parseNumber(value, decimal = '.') {
  const cleaned = text(value).replace(/[^\d.,-]/g, '');
  if (!cleaned) return NaN;
  const group = decimal === ',' ? '\\.' : ',';
  const point = decimal === ',' ? ',' : '\\.';
  if (!new RegExp(`^-?(\\d{1,3}(${group}\\d{3})+|\\d+)(${point}\\d+)?$`).test(cleaned)) return NaN;
  return Number(cleaned.replace(new RegExp(group, 'g'), '').replace(',', '.'));
}

function lookup(map, value) {
  if (!map) return value;
  const key = Object.keys(map).find((candidate) => candidate.toLowerCase() === value.toLowerCase());
  return key === undefined ? undefined : map[key];
}

function mapRow(raw, source) {
  const f = source.fields;
  const read = (name) => (f[name] ? text(getPath(raw, f[name])) : '');
  const values = source.values || {};
  const units = source.units || {};
  const problems = [];
  const problem = (field, issue, rawValue) => problems.push({ field, problem: issue, raw: rawValue });

  const externalRef = read('external_ref');
  if (!externalRef) problem('external_ref', 'missing external ref', '');
  const title = read('title');
  if (!title) problem('title', 'missing title', '');

  const rawType = read('unit_type');
  const unitType = lookup(values.unit_type, rawType);
  if (!rawType) problem('unit_type', 'missing unit type', '');
  else if (!UNIT_TYPES.includes(unitType)) problem('unit_type', 'unknown unit type', rawType);

  const rawSize = read('size');
  let size = parseNumber(rawSize, source.decimal);
  if (units.size === 'sqft') size = Math.round(size * SQFT_TO_M2 * 10) / 10;
  if (!rawSize) problem('size', 'missing size', '');
  else if (!(size > 0)) problem('size', 'size is not a positive number', rawSize);

  const rawPrice = read('monthly_price');
  const price = parseNumber(rawPrice, source.decimal);
  if (!rawPrice) problem('monthly_price', 'missing price', '');
  else if (!(price > 0)) problem('monthly_price', 'price is not a positive number', rawPrice);

  const rawStatus = read('status');
  const status = lookup(values.status, rawStatus);
  if (!rawStatus) problem('status', 'missing status', '');
  else if (!FEED_STATUSES.includes(status)) problem('status', 'unknown status', rawStatus);

  const rawClimate = read('climate_controlled');
  const climate = rawClimate ? lookup(values.climate_controlled || { yes: true, no: false, true: true, false: false }, rawClimate) : false;
  if (typeof climate !== 'boolean') problem('climate_controlled', 'not yes or no', rawClimate);

  const imageUrl = read('image_url');
  if (imageUrl && !/^https:\/\/[^\s]+$/.test(imageUrl)) problem('image_url', 'image link is not https', imageUrl);

  return {
    problems,
    listing: {
      external_ref: externalRef,
      title,
      unit_type: unitType,
      size_m2: size,
      monthly_price: Math.round(price * 100) / 100,
      area: read('area'),
      climate_controlled: climate === true,
      image_url: imageUrl,
      status,
    },
  };
}

// Checks a mapping file before it is used, so a typo fails loudly instead of skipping fields.
function checkSource(source) {
  const issues = [];
  for (const name of ['id', 'name', 'format', 'url', 'fields']) if (!source[name]) issues.push(`missing "${name}"`);
  if (source.format && !['xml', 'csv', 'json'].includes(source.format)) issues.push(`format must be xml, csv or json, not "${source.format}"`);
  if (source.format === 'xml' && !source.record) issues.push('xml sources need "record" (the record element name)');
  if (source.id && !/^[a-z][a-z0-9-]{1,30}$/.test(source.id)) issues.push('id must be lowercase letters, digits or dashes');
  for (const name of ['external_ref', 'title', 'unit_type', 'size', 'monthly_price', 'status']) {
    if (!source.fields || !source.fields[name]) issues.push(`fields.${name} is required`);
  }
  for (const [value, mapped] of Object.entries((source.values || {}).unit_type || {})) {
    if (!UNIT_TYPES.includes(mapped)) issues.push(`values.unit_type maps "${value}" to "${mapped}", which is not one of ${UNIT_TYPES.join(', ')}`);
  }
  for (const [value, mapped] of Object.entries((source.values || {}).status || {})) {
    if (!FEED_STATUSES.includes(mapped)) issues.push(`values.status maps "${value}" to "${mapped}", which is not one of ${FEED_STATUSES.join(', ')}`);
  }
  return issues;
}

if (typeof module !== 'undefined') module.exports = { UNIT_TYPES, FEED_STATUSES, parseNumber, mapRow, checkSource };
