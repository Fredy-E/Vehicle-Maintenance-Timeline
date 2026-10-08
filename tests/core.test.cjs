'use strict';
/**
 * Vehicle Maintenance Timeline — core unit tests.
 *
 * These tests are written BEFORE the implementation (TDD): the first run
 * against the empty core.js stub is the recorded RED phase, the run after the
 * implementation is the recorded GREEN phase (see tests/evidence/).
 *
 * Run with:   node tests/core.test.cjs
 *
 * Scope: the pure core module only (../core.js). No DOM, no browser, no disk.
 * Everything here runs in plain Node with zero dependencies.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../core.js');

// ----------------------------------------------------------------- fixtures

const TODAY = '2026-10-08';
const FIXED_NOW = '2026-10-08T00:00:00.000Z';

const veh = (odometer, unit) => ({ nickname: 'Testmobile', odometer, unit: unit || 'km' });

const baseEntry = (over) =>
  Object.assign(
    {
      date: '2026-05-01',
      mileage: 42000,
      category: 'Oil & Filter',
      description: 'Oil change',
      parts: '',
      cost: null,
      receipt: '',
      notes: '',
      nextDate: null,
      nextMileage: null,
    },
    over
  );

const clone = (v) => JSON.parse(JSON.stringify(v));

function buildFullState() {
  let s = M.createState({ now: FIXED_NOW });
  s = M.setVehicle(s, { nickname: 'Testmobile', odometer: 60000, unit: 'km' }, { now: FIXED_NOW }).value;
  s = M.addEntry(
    s,
    {
      date: '2026-05-01',
      mileage: 56150,
      category: 'Oil & Filter',
      description: 'Oil change',
      parts: 'OF-1 filter',
      cost: 68.5,
      receipt: 'R-1',
      notes: 'note one',
      nextDate: '2026-11-01',
      nextMileage: 66000,
    },
    { id: 'e-fixed-1', now: FIXED_NOW }
  ).value;
  s = M.addEntry(
    s,
    {
      date: '2026-08-21',
      mileage: 65300,
      category: 'Brakes',
      description: 'Pads replaced',
      nextMileage: 85300,
    },
    { id: 'e-fixed-2', now: FIXED_NOW }
  ).value;
  return s;
}

// ------------------------------------------------------------------- dates

describe('date validation (real calendar dates only)', () => {
  it('accepts real calendar dates, including leap years and range edges', () => {
    for (const d of ['2024-02-29', '2026-10-08', '1999-12-31', '1900-01-01', '2100-12-31']) {
      assert.equal(M.isRealDate(d), true, d + ' should be a real date');
    }
  });

  it('rejects impossible dates (Feb 30, Apr 31, non-leap Feb 29, 2100 is not a leap year)', () => {
    for (const d of ['2025-02-30', '2023-02-29', '2100-02-29', '2025-04-31', '2025-06-31']) {
      assert.equal(M.isRealDate(d), false, d + ' is impossible and must be rejected');
    }
  });

  it('rejects malformed shapes, out-of-range years and non-strings', () => {
    for (const d of ['2026-13-01', '2026-00-10', '2026-10-00', '0000-01-01', '1899-12-31', '2101-01-01', '25-01-01', '2026-1-1', '2026-10-8', '2026/10/08', '2026-10-08T00:00:00Z', '', null, undefined, 20261008]) {
      assert.equal(M.isRealDate(d), false, JSON.stringify(d) + ' must be rejected');
    }
  });

  it('validateEntry rejects an impossible date with a date-scoped error', () => {
    const r = M.validateEntry(baseEntry({ date: '2025-02-30' }));
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].path, 'entry.date');
  });

  it('treats empty optional next-due dates as "not set" (null)', () => {
    const r = M.validateEntry(baseEntry({ nextDate: '' }));
    assert.equal(r.ok, true);
    assert.equal(r.value.nextDate, null);
  });
});

// ------------------------------------------------------- numeric constraints

describe('numeric constraints', () => {
  it('accepts whole-number mileage from 0 to 10,000,000 only', () => {
    assert.equal(M.validateEntry(baseEntry({ mileage: 0 })).ok, true);
    assert.equal(M.validateEntry(baseEntry({ mileage: 123456 })).ok, true);
    assert.equal(M.validateEntry(baseEntry({ mileage: 10000000 })).ok, true);
    for (const bad of [-1, 1.5, 10000001, NaN, Infinity, -Infinity, '5000', true, null, undefined, [], {}]) {
      const r = M.validateEntry(baseEntry({ mileage: bad }));
      assert.equal(r.ok, false, 'mileage ' + JSON.stringify(bad) + ' must be rejected');
      assert.equal(r.errors[0].path, 'entry.mileage');
    }
  });

  it('requires a mileage on every entry', () => {
    const r = M.validateEntry(baseEntry({ mileage: undefined }));
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /required/i);
  });

  it('validates vehicle odometer with the same rules but allows "unknown" (null)', () => {
    assert.equal(M.validateVehicle(veh(null)).ok, true);
    assert.equal(M.validateVehicle(veh(0)).ok, true);
    for (const bad of [-5, 2.5, 10000001, '123', NaN]) {
      assert.equal(M.validateVehicle(veh(bad)).ok, false, 'odometer ' + JSON.stringify(bad));
    }
  });

  it('rounds cost to at most 2 decimals and rejects nonsense', () => {
    const ok1 = M.validateEntry(baseEntry({ cost: 0 }));
    assert.equal(ok1.ok, true);
    assert.equal(ok1.value.cost, 0);
    assert.equal(M.validateEntry(baseEntry({ cost: 12.346 })).value.cost, 12.35);
    assert.equal(M.validateEntry(baseEntry({ cost: null })).value.cost, null);
    for (const bad of [-0.01, 10000001, NaN, Infinity, '10', true, [], {}]) {
      const r = M.validateEntry(baseEntry({ cost: bad }));
      assert.equal(r.ok, false, 'cost ' + JSON.stringify(bad) + ' must be rejected');
      assert.equal(r.errors[0].path, 'entry.cost');
    }
  });

  it('rounds half-cent costs up despite binary floating point (1.005 → 1.01, 10.999 → 11)', () => {
    assert.equal(M.validateEntry(baseEntry({ cost: 1.005 })).value.cost, 1.01, '1.005 is stored as 1.00499999999999989… and used to round down to 1');
    assert.equal(M.validateEntry(baseEntry({ cost: 2.675 })).value.cost, 2.68);
    assert.equal(M.validateEntry(baseEntry({ cost: 10.999 })).value.cost, 11, 'non-boundary values keep their previous result');
    assert.equal(M.validateEntry(baseEntry({ cost: 0.1 })).value.cost, 0.1);
    assert.equal(M.validateEntry(baseEntry({ cost: 12.346 })).value.cost, 12.35, 'the original rounding case is unchanged');
  });

  it('enforces string length bounds on description, notes, parts, receipt and nickname', () => {
    assert.equal(M.validateEntry(baseEntry({ description: 'x'.repeat(2000) })).ok, true);
    assert.equal(M.validateEntry(baseEntry({ description: 'x'.repeat(2001) })).ok, false);
    assert.equal(M.validateEntry(baseEntry({ description: '   ' })).ok, false);
    assert.equal(M.validateEntry(baseEntry({ notes: 'x'.repeat(4000) })).ok, true);
    assert.equal(M.validateEntry(baseEntry({ notes: 'x'.repeat(4001) })).ok, false);
    assert.equal(M.validateEntry(baseEntry({ parts: 'x'.repeat(501) })).ok, false);
    assert.equal(M.validateEntry(baseEntry({ receipt: 'x'.repeat(201) })).ok, false);
    assert.equal(M.validateVehicle({ nickname: 'n'.repeat(60), odometer: null, unit: 'km' }).ok, true);
    assert.equal(M.validateVehicle({ nickname: 'n'.repeat(61), odometer: null, unit: 'km' }).ok, false);
  });

  it('rejects unknown fields (strict schema)', () => {
    const r = M.validateEntry(baseEntry({ serial: 'XYZ' }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.path === 'entry.serial' && /unexpected field/.test(e.message)));
  });
});

// ----------------------------------------------------------- km/mi policy

describe('km/mi unit policy (single unit, no conversion, no silent mixing)', () => {
  it('accepts exactly "km" or "mi" as the unit and requires it', () => {
    assert.equal(M.validateVehicle({ nickname: 'a', odometer: null, unit: 'km' }).ok, true);
    assert.equal(M.validateVehicle({ nickname: 'a', odometer: null, unit: 'mi' }).ok, true);
    assert.equal(M.validateVehicle({ nickname: 'a', odometer: null, unit: 'KM' }).ok, false);
    assert.equal(M.validateVehicle({ nickname: 'a', odometer: null, unit: 'miles' }).ok, false);
    assert.equal(M.validateVehicle({ nickname: 'a', odometer: null }).ok, false);
  });

  it('createState defaults to km and honours an explicit unit', () => {
    assert.equal(M.createState({ now: FIXED_NOW }).vehicle.unit, 'km');
    assert.equal(M.createState({ now: FIXED_NOW, unit: 'mi' }).vehicle.unit, 'mi');
  });

  it('refuses a unit change that would silently re-label existing records', () => {
    const s = buildFullState();
    const r = M.setVehicle(s, { nickname: 'Testmobile', odometer: 60100, unit: 'mi' }, { now: FIXED_NOW });
    assert.equal(r.ok, false);
    assert.match(r.errors[0].message, /confirmUnitChange/);
  });

  it('allows a confirmed unit change and never converts stored numbers', () => {
    const s = buildFullState();
    const before = clone(s.entries);
    const r = M.setVehicle(
      s,
      { nickname: 'Testmobile', odometer: 60100, unit: 'mi' },
      { now: FIXED_NOW, confirmUnitChange: true }
    );
    assert.equal(r.ok, true);
    assert.equal(r.value.vehicle.unit, 'mi');
    assert.deepEqual(r.value.entries, before, 'entry numbers must be untouched by a unit re-label');
    assert.equal(r.value.vehicle.odometer, 60100, 'odometer numbers are never converted');
    assert.equal(r.value.entries[0].mileage, 56150);
  });

  it('allows changing the unit freely while there are no records', () => {
    const s = M.createState({ now: FIXED_NOW });
    const r = M.setVehicle(s, { nickname: 'New', odometer: null, unit: 'mi' }, { now: FIXED_NOW });
    assert.equal(r.ok, true);
    assert.equal(r.value.vehicle.unit, 'mi');
  });
});

// --------------------------------------------------------------- stable sort

describe('stable sort (newest first, mileage tiebreak, insertion order kept)', () => {
  it('sorts by date descending', () => {
    const a = { date: '2026-01-01', mileage: 1, id: 'a' };
    const b = { date: '2026-03-01', mileage: 1, id: 'b' };
    assert.deepEqual(M.sortEntries([a, b]).map((e) => e.id), ['b', 'a']);
  });

  it('breaks same-date ties by mileage descending', () => {
    const rows = [
      { date: '2026-05-01', mileage: 100, id: 'x' },
      { date: '2026-05-01', mileage: 300, id: 'y' },
      { date: '2026-05-01', mileage: 200, id: 'z' },
    ];
    assert.deepEqual(M.sortEntries(rows).map((e) => e.id), ['y', 'z', 'x']);
  });

  it('keeps insertion order for fully equal records (stability)', () => {
    const rows = [
      { date: '2026-05-01', mileage: 100, id: 'a' },
      { date: '2026-05-01', mileage: 100, id: 'b' },
      { date: '2026-05-01', mileage: 100, id: 'c' },
    ];
    assert.deepEqual(M.sortEntries(rows).map((e) => e.id), ['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const rows = [
      { date: '2026-01-01', mileage: 5, id: 'a' },
      { date: '2026-06-01', mileage: 1, id: 'b' },
    ];
    const snapshot = clone(rows);
    M.sortEntries(rows);
    assert.deepEqual(rows, snapshot);
  });
});

// ---------------------------------------------------------------- schedules

describe('user-defined schedules (overdue / due / unknown — no inferred intervals)', () => {
  const entry = (over) => Object.assign(baseEntry({ nextDate: null, nextMileage: null }), over);

  it('no criteria at all → unknown', () => {
    const r = M.computeSchedule(entry({}), veh(60000), TODAY);
    assert.equal(r.status, 'unknown');
    assert.equal(r.date, null);
    assert.equal(r.mileage, null);
  });

  it('date criterion: future and today → due, past → overdue', () => {
    assert.equal(M.computeSchedule(entry({ nextDate: '2026-11-01' }), veh(60000), TODAY).status, 'due');
    assert.equal(M.computeSchedule(entry({ nextDate: TODAY }), veh(60000), TODAY).status, 'due');
    assert.equal(M.computeSchedule(entry({ nextDate: '2026-10-07' }), veh(60000), TODAY).status, 'overdue');
  });

  it('mileage criterion: below/at target → due, past target → overdue, unknown odometer → unknown', () => {
    assert.equal(M.computeSchedule(entry({ nextMileage: 62000 }), veh(60000), TODAY).status, 'due');
    assert.equal(M.computeSchedule(entry({ nextMileage: 60000 }), veh(60000), TODAY).status, 'due');
    assert.equal(M.computeSchedule(entry({ nextMileage: 58000 }), veh(60000), TODAY).status, 'overdue');
    assert.equal(M.computeSchedule(entry({ nextMileage: 58000 }), veh(null), TODAY).status, 'unknown');
    assert.equal(M.computeSchedule(entry({ nextMileage: 58000 }), null, TODAY).status, 'unknown');
  });

  it('mixes criteria correctly: any overdue wins, otherwise any due, otherwise unknown', () => {
    const mixed = entry({ nextDate: '2026-01-01', nextMileage: 999999 });
    const r = M.computeSchedule(mixed, veh(60000), TODAY);
    assert.equal(r.status, 'overdue');
    assert.equal(r.date, 'overdue');
    assert.equal(r.mileage, 'due');

    // mileage criterion present but odometer unknown → that side alone is unknown
    const onlyMileage = entry({ nextMileage: 70000 });
    const r2 = M.computeSchedule(onlyMileage, veh(null), TODAY);
    assert.equal(r2.status, 'unknown');
    assert.equal(r2.mileage, 'unknown');
  });

  it('an unparseable "today" cannot be classified → unknown, never overdue', () => {
    const r = M.computeSchedule(entry({ nextDate: '2026-01-01' }), veh(60000), 'not-a-date');
    assert.equal(r.status, 'unknown');
    assert.equal(r.date, 'unknown');
  });

  it('describeSchedule produces human words with the relevant dates/mileage', () => {
    const txt = M.describeSchedule(entry({ nextDate: '2099-01-01' }), veh(60000), TODAY);
    assert.match(txt, /2099-01-01/);
    assert.match(txt, /due/i);
    const txt2 = M.describeSchedule(entry({ nextMileage: 58000 }), veh(60000), TODAY);
    assert.match(txt2, /58,000/);
  });
});

// --------------------------------------------------------- filter + summary

describe('filters and summary', () => {
  const rows = [
    baseEntry({ date: '2026-01-01', mileage: 40000, category: 'Oil & Filter', description: 'Oil change' }),
    baseEntry({ date: '2026-02-01', mileage: 41000, category: 'Brakes', description: 'Brake pads replaced', receipt: 'RCPT-77' }),
    baseEntry({ date: '2026-03-01', mileage: 42000, category: 'Inspection', description: 'Multi-point check and brake fluid top-up', nextDate: '2020-01-01' }),
  ];

  it('search is case-insensitive across description, category, parts, receipt, notes, date and mileage', () => {
    assert.equal(M.filterEntries(rows, { query: 'BRAKE' }).length, 2);
    assert.equal(M.filterEntries(rows, { query: 'rcpt-77' }).length, 1);
    assert.equal(M.filterEntries(rows, { query: 'zzz-none' }).length, 0);
    assert.equal(M.filterEntries(rows, { query: '' }).length, 3);
  });

  it('category filter matches the category field exactly (not the description)', () => {
    const r = M.filterEntries(rows, { category: 'Brakes' });
    assert.equal(r.length, 1);
    assert.equal(r[0].category, 'Brakes');
  });

  it('status filter uses the schedule computation with injected vehicle/today', () => {
    const ctx = { vehicle: veh(60000), today: TODAY };
    const overdue = M.filterEntries(rows, { status: 'overdue' }, ctx);
    assert.equal(overdue.length, 1);
    assert.match(overdue[0].description, /Multi-point/);
    assert.equal(M.filterEntries(rows, { status: 'unknown' }, ctx).length, 2);
    assert.equal(M.filterEntries(rows, { status: 'due' }, ctx).length, 0);
  });

  it('summarize counts records, totals cost and classifies schedules', () => {
    const priced = [
      baseEntry({ cost: 10.1 }),
      baseEntry({ cost: 20.2 }),
      baseEntry({ cost: null }),
    ];
    const s = M.summarize(priced, veh(1000), TODAY);
    assert.equal(s.count, 3);
    assert.equal(s.totalCost, 30.3);
    assert.equal(s.statuses.unknown, 3);
    assert.ok(Array.isArray(s.categories));
    assert.equal(s.latest.date, '2026-05-01');
    assert.equal(M.summarize([], veh(1), TODAY).totalCost, null);
  });

  it('summarize keeps prototype-named categories as ordinary keys (no dropped "__proto__", no garbage counts)', () => {
    const rows = [
      baseEntry({ category: '__proto__', description: 'proto-named' }),
      baseEntry({ category: 'constructor', description: 'ctor one' }),
      baseEntry({ category: 'constructor', description: 'ctor two' }),
      baseEntry({ category: 'toString', description: 'str-named' }),
    ];
    const s = M.summarize(rows, veh(1), TODAY);
    assert.deepEqual(s.categories.map((c) => c.category), ['__proto__', 'constructor', 'toString']);
    const counts = new Map(s.categories.map((c) => [c.category, c.count]));
    assert.equal(counts.get('__proto__'), 1, 'a "__proto__" category must appear like any other');
    assert.equal(counts.get('constructor'), 2, '"constructor" must not read Object.prototype');
    assert.equal(counts.get('toString'), 1);
    for (const c of s.categories) {
      assert.equal(typeof c.count, 'number', 'counts must be numbers, never function-source strings: ' + JSON.stringify(c));
    }
  });

  it('category filtering handles prototype-named categories', () => {
    const rows = [
      baseEntry({ category: '__proto__', description: 'proto-named' }),
      baseEntry({ category: 'constructor', description: 'ctor-named' }),
      baseEntry({ category: 'Brakes', description: 'brakes' }),
    ];
    const proto = M.filterEntries(rows, { category: '__proto__' });
    assert.equal(proto.length, 1);
    assert.equal(proto[0].description, 'proto-named');
    const ctor = M.filterEntries(rows, { category: 'constructor' });
    assert.equal(ctor.length, 1);
    assert.equal(ctor[0].description, 'ctor-named');
  });

  it('importing prototype-named categories validates and round-trips intact', () => {
    const doc = {
      format: 'vehicle-maintenance-timeline',
      version: 1,
      updatedAt: FIXED_NOW,
      vehicle: null,
      entries: [
        baseEntry({ id: 'e-proto', category: '__proto__', description: 'proto-named' }),
        baseEntry({ id: 'e-ctor', category: 'constructor', description: 'ctor-named' }),
      ],
    };
    const r = M.parseState(JSON.stringify(doc));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.value.entries.map((e) => e.category), ['__proto__', 'constructor']);
    const s = M.summarize(r.value.entries, null, TODAY);
    assert.deepEqual(s.categories.map((c) => c.category), ['__proto__', 'constructor']);
  });
});

// ---------------------------------------------------------------- roundtrip

describe('import/export roundtrip', () => {
  it('serialize → parse returns an identical normalized state, and re-serializes byte-identical', () => {
    const s = buildFullState();
    const text = M.serializeState(s);
    const r = M.parseState(text);
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual(r.value, s);
    assert.equal(M.serializeState(r.value), text);
  });

  it('serialized output is canonical (format first, versioned)', () => {
    const text = M.serializeState(buildFullState());
    assert.ok(text.includes('"format": "vehicle-maintenance-timeline"'));
    assert.ok(text.includes('"version": 1'));
  });

  it('importState never mutates the current state (atomic by construction)', () => {
    const current = buildFullState();
    const snapshot = clone(current);
    const text = M.serializeState(current);
    const r = M.importState(current, text);
    assert.equal(r.ok, true);
    assert.notEqual(r.value, current);
    assert.deepEqual(current, snapshot);
  });

  it('the bundled sample is valid, explicitly fictional, and roundtrips', () => {
    const sample = M.sampleState({ now: FIXED_NOW });
    const v = M.validateState(sample);
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.equal(sample.entries.length, 4);
    assert.match(sample.vehicle.nickname, /fictional/i);
    for (const e of sample.entries) assert.match(e.description, /fictional/i);
    const r = M.parseState(M.serializeState(sample));
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, v.value);
  });

  it('exportFilename is date-stamped and JSON', () => {
    assert.equal(M.exportFilename('2026-10-08'), 'maintenance-timeline-backup-2026-10-08.json');
  });
});

// -------------------------------------- malformed / oversize / preservation

describe('strict import validation, bounds and existing-state preservation', () => {
  it('rejects non-JSON, empty documents and non-state JSON', () => {
    for (const bad of ['', '   ', '{', 'not json at all', '[]', 'null', '42']) {
      const r = M.parseState(bad);
      assert.equal(r.ok, false, JSON.stringify(bad) + ' must be rejected');
      assert.ok(r.errors.length > 0);
    }
  });

  it('rejects wrong format name, wrong version and wrong entry container type', () => {
    const good = buildFullState();
    const wrongFormat = M.parseState(JSON.stringify(Object.assign({}, good, { format: 'something-else' })));
    assert.equal(wrongFormat.ok, false);
    assert.ok(wrongFormat.errors.some((e) => e.path === '$.format'));

    const wrongVersion = M.parseState(JSON.stringify(Object.assign({}, good, { version: 2 })));
    assert.equal(wrongVersion.ok, false);
    assert.ok(wrongVersion.errors.some((e) => e.path === '$.version'));

    const wrongEntries = M.parseState(JSON.stringify(Object.assign({}, good, { entries: 'nope' })));
    assert.equal(wrongEntries.ok, false);
    assert.ok(wrongEntries.errors.some((e) => e.path === '$.entries'));
  });

  it('rejects unknown keys at state and entry level', () => {
    const good = buildFullState();
    const r = M.parseState(JSON.stringify(Object.assign({}, good, { telemetry: true })));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /unexpected field/.test(e.message)));

    const bad = clone(good);
    bad.entries[0].evil = 1;
    const r2 = M.parseState(JSON.stringify(bad));
    assert.equal(r2.ok, false);
    assert.ok(r2.errors.some((e) => e.path === '$.entries[0].evil'));
  });

  it('rejects type violations inside entries (string mileage, bad date)', () => {
    const bad = clone(buildFullState());
    bad.entries[0].mileage = '56150';
    const r = M.parseState(JSON.stringify(bad));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.path === '$.entries[0].mileage'));

    const bad2 = clone(buildFullState());
    bad2.entries[1].date = '2026-02-30';
    const r2 = M.parseState(JSON.stringify(bad2));
    assert.equal(r2.ok, false);
    assert.ok(r2.errors.some((e) => e.path === '$.entries[1].date'));
  });

  it('enforces the entry-count bound', () => {
    const many = clone(buildFullState());
    for (let i = 0; i < 4; i++) many.entries.push(clone(many.entries[0]));
    const r = M.parseState(JSON.stringify(many), { maxEntries: 3 });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /too many entries/.test(e.message)));
  });

  it('enforces the byte-size bound (custom and default limits)', () => {
    const good = M.serializeState(buildFullState());
    const r = M.parseState(good, { maxBytes: 64 });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /too large/.test(e.message)));

    const huge = 'x'.repeat(2100000); // > 2 MiB default limit
    const r2 = M.parseState(huge);
    assert.equal(r2.ok, false);
    assert.ok(r2.errors.some((e) => /too large/.test(e.message)));
  });

  it('caps the error list instead of exploding on garbage input', () => {
    const junk = { format: 'vehicle-maintenance-timeline', version: 1, updatedAt: FIXED_NOW, vehicle: null, entries: [] };
    for (let i = 0; i < 300; i++) junk.entries.push({});
    const r = M.parseState(JSON.stringify(junk));
    assert.equal(r.ok, false);
    assert.ok(r.errors.length > 0);
    assert.ok(r.errors.length <= M.LIMITS.maxErrors + 1, 'error list must be capped, got ' + r.errors.length);
  });

  it('a failed import preserves the existing state (atomic swap simulation)', () => {
    let current = buildFullState();
    const snapshot = clone(current);
    const badDocs = ['{', JSON.stringify({ format: 'x' }), JSON.stringify(Object.assign({}, current, { version: 99 })), JSON.stringify(Object.assign({}, current, { entries: 5 }))];
    for (const bad of badDocs) {
      const r = M.parseState(bad);
      assert.equal(r.ok, false);
      if (r.ok) current = r.value; // literally never taken
    }
    assert.deepEqual(current, snapshot, 'existing state must be untouched after failed imports');
  });

  it('tolerates a UTF-8 BOM prefix (files saved by Windows editors)', () => {
    const text = '\uFEFF' + M.serializeState(buildFullState());
    const r = M.parseState(text);
    assert.equal(r.ok, true);
  });

  it('import leniency is pinned: missing vehicle → null, missing/empty updatedAt → now; bad values still fail', () => {
    const minimal = { format: 'vehicle-maintenance-timeline', version: 1, entries: [] };
    const r = M.parseState(JSON.stringify(minimal));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.value.vehicle, null, 'a document without "vehicle" must import with vehicle null');
    const stamped = Date.parse(r.value.updatedAt);
    assert.ok(Number.isFinite(stamped), 'a missing updatedAt must be stamped with an ISO timestamp');
    assert.ok(Math.abs(Date.now() - stamped) < 60000, 'the stamp must be the current time');

    for (const updatedAt of [null, '']) {
      const r2 = M.parseState(JSON.stringify(Object.assign({}, minimal, { updatedAt })));
      assert.equal(r2.ok, true, 'updatedAt ' + JSON.stringify(updatedAt) + ' must be stamped: ' + JSON.stringify(r2.errors));
      assert.ok(Number.isFinite(Date.parse(r2.value.updatedAt)));
    }

    const bad = M.parseState(JSON.stringify(Object.assign({}, minimal, { updatedAt: 'not-a-timestamp' })));
    assert.equal(bad.ok, false, 'a present but unparseable updatedAt must still fail');
    assert.ok(bad.errors.some((e) => e.path === '$.updatedAt'));
  });
});

// ----------------------------------------------------------------- mutations

describe('state mutations (immutable, validated, normalized)', () => {
  it('createState is valid and roundtrips through validateState unchanged', () => {
    const s = M.createState({ now: FIXED_NOW });
    const v = M.validateState(s);
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    assert.deepEqual(v.value, s);
    assert.deepEqual(s.entries, []);
    assert.equal(s.version, 1);
    assert.equal(s.format, 'vehicle-maintenance-timeline');
  });

  it('addEntry assigns an id and createdAt, appends, and leaves the input state untouched', () => {
    const s = M.createState({ now: FIXED_NOW });
    const snapshot = clone(s);
    const r = M.addEntry(s, baseEntry({ description: 'First service' }), { now: FIXED_NOW });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.value.entries.length, 1);
    const added = r.value.entries[0];
    assert.match(added.id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
    assert.equal(added.createdAt, FIXED_NOW);
    assert.equal(added.description, 'First service');
    assert.deepEqual(s, snapshot, 'addEntry must not mutate its input');
  });

  it('addEntry rejects an invalid entry and reports field-level errors', () => {
    const s = M.createState({ now: FIXED_NOW });
    const r = M.addEntry(s, { date: '2025-02-30', mileage: -1, description: '' }, { now: FIXED_NOW });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.path === 'entry.date'));
    assert.ok(r.errors.some((e) => e.path === 'entry.mileage'));
    assert.ok(r.errors.some((e) => e.path === 'entry.description'));
  });

  it('addEntry rejects duplicate ids', () => {
    const s = buildFullState();
    const r = M.addEntry(s, baseEntry({}), { id: 'e-fixed-1', now: FIXED_NOW });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /duplicate id/.test(e.message)));
  });

  it('updateEntry fully re-validates the merged record and blocks bad patches', () => {
    const s = buildFullState();
    const snapshot = clone(s);
    const bad = M.updateEntry(s, 'e-fixed-1', { mileage: -5 }, { now: FIXED_NOW });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => e.path === 'entry.mileage'));
    const unknownKey = M.updateEntry(s, 'e-fixed-1', { wat: 1 }, { now: FIXED_NOW });
    assert.equal(unknownKey.ok, false);
    assert.deepEqual(s, snapshot, 'failed updates must not mutate the state');

    const goodR = M.updateEntry(s, 'e-fixed-1', { description: 'Oil change (updated)', cost: 70 }, { now: FIXED_NOW });
    assert.equal(goodR.ok, true, JSON.stringify(goodR.errors));
    const updated = goodR.value.entries.find((e) => e.id === 'e-fixed-1');
    assert.equal(updated.description, 'Oil change (updated)');
    assert.equal(updated.cost, 70);
    assert.equal(updated.createdAt, FIXED_NOW, 'createdAt is immutable');
    assert.equal(updated.date, '2026-05-01', 'untouched fields survive the patch');
  });

  it('updateEntry cannot change an entry id', () => {
    const s = buildFullState();
    const r = M.updateEntry(s, 'e-fixed-1', { id: 'e-attacker' }, { now: FIXED_NOW });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.ok(r.value.entries.some((e) => e.id === 'e-fixed-1'), 'original id stays');
    assert.ok(!r.value.entries.some((e) => e.id === 'e-attacker'));
  });

  it('updateEntry/removeEntry fail cleanly on unknown ids', () => {
    const s = buildFullState();
    assert.equal(M.updateEntry(s, 'nope', { description: 'x' }).ok, false);
    assert.equal(M.removeEntry(s, 'nope', { now: FIXED_NOW }).ok, false);
  });

  it('removeEntry deletes exactly one record and leaves the rest untouched', () => {
    const s = buildFullState();
    const snapshot = clone(s);
    const r = M.removeEntry(s, 'e-fixed-1', { now: FIXED_NOW });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value.entries.map((e) => e.id), ['e-fixed-2']);
    assert.deepEqual(s, snapshot);
  });

  it('setVehicle rejects null/undefined with a field-level error instead of throwing', () => {
    for (const bad of [null, undefined]) {
      const s = buildFullState();
      let r;
      assert.doesNotThrow(() => { r = M.setVehicle(s, bad, { now: FIXED_NOW }); }, 'setVehicle(state, ' + String(bad) + ') must not throw');
      assert.equal(r.ok, false);
      assert.equal(r.errors[0].path, 'vehicle');
      assert.match(r.errors[0].message, /required/i);
    }
    // A state without a vehicle must reject the call too — previously this
    // silently nulled the vehicle, while a state with one threw a TypeError.
    const empty = M.createState({ now: FIXED_NOW });
    const r2 = M.setVehicle(empty, null, { now: FIXED_NOW });
    assert.equal(r2.ok, false);
    assert.equal(empty.vehicle.unit, 'km', 'a rejected call must not mutate the state');
  });
});

// --------------------- duplicate ids + entry-count cap (round-trip integrity)

describe('duplicate ids and the entry-count cap (round-trip integrity)', () => {
  const rawDoc = (entries) => ({
    format: 'vehicle-maintenance-timeline',
    version: 1,
    updatedAt: FIXED_NOW,
    vehicle: null,
    entries,
  });

  const rawStateWithEntries = (n) => {
    const entries = [];
    for (let i = 0; i < n; i++) {
      entries.push({ id: 'c' + i, date: '2026-05-01', mileage: i, description: 'R' + i });
    }
    return {
      format: 'vehicle-maintenance-timeline',
      version: 1,
      updatedAt: FIXED_NOW,
      vehicle: { nickname: 'Cap test', odometer: null, unit: 'km' },
      entries,
    };
  };

  it('rejects a duplicate id pair at import, atomically and visibly', () => {
    const dup = rawDoc([
      baseEntry({ id: 'e-dup', description: 'First service' }),
      baseEntry({ id: 'e-dup', description: 'Second service' }),
    ]);
    const text = JSON.stringify(dup);

    const r = M.parseState(text);
    assert.equal(r.ok, false, 'two entries sharing id "e-dup" must be rejected, not imported');
    const err = r.errors.find((e) => e.path === '$.entries[1].id');
    assert.ok(err, 'the duplicate must be reported at the second occurrence: ' + JSON.stringify(r.errors));
    assert.match(err.message, /duplicate id "e-dup"/);
    assert.match(err.message, /\$\.entries\[0\]/, 'the message points back at the first occurrence');

    const v = M.validateState(dup);
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.path === '$.entries[1].id' && /duplicate id/.test(e.message)));

    const imp = M.importState(buildFullState(), text);
    assert.equal(imp.ok, false, 'importState must reject the same document');
  });

  it('accepts distinct ids that collide with Object.prototype names, and still catches their duplicates', () => {
    const names = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', 'propertyIsEnumerable', 'isPrototypeOf'];
    const okDoc = rawDoc(names.map((id, i) => baseEntry({ id, description: 'Record ' + i })));
    const ok = M.validateState(okDoc);
    assert.equal(ok.ok, true, 'prototype-named ids are legal and distinct: ' + JSON.stringify(ok.errors));
    assert.deepEqual(ok.value.entries.map((e) => e.id), names);

    for (const name of ['constructor', 'toString']) {
      const pair = rawDoc([
        baseEntry({ id: name, description: 'one' }),
        baseEntry({ id: name, description: 'two' }),
      ]);
      const bad = M.validateState(pair);
      assert.equal(bad.ok, false, 'repeating "' + name + '" must be caught like any other duplicate');
      assert.ok(bad.errors.some((e) => e.path === '$.entries[1].id' && e.message.indexOf('duplicate id "' + name + '"') !== -1));
    }

    // "__proto__" itself can never be an id (the first character must be a letter
    // or digit), but the uniqueness check must still not rely on plain-object keys:
    // "constructor"/"toString" above ARE legal ids and would poison a naive map.
    assert.equal(M.validateEntry(baseEntry({ id: '__proto__' })).ok, false);
  });

  it('a rejected duplicate-id import leaves the live state and the saved store untouched', () => {
    const storage = fakeStorage();
    const store = M.createStore({ storage, key: 'vmt-dup-test' });
    let current = buildFullState();
    assert.equal(store.save(current).saved, true);

    const before = clone(current);
    const dupDoc = rawDoc([baseEntry({ id: 'e-dup' }), baseEntry({ id: 'e-dup' })]);
    const r = M.importState(current, JSON.stringify(dupDoc));
    assert.equal(r.ok, false);
    if (r.ok) current = r.value; // never taken — the failed import must not swap state

    assert.deepEqual(current, before, 'the live state must be untouched after a rejected import');
    const loaded = store.load();
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.value, current, 'the store still holds the previous good state');

    const fixed = rawDoc([baseEntry({ id: 'e-dup' }), baseEntry({ id: 'e-dup-2' })]);
    assert.equal(M.importState(current, JSON.stringify(fixed)).ok, true, 'the corrected document still imports');
  });

  it('after a valid import, updateEntry and removeEntry each touch exactly one record', () => {
    const imported = M.parseState(JSON.stringify(rawDoc([
      baseEntry({ id: 'e-dup', description: 'First service' }),
      baseEntry({ id: 'e-dup-2', description: 'Second service' }),
    ])));
    assert.equal(imported.ok, true, JSON.stringify(imported.errors));
    const s = imported.value;
    assert.deepEqual(s.entries.map((e) => e.id), ['e-dup', 'e-dup-2']);

    const updated = M.updateEntry(s, 'e-dup-2', { description: 'Second service (edited)' }, { now: FIXED_NOW });
    assert.equal(updated.ok, true, JSON.stringify(updated.errors));
    assert.equal(updated.value.entries.find((e) => e.id === 'e-dup').description, 'First service', 'editing "e-dup-2" must not edit "e-dup"');
    assert.equal(updated.value.entries.find((e) => e.id === 'e-dup-2').description, 'Second service (edited)');

    const removed = M.removeEntry(s, 'e-dup', { now: FIXED_NOW });
    assert.equal(removed.ok, true);
    assert.deepEqual(removed.value.entries.map((e) => e.id), ['e-dup-2'], 'deleting "e-dup" must remove exactly one record');
  });

  it('addEntry refuses to exceed LIMITS.maxEntries: visible error, immutable state, still round-trips', () => {
    const vFull = M.validateState(rawStateWithEntries(M.LIMITS.maxEntries));
    assert.equal(vFull.ok, true, JSON.stringify(vFull.errors));
    const full = vFull.value;
    assert.equal(full.entries.length, M.LIMITS.maxEntries);
    const snapshot = clone(full);

    const r = M.addEntry(full, baseEntry({ description: 'one too many' }), { id: 'e-over-cap', now: FIXED_NOW });
    assert.equal(r.ok, false, 'adding a record beyond the cap must fail');
    assert.ok(
      r.errors.some((e) => e.message.indexOf(String(M.LIMITS.maxEntries)) !== -1 && /maximum|limit/i.test(e.message)),
      'the cap error must state the limit: ' + JSON.stringify(r.errors)
    );
    assert.deepEqual(full, snapshot, 'a refused add must not touch the state');

    const again = M.parseState(M.serializeState(full));
    assert.equal(again.ok, true, JSON.stringify(again.errors));
    assert.equal(again.value.entries.length, M.LIMITS.maxEntries);
  });

  it('at maxEntries-1 a normal addEntry succeeds and the full state round-trips (export → import)', () => {
    const v = M.validateState(rawStateWithEntries(M.LIMITS.maxEntries - 1));
    assert.equal(v.ok, true, JSON.stringify(v.errors));
    const r = M.addEntry(v.value, baseEntry({ description: 'the 5000th record' }), { id: 'e-cap-last', now: FIXED_NOW });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.value.entries.length, M.LIMITS.maxEntries);

    const text = M.serializeState(r.value);
    const back = M.parseState(text);
    assert.equal(back.ok, true, JSON.stringify(back.errors));
    assert.deepEqual(back.value, r.value, 'the full state must survive export → import');
    assert.equal(M.serializeState(back.value), text, 'and re-serialize byte-identically');
  });
});

// --------------------------------------------------------- storage adapter

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

function quotaStorage() {
  const inner = fakeStorage();
  const api = {
    limit: 2,
    count: 0,
    getItem: inner.getItem,
    removeItem: inner.removeItem,
    setItem: (k, v) => {
      api.count += 1;
      if (api.count > api.limit) {
        const e = new Error('quota exceeded');
        e.name = 'QuotaExceededError';
        throw e;
      }
      inner.setItem(k, v);
    },
    _map: inner._map,
  };
  return api;
}

function disabledStorage() {
  const e = new Error('access denied');
  e.name = 'SecurityError';
  const boom = () => { throw e; };
  return { getItem: boom, setItem: boom, removeItem: boom };
}

function lyingStorage() {
  return { getItem: () => null, setItem: () => {}, removeItem: () => {} };
}

describe('storage adapter (localStorage when available, honest in-memory fallback)', () => {
  it('saves versioned JSON to a working storage and loads it back identically', () => {
    const storage = fakeStorage();
    const store = M.createStore({ storage, key: 'vehicle-maintenance-timeline:v1' });
    assert.equal(store.key, 'vehicle-maintenance-timeline:v1');
    assert.equal(store.getMode().mode, 'storage');
    const s = buildFullState();
    const result = store.save(s);
    assert.equal(result.saved, true);
    assert.equal(result.mode, 'storage');
    assert.equal(result.reason, null);
    assert.ok(storage._map.has('vehicle-maintenance-timeline:v1'));
    const reloaded = M.createStore({ storage, key: 'vehicle-maintenance-timeline:v1' });
    const loaded = reloaded.load();
    assert.equal(loaded.ok, true);
    assert.deepEqual(loaded.value, s);
  });

  it('load on empty storage returns a clean "no data" result', () => {
    const store = M.createStore({ storage: fakeStorage() });
    const loaded = store.load();
    assert.equal(loaded.ok, true);
    assert.equal(loaded.value, null);
  });

  it('switches to in-memory when storage is blocked and never claims a save', () => {
    const store = M.createStore({ storage: disabledStorage() });
    assert.equal(store.getMode().mode, 'memory');
    const loaded = store.load();
    assert.equal(loaded.ok, true);
    assert.equal(loaded.value, null);
    const result = store.save(buildFullState());
    assert.equal(result.saved, false);
    assert.equal(result.mode, 'memory');
    assert.ok(result.reason, 'a reason must be reported');
    assert.ok(['storage-unavailable', 'storage-error'].includes(result.reason));
  });

  it('with no storage at all, mode is memory with reason no-storage', () => {
    const store = M.createStore({});
    assert.equal(store.key, M.STORAGE_KEY, 'the default key is the exported STORAGE_KEY constant');
    assert.equal(store.getMode().mode, 'memory');
    assert.equal(store.getMode().reason, 'no-storage');
    const result = store.save(buildFullState());
    assert.equal(result.saved, false);
    assert.equal(result.reason, 'no-storage');
  });

  it('on QuotaExceededError: first save persists, quota save flips to memory visibly, and recovery is possible', () => {
    const storage = quotaStorage();
    const store = M.createStore({ storage, key: 'vmt-quota-test' });
    const events = [];
    store.onChange((mode, reason) => events.push({ mode, reason }));

    const s1 = buildFullState();
    const first = store.save(s1);
    assert.equal(first.saved, true, 'probe + first save fit in quota');

    const s2 = clone(s1);
    s2.entries[0].notes = 'x'.repeat(500);
    const second = store.save(s2);
    assert.equal(second.saved, false);
    assert.equal(second.mode, 'memory');
    assert.equal(second.reason, 'quota');
    assert.ok(events.some((e) => e.mode === 'memory' && e.reason === 'quota'), 'mode switch must be announced');

    storage.limit = 999; // space freed
    const third = store.save(s2);
    assert.equal(third.saved, true);
    assert.equal(third.mode, 'storage');
    assert.ok(events.some((e) => e.mode === 'storage' && e.reason === null), 'recovery must be announced');
  });

  it('a storage that silently drops writes is detected (never falsely claim saved)', () => {
    const store = M.createStore({ storage: lyingStorage() });
    const result = store.save(buildFullState());
    assert.equal(result.saved, false);
    assert.equal(result.mode, 'memory');
    assert.equal(result.reason, 'verify-failed');
  });

  it('clear() empties storage and memory', () => {
    const storage = fakeStorage();
    const store = M.createStore({ storage });
    store.save(buildFullState());
    store.clear();
    assert.equal(store.load().value, null);
    assert.equal(storage._map.size, 0);
  });
});

// ------------------------------------------------- safe output / escaping

describe('normalized safe output and escaping', () => {
  it('returns exactly the canonical entry keys (no extras, no leaks)', () => {
    const r = M.validateEntry(baseEntry({}));
    assert.equal(r.ok, true);
    assert.deepEqual(
      Object.keys(r.value).sort(),
      ['category', 'cost', 'createdAt', 'date', 'description', 'id', 'mileage', 'nextDate', 'nextMileage', 'notes', 'parts', 'receipt']
    );
  });

  it('trims strings, strips control characters and defaults the category', () => {
    const r = M.validateEntry(baseEntry({ description: '  Oil   change  ', category: '', notes: 'a\u0007b' }));
    assert.equal(r.ok, true);
    assert.equal(r.value.description, 'Oil   change');
    assert.equal(r.value.category, 'General');
    assert.equal(r.value.notes, 'ab');
  });

  it('escapeHtml escapes all five dangerous characters', () => {
    assert.equal(M.escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
    assert.equal(M.escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  });

  it('hostile strings survive a JSON roundtrip unchanged (the UI renders via textContent, not HTML)', () => {
    const hostile = '<img src=x onerror=alert(1)> & "quotes" \'single\'';
    const r = M.validateEntry(baseEntry({ description: hostile }));
    assert.equal(r.ok, true);
    assert.equal(r.value.description, hostile);
    const s = buildFullState();
    s.entries[0].description = hostile;
    const again = M.parseState(M.serializeState(s));
    assert.equal(again.ok, true);
    assert.equal(again.value.entries[0].description, hostile);
  });

  it('buildReportText includes vehicle, records and generated stamp as plain text', () => {
    const text = M.buildReportText(buildFullState(), { today: TODAY });
    assert.match(text, /VEHICLE MAINTENANCE TIMELINE/);
    assert.match(text, /Testmobile/);
    assert.match(text, /Oil change/);
    assert.match(text, /2026-10-08/);
  });

  it('exposes the promised constants', () => {
    assert.equal(M.FORMAT, 'vehicle-maintenance-timeline');
    assert.equal(M.VERSION, 1);
    assert.equal(M.STORAGE_KEY, 'vehicle-maintenance-timeline:v1');
    assert.deepEqual(M.UNITS, ['km', 'mi']);
    assert.equal(M.LIMITS.maxEntries, 5000);
    assert.equal(M.LIMITS.maxBytes, 2097152);
    assert.ok(M.MEMORY_REASONS['quota']);
    assert.ok(M.MEMORY_REASONS['no-storage']);
    assert.equal(M.byteLength('abc'), 3);
    assert.equal(M.byteLength('é'), 2);
  });
});
