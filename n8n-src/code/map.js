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

// Optional "markup" in the mapping turns the supplier's price into the listing price:
// price × (1 + percent / 100) + add, then rounded to cents, to a whole number, or up to .99
// (36.20 → 36.99, 37.00 → 37.99), so rounding never goes below the marked-up price.
const ROUNDING = ['cents', 'whole', '99'];

function applyMarkup(price, markup) {
  const cents = (value) => Math.round(value * 100) / 100;
  if (!markup) return cents(price);
  const raised = cents(price * (1 + (markup.percent || 0) / 100) + (markup.add || 0));
  if (markup.round === 'whole') return Math.round(raised);
  if (markup.round === '99') return cents(Math.floor(raised) + 0.99);
  return raised;
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
  const supplierPrice = parseNumber(rawPrice, source.decimal);
  const price = applyMarkup(supplierPrice, source.markup);
  if (!rawPrice) problem('monthly_price', 'missing price', '');
  else if (!(supplierPrice > 0)) problem('monthly_price', 'price is not a positive number', rawPrice);
  else if (!(price > 0)) problem('monthly_price', 'price after markup is not a positive number', rawPrice);

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
      monthly_price: price,
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
  // An SFTP source has a "path" instead of a "url" (checked in checkFetch).
  const required = source.transport === 'sftp' ? ['id', 'name', 'format', 'fields'] : ['id', 'name', 'format', 'url', 'fields'];
  for (const name of required) if (!source[name]) issues.push(`missing "${name}"`);
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
  const markup = source.markup;
  if (markup !== undefined) {
    if (!markup || typeof markup !== 'object' || Array.isArray(markup)) issues.push('markup must be an object like { "percent": 30 }');
    else {
      for (const key of Object.keys(markup)) if (!['percent', 'add', 'round'].includes(key)) issues.push(`markup.${key} is not a markup setting (percent, add, round)`);
      for (const key of ['percent', 'add']) if (markup[key] !== undefined && !Number.isFinite(markup[key])) issues.push(`markup.${key} must be a number`);
      if (Number.isFinite(markup.percent) && markup.percent <= -100) issues.push('markup.percent must be above -100');
      if (markup.round !== undefined && !ROUNDING.includes(markup.round)) issues.push(`markup.round must be one of ${ROUNDING.join(', ')}`);
    }
  }
  return issues;
}

if (typeof module !== 'undefined') module.exports = { UNIT_TYPES, FEED_STATUSES, parseNumber, applyMarkup, mapRow, checkSource };
