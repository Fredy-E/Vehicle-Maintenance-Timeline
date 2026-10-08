/*!
 * Vehicle Maintenance Timeline — core.js
 *
 * Pure, dependency-free domain logic shared by the browser UI and the Node test
 * suite. Loads as a classic script (defines window.Maintenance) and as a
 * CommonJS module (module.exports) so the exact same code that ships to the
 * page is what the unit tests exercise.
 *
 * Rules of this file:
 *  - no DOM, no timers, no network, no evaluation;
 *  - validators never throw — they return { ok, value } or { ok, errors };
 *  - every returned value is a normalized, freshly built object
 *    (inputs are never mutated);
 *  - scheduling states are overdue / due / unknown only. No universal service
 *    intervals are ever inferred — the user defines every due point.
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && module.exports) { module.exports = api; }
  if (root) { root.Maintenance = api; }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  // --------------------------------------------------------------- constants

  var FORMAT = 'vehicle-maintenance-timeline';
  var VERSION = 1;
  var UNITS = ['km', 'mi'];
  var STORAGE_KEY = 'vehicle-maintenance-timeline:v1';

  var LIMITS = Object.freeze({
    maxBytes: 2 * 1024 * 1024, // 2,097,152 bytes for any imported document
    maxEntries: 5000,
    maxErrors: 50,             // collected validation errors are capped
    nickname: 60,
    category: 40,
    description: 2000,
    parts: 500,
    receipt: 200,
    notes: 4000,
    id: 64,
    mileage: 10000000,         // sane upper bound for any odometer reading
    cost: 10000000,
    minYear: 1900,
    maxYear: 2100
  });

  var STATE_KEYS = ['format', 'version', 'updatedAt', 'vehicle', 'entries'];
  var VEHICLE_KEYS = ['nickname', 'odometer', 'unit'];
  var ENTRY_KEYS = ['id', 'date', 'mileage', 'category', 'description', 'parts', 'cost', 'receipt', 'notes', 'nextDate', 'nextMileage', 'createdAt'];
  var ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

  var MEMORY_REASONS = Object.freeze({
    'no-storage': 'no browser storage was provided',
    'storage-unavailable': 'browser storage is blocked or unavailable',
    'quota': 'browser storage is full (quota exceeded)',
    'verify-failed': 'browser storage did not keep the write',
    'storage-error': 'browser storage raised an error',
    'serialize-failed': 'the state could not be serialized'
  });

  var CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

  // ----------------------------------------------------------------- helpers

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function ok(value) { return { ok: true, value: value }; }
  function fail(errors) { return { ok: false, errors: errors }; }

  function addError(list, path, message) {
    if (list.length < LIMITS.maxErrors) {
      list.push({ path: path, message: message });
    } else if (list.length === LIMITS.maxErrors) {
      list.push({ path: path, message: 'further problems omitted (error list capped at ' + LIMITS.maxErrors + ')' });
    }
  }

  function nowIso() { return new Date().toISOString(); }

  function byteLength(text) {
    if (typeof TextEncoder !== 'undefined') { return new TextEncoder().encode(text).length; }
    var n = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c < 0x80) { n += 1; }
      else if (c < 0x800) { n += 2; }
      else if (c < 0xD800 || c >= 0xE000) { n += 3; }
      else { n += 4; i++; }
    }
    return n;
  }

  function hasOwn(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      if (ch === '&') { return '&amp;'; }
      if (ch === '<') { return '&lt;'; }
      if (ch === '>') { return '&gt;'; }
      if (ch === '"') { return '&quot;'; }
      return '&#39;';
    });
  }

  function formatInt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // ------------------------------------------------------- scalar validators

  function isRealDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) { return false; }
    var y = parseInt(value.slice(0, 4), 10);
    var m = parseInt(value.slice(5, 7), 10);
    var d = parseInt(value.slice(8, 10), 10);
    if (y < LIMITS.minYear || y > LIMITS.maxYear) { return false; }
    var dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  function cleanText(value, spec) {
    // spec: { list, path, name, max, required }
    if (value === undefined || value === null || value === '') {
      if (spec.required) { addError(spec.list, spec.path, spec.name + ' is required'); }
      return '';
    }
    if (typeof value !== 'string') {
      addError(spec.list, spec.path, spec.name + ' must be a string');
      return '';
    }
    var text = value.replace(/\r\n?/g, '\n').replace(CONTROL_CHARS_RE, '').trim();
    if (spec.required && text === '') {
      addError(spec.list, spec.path, spec.name + ' is required');
      return '';
    }
    if (text.length > spec.max) {
      addError(spec.list, spec.path, spec.name + ' must be ' + spec.max + ' characters or fewer');
      return text.slice(0, spec.max);
    }
    return text;
  }

  function cleanDate(value, spec) {
    if (value === undefined || value === null || value === '') {
      if (spec.required) { addError(spec.list, spec.path, spec.name + ' is required in YYYY-MM-DD format'); }
      return null;
    }
    if (!isRealDate(value)) {
      addError(spec.list, spec.path, spec.name + ' must be a real calendar date in YYYY-MM-DD format (' + LIMITS.minYear + '-' + LIMITS.maxYear + ')');
      return null;
    }
    return value;
  }

  function cleanMileage(value, spec) {
    if (value === undefined || value === null || value === '') {
      if (spec.required) { addError(spec.list, spec.path, spec.name + ' is required'); }
      return null;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > LIMITS.mileage) {
      addError(spec.list, spec.path, spec.name + ' must be a whole number from 0 to ' + LIMITS.mileage);
      return null;
    }
    return value;
  }

  function cleanCost(value, spec) {
    if (value === undefined || value === null || value === '') { return null; }
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > LIMITS.cost) {
      addError(spec.list, spec.path, 'cost must be a number from 0 to ' + LIMITS.cost);
      return null;
    }
    // The +Number.EPSILON nudge lifts a half-cent that binary floating point
    // stores just below the boundary (1.005 is really 1.00499999999999989…),
    // which otherwise rounds down to 1.00 instead of up to 1.01. Values that
    // are not at a half-cent boundary keep their previous result (12.346 →
    // 12.35, 10.999 → 11.00).
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  function cleanTimestamp(value, spec) {
    if (value === undefined || value === null || value === '') {
      if (spec.required) { addError(spec.list, spec.path, spec.name + ' is required'); }
      return null;
    }
    if (typeof value !== 'string') {
      addError(spec.list, spec.path, spec.name + ' must be an ISO-8601 timestamp string');
      return null;
    }
    var t = Date.parse(value);
    if (!Number.isFinite(t)) {
      addError(spec.list, spec.path, spec.name + ' must be a parseable ISO-8601 timestamp');
      return null;
    }
    return new Date(t).toISOString();
  }

  function rejectUnknownKeys(obj, allowed, path, list) {
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      if (allowed.indexOf(keys[i]) === -1) {
        addError(list, path + '.' + keys[i], 'unexpected field "' + keys[i] + '" (not part of schema version ' + VERSION + ')');
      }
    }
  }

  // -------------------------------------------------------- object validators

  function normalizeVehicle(raw, spec) {
    var list = spec.list;
    var path = spec.path;
    if (raw === undefined || raw === null) { return null; }
    if (!isPlainObject(raw)) {
      addError(list, path, 'vehicle must be an object or null');
      return null;
    }
    rejectUnknownKeys(raw, VEHICLE_KEYS, path, list);
    var nickname = cleanText(raw.nickname, { list: list, path: path + '.nickname', name: 'vehicle nickname', max: LIMITS.nickname });
    var odometer = cleanMileage(raw.odometer, { list: list, path: path + '.odometer', name: 'vehicle odometer' });
    var unit = raw.unit;
    if (unit !== 'km' && unit !== 'mi') {
      addError(list, path + '.unit', 'unit must be exactly "km" or "mi"' + (unit === undefined || unit === null ? ' (missing)' : ''));
      unit = null;
    }
    return { nickname: nickname, odometer: odometer, unit: unit };
  }

  function normalizeEntry(raw, spec) {
    var list = spec.list;
    var path = spec.path;
    var out = {
      id: null,
      date: null,
      mileage: null,
      category: 'General',
      description: '',
      parts: '',
      cost: null,
      receipt: '',
      notes: '',
      nextDate: null,
      nextMileage: null,
      createdAt: null
    };
    if (!isPlainObject(raw)) {
      addError(list, path, 'entry must be an object');
      return out;
    }
    rejectUnknownKeys(raw, ENTRY_KEYS, path, list);

    if (raw.id !== undefined && raw.id !== null && raw.id !== '') {
      if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) {
        addError(list, path + '.id', 'id must be 1-64 characters of letters, digits, "-" or "_" and start with a letter or digit');
      } else {
        out.id = raw.id;
      }
    } else if (spec.requireId) {
      addError(list, path + '.id', 'id is required');
    }

    out.date = cleanDate(raw.date, { list: list, path: path + '.date', name: 'service date', required: true });
    out.mileage = cleanMileage(raw.mileage, { list: list, path: path + '.mileage', name: 'mileage', required: true });
    out.category = cleanText(raw.category, { list: list, path: path + '.category', name: 'category', max: LIMITS.category }) || 'General';
    out.description = cleanText(raw.description, { list: list, path: path + '.description', name: 'description', max: LIMITS.description, required: true });
    out.parts = cleanText(raw.parts, { list: list, path: path + '.parts', name: 'parts', max: LIMITS.parts });
    out.cost = cleanCost(raw.cost, { list: list, path: path + '.cost' });
    out.receipt = cleanText(raw.receipt, { list: list, path: path + '.receipt', name: 'receipt reference', max: LIMITS.receipt });
    out.notes = cleanText(raw.notes, { list: list, path: path + '.notes', name: 'notes', max: LIMITS.notes });
    out.nextDate = cleanDate(raw.nextDate, { list: list, path: path + '.nextDate', name: 'next due date' });
    out.nextMileage = cleanMileage(raw.nextMileage, { list: list, path: path + '.nextMileage', name: 'next due mileage' });
    out.createdAt = cleanTimestamp(raw.createdAt, { list: list, path: path + '.createdAt', name: 'createdAt' });
    return out;
  }

  // ------------------------------------------------------------ public API: validators

  function validateVehicle(raw) {
    var list = [];
    var value = normalizeVehicle(raw, { path: 'vehicle', list: list });
    if (list.length) { return fail(list); }
    return ok(value);
  }

  function validateEntry(raw, opts) {
    opts = opts || {};
    var list = [];
    var value = normalizeEntry(raw, { path: 'entry', list: list, requireId: !!opts.requireId });
    if (list.length) { return fail(list); }
    return ok(value);
  }

  function validateState(raw, opts) {
    opts = opts || {};
    var list = [];
    var maxEntries = typeof opts.maxEntries === 'number' ? opts.maxEntries : LIMITS.maxEntries;
    if (!isPlainObject(raw)) { return fail([{ path: '$', message: 'state must be a JSON object' }]); }

    rejectUnknownKeys(raw, STATE_KEYS, '$', list);
    if (raw.format !== FORMAT) {
      addError(list, '$.format', 'format must be "' + FORMAT + '"' + (typeof raw.format === 'string' ? ' (got "' + raw.format + '")' : ''));
    }
    if (raw.version !== VERSION) {
      addError(list, '$.version', 'version must be ' + VERSION + (typeof raw.version === 'number' ? ' (got ' + raw.version + ')' : ' (missing or not a number)'));
    }

    var updatedAt = cleanTimestamp(raw.updatedAt, { list: list, path: '$.updatedAt', name: 'updatedAt' });
    if (raw.updatedAt === undefined || raw.updatedAt === null || raw.updatedAt === '') { updatedAt = nowIso(); }

    var vehicle = normalizeVehicle(raw.vehicle, { path: '$.vehicle', list: list });

    var entries = [];
    if (!Array.isArray(raw.entries)) {
      addError(list, '$.entries', 'entries must be an array');
    } else if (raw.entries.length > maxEntries) {
      addError(list, '$.entries', 'too many entries: ' + raw.entries.length + ' (limit ' + maxEntries + ')');
    } else {
      // Entry ids must be unique: updateEntry and removeEntry address records by
      // id, so a duplicate id would let one edit or delete hit two records. The
      // check keys a Map (not a plain object) so ids that collide with
      // Object.prototype names ("constructor", "toString", ...) cannot fool it.
      var seenIds = new Map();
      for (var i = 0; i < raw.entries.length; i++) {
        var entry = normalizeEntry(raw.entries[i], { path: '$.entries[' + i + ']', list: list, requireId: true });
        if (entry.id !== null) {
          if (seenIds.has(entry.id)) {
            addError(list, '$.entries[' + i + '].id', 'duplicate id "' + entry.id + '": every entry id must be unique (first used at $.entries[' + seenIds.get(entry.id) + '])');
          } else {
            seenIds.set(entry.id, i);
          }
        }
        entries.push(entry);
      }
    }

    if (list.length) { return fail(list); }
    return ok({ format: FORMAT, version: VERSION, updatedAt: updatedAt, vehicle: vehicle, entries: entries });
  }

  // ------------------------------------------------------------ state factory

  function createState(opts) {
    opts = opts || {};
    return {
      format: FORMAT,
      version: VERSION,
      updatedAt: opts.now || nowIso(),
      vehicle: { nickname: '', odometer: null, unit: opts.unit === 'mi' ? 'mi' : 'km' },
      entries: []
    };
  }

  function withState(state, changes, now) {
    var next = {
      format: FORMAT,
      version: VERSION,
      updatedAt: now || nowIso(),
      vehicle: state ? state.vehicle : null,
      entries: state ? state.entries : []
    };
    if (changes) {
      for (var k in changes) {
        if (hasOwn(changes, k)) { next[k] = changes[k]; }
      }
    }
    return next;
  }

  function makeId() {
    return 'e-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function uniqueId(state) {
    var id;
    do { id = makeId(); }
    while (state.entries.some(function (e) { return e.id === id; }));
    return id;
  }

  // ------------------------------------------------------------ public API: mutations
  // All mutations are immutable: they return a new state and never touch the
  // one that was passed in. Callers swap only after checking { ok: true }.

  function setVehicle(state, input, opts) {
    opts = opts || {};
    var list = [];
    if (input === null || input === undefined) {
      // normalizeVehicle treats null as "no vehicle" (legal at state level);
      // an explicit set with nothing to set must fail with a field error
      // instead of throwing on the unit-change comparison below.
      return fail([{ path: 'vehicle', message: 'vehicle is required (an object with nickname, odometer and unit)' }]);
    }
    var vehicle = normalizeVehicle(input, { path: 'vehicle', list: list });
    if (list.length) { return fail(list); }

    var prev = state && state.vehicle ? state.vehicle : null;
    var hasEntries = state && Array.isArray(state.entries) && state.entries.length > 0;
    if (prev && prev.unit !== vehicle.unit && hasEntries && opts.confirmUnitChange !== true) {
      return fail([{
        path: 'vehicle.unit',
        message: 'changing the unit from "' + prev.unit + '" to "' + vehicle.unit + '" would re-label ' + state.entries.length + ' existing record(s); pass { confirmUnitChange: true } only after the user explicitly confirms (numbers are never converted)'
      }]);
    }

    var next = withState(state, null, opts.now);
    next.vehicle = vehicle;
    return ok(next);
  }

  function addEntry(state, input, opts) {
    opts = opts || {};
    var list = [];
    var entry = normalizeEntry(input, { path: 'entry', list: list, requireId: false });
    if (list.length) { return fail(list); }

    // The public add path must never grow a state past the importable maximum:
    // validateState refuses documents with more than LIMITS.maxEntries entries,
    // so accepting a 5001st record here would produce a state that can be
    // exported but never imported again.
    if (state.entries.length >= LIMITS.maxEntries) {
      return fail([{
        path: 'entries',
        message: 'cannot add an entry: the state already holds the maximum of ' + LIMITS.maxEntries + ' entries; remove a record before adding another'
      }]);
    }

    var id = entry.id || opts.id || null;
    if (id !== null && !ID_RE.test(id)) {
      return fail([{ path: 'entry.id', message: 'id must be 1-64 characters of letters, digits, "-" or "_"' }]);
    }
    if (id !== null && state.entries.some(function (e) { return e.id === id; })) {
      return fail([{ path: 'entry.id', message: 'duplicate id "' + id + '"' }]);
    }
    if (id === null) { id = uniqueId(state); }

    entry.id = id;
    entry.createdAt = entry.createdAt || opts.now || nowIso();
    return ok(withState(state, { entries: state.entries.concat([entry]) }, opts.now));
  }

  function updateEntry(state, id, patch, opts) {
    opts = opts || {};
    if (typeof id !== 'string' || id === '') { return fail([{ path: 'id', message: 'entry id is required' }]); }
    var index = -1;
    for (var i = 0; i < state.entries.length; i++) {
      if (state.entries[i].id === id) { index = i; break; }
    }
    if (index === -1) { return fail([{ path: 'id', message: 'no entry with id "' + id + '"' }]); }

    var current = state.entries[index];
    var merged = {};
    var k;
    for (k in current) { if (hasOwn(current, k)) { merged[k] = current[k]; } }
    if (isPlainObject(patch)) {
      for (k in patch) { if (hasOwn(patch, k)) { merged[k] = patch[k]; } }
    }
    merged.id = id;                       // id and createdAt are immutable
    merged.createdAt = current.createdAt;

    var list = [];
    var entry = normalizeEntry(merged, { path: 'entry', list: list, requireId: true });
    if (list.length) { return fail(list); }
    entry.id = id;
    entry.createdAt = current.createdAt;

    var entries = state.entries.slice();
    entries[index] = entry;
    return ok(withState(state, { entries: entries }, opts.now));
  }

  function removeEntry(state, id, opts) {
    opts = opts || {};
    if (typeof id !== 'string' || id === '') { return fail([{ path: 'id', message: 'entry id is required' }]); }
    var found = false;
    var entries = state.entries.filter(function (e) {
      if (e.id === id) { found = true; return false; }
      return true;
    });
    if (!found) { return fail([{ path: 'id', message: 'no entry with id "' + id + '"' }]); }
    return ok(withState(state, { entries: entries }, opts.now));
  }

  // ----------------------------------------------------------------- sorting

  function compareEntries(a, b) {
    if (a.date !== b.date) { return a.date < b.date ? 1 : -1; } // newest date first
    if (a.mileage !== b.mileage) { return b.mileage - a.mileage; } // then highest mileage
    return 0; // ties keep insertion order (stable sort, ES2019+)
  }

  function sortEntries(entries) {
    return entries.slice().sort(compareEntries);
  }

  // -------------------------------------------------------------- scheduling

  function computeSchedule(entry, vehicle, todayISO) {
    var result = { status: 'unknown', date: null, mileage: null };
    if (!isPlainObject(entry)) { return result; }

    var hasDate = entry.nextDate !== null && entry.nextDate !== undefined && entry.nextDate !== '';
    var hasMileage = entry.nextMileage !== null && entry.nextMileage !== undefined && entry.nextMileage !== '';

    if (hasDate) {
      if (!isRealDate(todayISO)) { result.date = 'unknown'; }
      else { result.date = todayISO > entry.nextDate ? 'overdue' : 'due'; }
    }
    if (hasMileage) {
      var odo = vehicle && typeof vehicle.odometer === 'number' && Number.isInteger(vehicle.odometer) ? vehicle.odometer : null;
      if (odo === null) { result.mileage = 'unknown'; }
      else { result.mileage = odo > entry.nextMileage ? 'overdue' : 'due'; }
    }

    if (result.date === 'overdue' || result.mileage === 'overdue') { result.status = 'overdue'; }
    else if (result.date === 'due' || result.mileage === 'due') { result.status = 'due'; }
    else { result.status = 'unknown'; }
    return result;
  }

  function describeSchedule(entry, vehicle, todayISO) {
    if (!isPlainObject(entry)) { return 'not set'; }
    var s = computeSchedule(entry, vehicle, todayISO);
    var unit = vehicle && vehicle.unit === 'mi' ? 'mi' : 'km';
    var parts = [];
    if (s.date === 'overdue') { parts.push('date passed (' + entry.nextDate + ')'); }
    else if (s.date === 'due') { parts.push('due by ' + entry.nextDate); }
    if (s.mileage === 'overdue') { parts.push('odometer passed ' + formatInt(entry.nextMileage) + ' ' + unit); }
    else if (s.mileage === 'due') { parts.push('due at ' + formatInt(entry.nextMileage) + ' ' + unit); }
    else if (s.mileage === 'unknown') { parts.push('target ' + formatInt(entry.nextMileage) + ' ' + unit + ' (odometer unknown)'); }
    return parts.join('; ') || 'not set';
  }

  // ---------------------------------------------------------------- filtering

  function filterEntries(entries, filter, ctx) {
    filter = filter || {};
    ctx = ctx || {};
    var query = typeof filter.query === 'string' ? filter.query.trim().toLowerCase() : '';
    var category = typeof filter.category === 'string' ? filter.category.trim() : '';
    var status = typeof filter.status === 'string' ? filter.status : '';

    return entries.filter(function (e) {
      if (category && e.category !== category) { return false; }
      if (query) {
        var hay = [e.date, String(e.mileage), e.category, e.description, e.parts, e.receipt, e.notes].join('\n').toLowerCase();
        if (hay.indexOf(query) === -1) { return false; }
      }
      if (status) {
        var s = computeSchedule(e, ctx.vehicle || null, ctx.today || null).status;
        if (s !== status) { return false; }
      }
      return true;
    });
  }

  function summarize(entries, vehicle, todayISO) {
    var totalCost = 0;
    var anyCost = false;
    // Keyed by user-typed category strings: a Map (like the duplicate-id check
    // in validateState) keeps names such as "__proto__", "constructor" or
    // "toString" as ordinary keys, where a plain object dropped "__proto__"
    // and returned Object.prototype functions for the others.
    var categories = new Map();
    var statuses = { overdue: 0, due: 0, unknown: 0 };
    var latest = null;

    entries.forEach(function (e) {
      if (typeof e.cost === 'number') { totalCost += e.cost; anyCost = true; }
      categories.set(e.category, (categories.get(e.category) || 0) + 1);
      statuses[computeSchedule(e, vehicle, todayISO).status] += 1;
      if (!latest || e.date > latest.date || (e.date === latest.date && e.mileage > latest.mileage)) { latest = e; }
    });

    return {
      count: entries.length,
      totalCost: anyCost ? Math.round(totalCost * 100) / 100 : null,
      categories: Array.from(categories.keys()).sort().map(function (name) { return { category: name, count: categories.get(name) }; }),
      statuses: statuses,
      latest: latest
    };
  }

  // -------------------------------------------------------- serialization / I/O

  function serializeState(state) {
    return JSON.stringify(state, null, 2) + '\n';
  }

  function parseState(text, opts) {
    opts = opts || {};
    var maxBytes = typeof opts.maxBytes === 'number' ? opts.maxBytes : LIMITS.maxBytes;
    if (typeof text !== 'string') { return fail([{ path: '$', message: 'import text must be a string' }]); }
    if (text.charCodeAt(0) === 0xFEFF) { text = text.slice(1); } // UTF-8 BOM from Windows editors
    if (text.trim() === '') { return fail([{ path: '$', message: 'the document is empty' }]); }

    var size = byteLength(text);
    if (size > maxBytes) {
      return fail([{ path: '$', message: 'document is too large: ' + size + ' bytes (limit ' + maxBytes + ')' }]);
    }

    var parsed;
    try { parsed = JSON.parse(text); }
    catch (e) { return fail([{ path: '$', message: 'not valid JSON: ' + (e && e.message ? e.message : String(e)) }]); }

    return validateState(parsed, { maxEntries: opts.maxEntries });
  }

  function importState(current, text, opts) {
    // `current` is deliberately accepted but never read: import is atomic by
    // construction and delegates wholly to parseState, so the caller's live
    // state cannot be touched here. The parameter is kept in the signature to
    // make that contract visible at every call site — callers swap their state
    // only when the result is { ok: true }.
    var result = parseState(text, opts);
    if (!result.ok) { return result; }
    return ok(result.value);
  }

  function exportFilename(now) {
    var stamp = typeof now === 'string' && /^\d{4}-\d{2}-\d{2}/.test(now) ? now.slice(0, 10) : nowIso().slice(0, 10);
    return 'maintenance-timeline-backup-' + stamp + '.json';
  }

  function buildReportText(state, opts) {
    opts = opts || {};
    var vehicle = state && state.vehicle ? state.vehicle : { nickname: '', odometer: null, unit: 'km' };
    var unit = vehicle.unit === 'mi' ? 'mi' : 'km';
    var lines = [];
    lines.push('VEHICLE MAINTENANCE TIMELINE — REPORT');
    lines.push('Generated: ' + (opts.today || nowIso().slice(0, 10)));
    lines.push('');
    lines.push('Vehicle: ' + (vehicle.nickname || '(unnamed)'));
    lines.push('Odometer: ' + (vehicle.odometer === null || vehicle.odometer === undefined ? 'unknown' : formatInt(vehicle.odometer) + ' ' + unit));
    lines.push('Records: ' + (state ? state.entries.length : 0));
    lines.push('');
    if (state) {
      sortEntries(state.entries).forEach(function (e, i) {
        lines.push('[' + (i + 1) + '] ' + e.date + ' — ' + formatInt(e.mileage) + ' ' + unit + ' — ' + e.category);
        lines.push('    ' + e.description);
        if (e.parts) { lines.push('    Parts: ' + e.parts); }
        if (typeof e.cost === 'number') { lines.push('    Cost: ' + e.cost.toFixed(2)); }
        if (e.receipt) { lines.push('    Receipt: ' + e.receipt); }
        if (e.notes) { lines.push('    Notes: ' + e.notes); }
        lines.push('    Next due: ' + describeSchedule(e, vehicle, opts.today));
      });
    }
    lines.push('');
    lines.push('Generated locally by Vehicle Maintenance Timeline. No data was sent anywhere.');
    return lines.join('\n') + '\n';
  }

  // ------------------------------------------------------------- storage adapter

  function createStore(options) {
    options = options || {};
    var key = typeof options.key === 'string' && options.key !== '' ? options.key : STORAGE_KEY;
    var storage = options.storage || null;
    var listeners = [];
    var memoryValue = null;
    var mode = 'memory';
    var reason = storage ? 'storage-unavailable' : 'no-storage';

    function probe(s, k) {
      try {
        var probeKey = k + ':probe';
        s.setItem(probeKey, '1');
        var readBack = s.getItem(probeKey) === '1';
        s.removeItem(probeKey);
        return readBack;
      } catch (e) { return false; }
    }

    function isQuotaError(e) {
      return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
    }

    if (storage && probe(storage, key)) { mode = 'storage'; reason = null; }

    function setMode(nextMode, nextReason) {
      if (nextMode === mode && nextReason === reason) { return; }
      mode = nextMode;
      reason = nextReason;
      listeners.slice().forEach(function (fn) {
        try { fn(mode, reason); } catch (e) { /* listener errors never break saves */ }
      });
    }

    function load() {
      if (storage) {
        var raw = null;
        try { raw = storage.getItem(key); }
        catch (e) { setMode('memory', 'storage-error'); return { ok: true, value: null, mode: mode, reason: reason }; }
        if (raw === null || raw === undefined) { return { ok: true, value: null, mode: mode, reason: reason }; }
        var result = parseState(raw);
        if (result.ok) { memoryValue = raw; return { ok: true, value: result.value, mode: mode, reason: reason }; }
        return { ok: false, errors: result.errors, raw: raw, mode: mode, reason: reason };
      }
      if (memoryValue === null) { return { ok: true, value: null, mode: mode, reason: reason }; }
      var memResult = parseState(memoryValue);
      if (memResult.ok) { return { ok: true, value: memResult.value, mode: mode, reason: reason }; }
      return { ok: false, errors: memResult.errors, raw: memoryValue, mode: mode, reason: reason };
    }

    function save(state) {
      var text;
      try { text = serializeState(state); }
      catch (e) {
        setMode('memory', 'serialize-failed');
        return { saved: false, mode: mode, reason: reason, error: String(e && e.message || e) };
      }
      memoryValue = text;

      if (storage) {
        try {
          storage.setItem(key, text);
          var back = null;
          try { back = storage.getItem(key); } catch (e2) { back = null; }
          if (back === text) {
            setMode('storage', null);
            return { saved: true, mode: 'storage', reason: null, bytes: byteLength(text) };
          }
          setMode('memory', 'verify-failed');
        } catch (e) {
          if (isQuotaError(e)) { setMode('memory', 'quota'); }
          else { setMode('memory', reason === 'storage-unavailable' ? 'storage-unavailable' : 'storage-error'); }
        }
      } else {
        setMode('memory', 'no-storage');
      }
      return { saved: false, mode: mode, reason: reason, bytes: byteLength(text) };
    }

    function clear() {
      memoryValue = null;
      if (storage) {
        try { storage.removeItem(key); } catch (e) { /* ignore */ }
      }
    }

    return {
      key: key,
      load: load,
      save: save,
      clear: clear,
      getMode: function () { return { mode: mode, reason: reason, reasonText: reason ? (MEMORY_REASONS[reason] || reason) : null }; },
      onChange: function (fn) {
        if (typeof fn === 'function') { listeners.push(fn); }
        return function off() {
          var i = listeners.indexOf(fn);
          if (i !== -1) { listeners.splice(i, 1); }
        };
      }
    };
  }

  // ------------------------------------------------------------------ sample

  function sampleState(opts) {
    opts = opts || {};
    var now = opts.now || nowIso();
    var rows = [
      ['e-sample-1', '2025-11-14', 51200, 'Oil & Filter', 'Engine oil and filter change (fictional sample record)', 'Oil filter OF-2044', 68.5, 'FAKE-RCPT-0001', 'Sample data — replace with your own records.', '2026-05-14', 61200],
      ['e-sample-2', '2026-02-03', 56150, 'Tires', 'Tire rotation and pressure check (fictional sample record)', '', 35, 'FAKE-RCPT-0002', '', null, 76150],
      ['e-sample-3', '2026-05-10', 61240, 'Oil & Filter', 'Engine oil and filter change (fictional sample record)', 'Oil filter OF-2044, air filter AF-77', 74.25, 'FAKE-RCPT-0003', '', '2026-11-10', 71240],
      ['e-sample-4', '2026-08-21', 65300, 'Brakes', 'Front brake pads replaced (fictional sample record)', 'Pad set BR-9912', 210.9, 'FAKE-RCPT-0004', 'Squeal noted before replacement.', null, 85300]
    ];
    var state = createState({ now: now, unit: 'km' });
    state.vehicle = { nickname: 'Sample Sedan (fictional vehicle — not a real car)', odometer: 68450, unit: 'km' };
    state.entries = rows.map(function (r) {
      return {
        id: r[0],
        date: r[1],
        mileage: r[2],
        category: r[3],
        description: r[4],
        parts: r[5],
        cost: r[6],
        receipt: r[7],
        notes: r[8],
        nextDate: r[9],
        nextMileage: r[10],
        createdAt: now
      };
    });
    return state;
  }

  // ------------------------------------------------------------------ exports

  // UNITS, escapeHtml and buildReportText are exported for the documented
  // public API and the unit tests even though app.js does not call them (the
  // UI renders exclusively via textContent). buildReportText is the plain-text
  // sibling of the DOM print report in app.js — keep their wording in step.
  return {
    FORMAT: FORMAT,
    VERSION: VERSION,
    UNITS: UNITS,
    LIMITS: LIMITS,
    MEMORY_REASONS: MEMORY_REASONS,
    STORAGE_KEY: STORAGE_KEY,

    isPlainObject: isPlainObject,
    isRealDate: isRealDate,
    byteLength: byteLength,
    escapeHtml: escapeHtml,
    formatInt: formatInt,
    makeId: makeId,

    validateVehicle: validateVehicle,
    validateEntry: validateEntry,
    validateState: validateState,

    createState: createState,
    setVehicle: setVehicle,
    addEntry: addEntry,
    updateEntry: updateEntry,
    removeEntry: removeEntry,

    sortEntries: sortEntries,
    computeSchedule: computeSchedule,
    describeSchedule: describeSchedule,
    filterEntries: filterEntries,
    summarize: summarize,

    serializeState: serializeState,
    parseState: parseState,
    importState: importState,
    exportFilename: exportFilename,
    buildReportText: buildReportText,

    createStore: createStore,
    sampleState: sampleState
  };
});
