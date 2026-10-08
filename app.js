/*!
 * Vehicle Maintenance Timeline — app.js
 *
 * UI layer. Strict rules kept from the spec:
 *  - every user string reaches the page through textContent;
 *    this file contains no innerHTML / insertAdjacentHTML / document.write;
 *  - storage claims are honest: "saved" is only ever shown when the write was
 *    verified, otherwise the UI switches visibly to "in-memory only";
 *  - destructive actions (delete, unit change, sample load, import replace)
 *    always go through an explicit confirmation dialog;
 *  - no network, no timers beyond a UI toast timeout, no telemetry.
 *
 * Test hook: window.MaintenanceApp (see README for the full selector map).
 */
(function () {
  'use strict';

  var M = window.Maintenance;
  if (!M) {
    document.body.textContent = 'core.js failed to load — the app cannot start.';
    return;
  }

  // Single source of truth for the storage key lives in core.js (M.STORAGE_KEY);
  // the literal fallback only guards against a mismatched older core.js.
  var STORAGE_KEY = M.STORAGE_KEY || 'vehicle-maintenance-timeline:v1';
  var DEFAULT_CATEGORIES = ['Oil & Filter', 'Tires', 'Brakes', 'Battery', 'Inspection', 'Repair', 'Other'];
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // --------------------------------------------------------------- DOM refs

  var els = {};
  [
    'storage-status', 'storage-banner', 'storage-banner-text', 'btn-download-raw', 'btn-start-fresh',
    'vehicle-form', 'vehicle-nickname', 'vehicle-odometer', 'vehicle-unit', 'vehicle-save',
    'unit-suffix-odometer', 'unit-suffix-mileage', 'unit-suffix-next',
    'form-title', 'entry-form', 'entry-id', 'entry-date', 'entry-mileage', 'entry-category',
    'entry-description', 'entry-parts', 'entry-cost', 'entry-receipt', 'entry-notes',
    'entry-next-date', 'entry-next-mileage', 'entry-submit', 'entry-cancel', 'entry-errors',
    'category-options',
    'filter-search', 'filter-category', 'filter-status', 'filter-reset', 'list-summary', 'entry-list',
    'btn-export-json', 'btn-print', 'btn-load-sample',
    'import-file', 'import-text', 'import-errors', 'btn-import',
    'confirm-dialog', 'confirm-title', 'confirm-message', 'confirm-cancel', 'confirm-accept',
    'toast', 'print-root', 'entry-card-template'
  ].forEach(function (id) { els[id] = document.getElementById(id); });

  // ------------------------------------------------------------ app state

  var state = M.createState();
  var editingId = null;
  var filters = { query: '', category: '', status: '' };
  var lastSave = null;          // last store.save() result — drives honest toasts
  var storageBlocked = false;   // stored data failed validation; awaits a user decision
  var unreadableRaw = null;     // raw stored text kept for download until decided
  var confirmCallback = null;
  var toastTimer = null;

  var storage = null;
  try { storage = window.localStorage; } catch (e) { storage = null; }
  var store = M.createStore({ storage: storage, key: STORAGE_KEY });

  // ------------------------------------------------------------- utilities

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function formatDisplayDate(iso) {
    if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) { return String(iso || ''); }
    return MONTHS[parseInt(iso.slice(5, 7), 10) - 1] + ' ' + parseInt(iso.slice(8, 10), 10) + ', ' + iso.slice(0, 4);
  }

  function unitOf() {
    return state.vehicle && state.vehicle.unit === 'mi' ? 'mi' : 'km';
  }

  function findEntry(id) {
    for (var i = 0; i < state.entries.length; i++) {
      if (state.entries[i].id === id) { return state.entries[i]; }
    }
    return null;
  }

  function toast(message, kind) {
    var el = els['toast'];
    el.textContent = message;
    el.setAttribute('data-kind', kind || 'ok');
    el.hidden = false;
    if (toastTimer) { clearTimeout(toastTimer); }
    toastTimer = setTimeout(function () { el.hidden = true; }, 6000);
  }

  function downloadText(filename, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function intOrRaw(v) {
    v = String(v === undefined || v === null ? '' : v).trim();
    if (v === '') { return null; }
    return /^\d+$/.test(v) ? parseInt(v, 10) : v; // non-numeric raw strings go to the validator for a real error
  }

  function costOrRaw(v) {
    v = String(v === undefined || v === null ? '' : v).trim();
    if (v === '') { return null; }
    return /^\d+(\.\d+)?$/.test(v) ? parseFloat(v) : v;
  }

  // -------------------------------------------------------------- persistence

  function renderStorageStatus() {
    var chip = els['storage-status'];
    var m = store.getMode();
    chip.setAttribute('data-mode', storageBlocked ? 'memory' : m.mode);
    chip.setAttribute('data-reason', storageBlocked ? 'storage-unreadable' : (m.reason || ''));
    chip.setAttribute('data-saved', lastSave ? String(!!lastSave.saved) : '');
    if (storageBlocked) {
      chip.textContent = 'Storage: unreadable data found — decide below';
    } else if (m.mode === 'storage' && lastSave && lastSave.saved) {
      chip.textContent = 'Saved to browser storage';
    } else if (m.mode === 'storage') {
      chip.textContent = 'Browser storage ready';
    } else {
      chip.textContent = 'In-memory only — ' + (m.reasonText || 'browser storage unavailable');
    }
  }

  function persist() {
    if (storageBlocked) {
      lastSave = { saved: false, mode: 'memory', reason: 'storage-unreadable' };
      renderStorageStatus();
      return lastSave;
    }
    lastSave = store.save(state);
    renderStorageStatus();
    return lastSave;
  }

  function afterAction(message) {
    var r = persist();
    if (r.saved) {
      toast(message + ' — saved to browser storage.', 'ok');
      return;
    }
    var reasonText = r.reason === 'storage-unreadable'
      ? 'stored data is unreadable — settle the banner first'
      : (store.getMode().reasonText || 'browser storage unavailable');
    toast(message + ' — held in memory only (' + reasonText + '). Export a JSON backup to keep it.', 'warn');
  }

  // ------------------------------------------------------------------ render

  function renderAll() {
    renderUnitLabels();
    renderCategoryOptions();
    renderTimeline();
    renderStorageStatus();
  }

  function renderUnitLabels() {
    var unit = unitOf();
    els['unit-suffix-odometer'].textContent = unit;
    els['unit-suffix-mileage'].textContent = unit;
    els['unit-suffix-next'].textContent = unit;
  }

  function syncVehicleForm() {
    var v = state.vehicle || { nickname: '', odometer: null, unit: 'km' };
    els['vehicle-nickname'].value = v.nickname || '';
    els['vehicle-odometer'].value = v.odometer === null || v.odometer === undefined ? '' : String(v.odometer);
    els['vehicle-unit'].value = v.unit === 'mi' ? 'mi' : 'km';
  }

  function syncFilterInputs() {
    els['filter-search'].value = filters.query;
    els['filter-status'].value = filters.status;
    els['filter-category'].value = filters.category; // select rebuilt right after; value reapplied in renderCategoryOptions
  }

  function renderCategoryOptions() {
    // A Map keeps user-typed category names such as "__proto__" or
    // "constructor" as ordinary keys; with a plain object "__proto__" was
    // silently dropped from the dropdown and the other names read inherited
    // Object.prototype values.
    var seen = new Map();
    state.entries.forEach(function (e) { if (e.category) { seen.set(e.category, true); } });
    DEFAULT_CATEGORIES.forEach(function (c) { seen.set(c, true); });
    if (filters.category) { seen.set(filters.category, true); } // keep the active filter visible
    var list = Array.from(seen.keys()).sort();

    var dl = els['category-options'];
    dl.textContent = '';
    list.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c;
      dl.appendChild(opt);
    });

    var sel = els['filter-category'];
    sel.textContent = '';
    var all = document.createElement('option');
    all.value = '';
    all.textContent = 'All categories';
    sel.appendChild(all);
    list.forEach(function (c) {
      var opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      sel.appendChild(opt);
    });
    sel.value = filters.category;
  }

  function scheduleBadgeText(entry, sched, unit) {
    if (sched.status === 'unknown') {
      if (sched.date === null && sched.mileage === null) { return 'Next due: not set'; }
      if (sched.date === null && sched.mileage === 'unknown') { return 'Next due: target ' + M.formatInt(entry.nextMileage) + ' ' + unit + ' (odometer unknown)'; }
      return 'Next due: ' + M.describeSchedule(entry, state.vehicle, todayISO());
    }
    if (sched.status === 'overdue') {
      var bits = [];
      if (sched.date === 'overdue') { bits.push('date passed ' + entry.nextDate); }
      if (sched.mileage === 'overdue') { bits.push('odometer past ' + M.formatInt(entry.nextMileage) + ' ' + unit); }
      return 'Overdue: ' + bits.join('; ');
    }
    var dueBits = [];
    if (sched.date === 'due') { dueBits.push('by ' + entry.nextDate); }
    if (sched.mileage === 'due') { dueBits.push('at ' + M.formatInt(entry.nextMileage) + ' ' + unit); }
    return 'Due: ' + dueBits.join('; ');
  }

  function renderTimeline() {
    var list = els['entry-list'];
    var today = todayISO();
    var unit = unitOf();
    var visible = M.filterEntries(M.sortEntries(state.entries), filters, { vehicle: state.vehicle, today: today });

    list.textContent = '';
    if (visible.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'empty-note';
      empty.textContent = state.entries.length > 0
        ? 'No records match the current filters.'
        : 'No service records yet. Add your first service in the form, or load the explicitly fictional sample.';
      list.appendChild(empty);
      updateSummary(0);
      return;
    }

    var template = els['entry-card-template'];
    visible.forEach(function (e) {
      var node = template.content.firstElementChild.cloneNode(true);
      var sched = M.computeSchedule(e, state.vehicle, today);

      node.setAttribute('data-entry-id', e.id);
      node.setAttribute('data-status', sched.status);
      node.querySelector('.entry-date').textContent = formatDisplayDate(e.date);
      node.querySelector('.entry-mileage').textContent = M.formatInt(e.mileage) + ' ' + unit;
      node.querySelector('.entry-category').textContent = e.category;
      node.querySelector('.entry-description').textContent = e.description;

      setLine(node, '.entry-parts', e.parts, 'Parts: ');
      setLine(node, '.entry-cost', typeof e.cost === 'number' ? 'Cost: ' + e.cost.toFixed(2) : '', '');
      setLine(node, '.entry-receipt', e.receipt, 'Receipt ref: ');
      setLine(node, '.entry-notes', e.notes, 'Notes: ');

      var badge = node.querySelector('.entry-schedule');
      badge.textContent = scheduleBadgeText(e, sched, unit);
      badge.setAttribute('data-status', sched.status);

      var editBtn = node.querySelector('.entry-edit');
      editBtn.setAttribute('aria-label', 'Edit record: ' + e.description);
      editBtn.addEventListener('click', function () { startEdit(e.id); });

      var delBtn = node.querySelector('.entry-delete');
      delBtn.setAttribute('aria-label', 'Delete record: ' + e.description);
      delBtn.addEventListener('click', function () { openDeleteConfirm(e.id); });

      list.appendChild(node);
    });
    updateSummary(visible.length);
  }

  function setLine(node, selector, value, prefix) {
    var el = node.querySelector(selector);
    if (value) {
      el.textContent = prefix + value;
      el.hidden = false;
    } else {
      el.textContent = '';
      el.hidden = true;
    }
  }

  function updateSummary(shown) {
    var s = M.summarize(state.entries, state.vehicle, todayISO());
    var unit = unitOf();
    var chips = [];
    chips.push(s.count + (s.count === 1 ? ' record' : ' records'));
    if (s.totalCost !== null) { chips.push('total cost ' + s.totalCost.toFixed(2)); }
    if (s.latest) { chips.push('latest ' + formatDisplayDate(s.latest.date) + ' @ ' + M.formatInt(s.latest.mileage) + ' ' + unit); }
    if (s.statuses.overdue) { chips.push(s.statuses.overdue + ' overdue'); }
    if (s.statuses.due) { chips.push(s.statuses.due + ' due'); }
    var text = chips.join(' · ');
    if (filters.query || filters.category || filters.status) {
      text = 'showing ' + shown + ' of ' + s.count + ' · ' + text;
    }
    els['list-summary'].textContent = text;
  }

  // -------------------------------------------------------------- entry form

  function setFormMode() {
    els['form-title'].textContent = editingId ? 'Edit service record' : 'Add a service record';
    els['entry-submit'].textContent = editingId ? 'Save changes' : 'Add service record';
    els['entry-cancel'].hidden = !editingId;
  }

  function resetEntryForm() {
    editingId = null;
    els['entry-id'].value = '';
    els['entry-form'].reset();
    els['entry-date'].value = todayISO();
    renderEntryErrors([]);
    setFormMode();
  }

  function readEntryForm() {
    return {
      date: els['entry-date'].value,
      mileage: intOrRaw(els['entry-mileage'].value),
      category: els['entry-category'].value,
      description: els['entry-description'].value,
      parts: els['entry-parts'].value,
      cost: costOrRaw(els['entry-cost'].value),
      receipt: els['entry-receipt'].value,
      notes: els['entry-notes'].value,
      nextDate: els['entry-next-date'].value,
      nextMileage: intOrRaw(els['entry-next-mileage'].value)
    };
  }

  function renderEntryErrors(errors) {
    renderErrors(els['entry-errors'], errors);
  }

  function renderImportErrors(errors) {
    renderErrors(els['import-errors'], errors);
  }

  function renderErrors(container, errors) {
    container.textContent = '';
    if (!errors || errors.length === 0) { container.hidden = true; return; }
    errors.slice(0, 12).forEach(function (err) {
      var li = document.createElement('li');
      li.textContent = err.path + ' — ' + err.message;
      container.appendChild(li);
    });
    if (errors.length > 12) {
      var more = document.createElement('li');
      more.textContent = '…and ' + (errors.length - 12) + ' more problem(s).';
      container.appendChild(more);
    }
    container.hidden = false;
  }

  function startEdit(id) {
    var e = findEntry(id);
    if (!e) { return; }
    editingId = id;
    els['entry-id'].value = id;
    els['entry-date'].value = e.date;
    els['entry-mileage'].value = String(e.mileage);
    els['entry-category'].value = e.category;
    els['entry-description'].value = e.description;
    els['entry-parts'].value = e.parts;
    els['entry-cost'].value = e.cost === null ? '' : String(e.cost);
    els['entry-receipt'].value = e.receipt;
    els['entry-notes'].value = e.notes;
    els['entry-next-date'].value = e.nextDate || '';
    els['entry-next-mileage'].value = e.nextMileage === null ? '' : String(e.nextMileage);
    renderEntryErrors([]);
    setFormMode();
    els['entry-form'].scrollIntoView({ behavior: 'smooth', block: 'start' });
    els['entry-date'].focus();
  }

  // ------------------------------------------------------- confirmation dialog

  function openConfirm(spec) {
    confirmCallback = spec.onAccept || null;
    els['confirm-title'].textContent = spec.title || 'Confirm';
    els['confirm-message'].textContent = spec.message || '';
    els['confirm-accept'].textContent = spec.acceptLabel || 'Confirm';
    els['confirm-accept'].classList.remove('primary', 'danger');
    els['confirm-accept'].classList.add(spec.danger ? 'danger' : 'primary');
    var dlg = els['confirm-dialog'];
    if (typeof dlg.showModal === 'function') { dlg.showModal(); } else { dlg.setAttribute('open', ''); }
    els['confirm-accept'].focus();
  }

  function closeDialog() {
    var dlg = els['confirm-dialog'];
    if (typeof dlg.close === 'function' && dlg.open) { dlg.close(); } else { dlg.removeAttribute('open'); }
  }

  // ------------------------------------------------------------ delete flow

  function openDeleteConfirm(id) {
    var e = findEntry(id);
    if (!e) { return; }
    openConfirm({
      title: 'Delete this service record?',
      message: '\u201C' + e.description + '\u201D\n' + formatDisplayDate(e.date) + ' · ' + M.formatInt(e.mileage) + ' ' + unitOf() + '\n\nThis cannot be undone.',
      acceptLabel: 'Delete record',
      danger: true,
      onAccept: function () { doDelete(id); }
    });
  }

  function doDelete(id) {
    var r = M.removeEntry(state, id);
    if (!r.ok) {
      toast('Could not delete: ' + (r.errors[0] ? r.errors[0].message : 'unknown error'), 'error');
      return false;
    }
    state = r.value;
    if (editingId === id) { resetEntryForm(); }
    renderAll();
    afterAction('Service record deleted');
    return true;
  }

  // ------------------------------------------------------------ sample flow

  function applySample() {
    state = M.sampleState();
    resetEntryForm();
    filters = { query: '', category: '', status: '' };
    syncFilterInputs();
    renderAll();
    afterAction('Fictional sample loaded (' + state.entries.length + ' records)');
  }

  function loadSample(force) {
    if (state.entries.length > 0 && force !== true) {
      openConfirm({
        title: 'Replace current data with the sample?',
        message: 'This replaces your vehicle profile and ' + state.entries.length + ' existing record(s) with explicitly fictional sample data.\n\nExport a JSON backup first if you need your current data.',
        acceptLabel: 'Replace with sample',
        danger: true,
        onAccept: applySample
      });
      return false;
    }
    applySample();
    return true;
  }

  // ------------------------------------------------------------ import flow

  function applyImported(imported) {
    state = imported;
    resetEntryForm();
    els['import-text'].value = '';
    filters = { query: '', category: '', status: '' };
    syncFilterInputs();
    renderAll();
    afterAction('Imported ' + imported.entries.length + ' record(s)');
  }

  function requestImport() {
    var text = els['import-text'].value;
    var parsed = M.parseState(text);
    if (!parsed.ok) {
      renderImportErrors(parsed.errors);
      toast('Import rejected — your current records are untouched.', 'error');
      return false;
    }
    renderImportErrors([]);
    var imported = parsed.value;
    var nickname = imported.vehicle && imported.vehicle.nickname ? imported.vehicle.nickname : '(unnamed)';
    openConfirm({
      title: 'Replace current data with this import?',
      message: 'The document contains ' + imported.entries.length + ' record(s) and vehicle profile \u201C' + nickname + '\u201D.\n\nThis replaces your current ' + state.entries.length + ' record(s). Export a backup first if unsure.',
      acceptLabel: 'Replace with import',
      danger: true,
      onAccept: function () { applyImported(imported); }
    });
    return true;
  }

  // ------------------------------------------------------------ export flow

  function doExport() {
    var text = M.serializeState(state);
    downloadText(M.exportFilename(todayISO()), text, 'application/json');
    var durable = store.getMode().mode === 'storage' && (!lastSave || lastSave.saved);
    toast(
      'Backup downloaded: ' + state.entries.length + ' record(s).' + (durable ? '' : ' Note: this session is in-memory only — keep that file.'),
      durable ? 'ok' : 'warn'
    );
  }

  // ------------------------------------------------------------- print flow

  function schedulePrintText(entry) {
    var s = M.computeSchedule(entry, state.vehicle, todayISO());
    if (s.status === 'unknown') { return 'not set / unknown'; }
    return (s.status === 'overdue' ? 'OVERDUE — ' : '') + M.describeSchedule(entry, state.vehicle, todayISO());
  }

  function buildPrintReport() {
    var root = els['print-root'];
    var unit = unitOf();
    var v = state.vehicle || { nickname: '', odometer: null, unit: unit };
    root.textContent = '';

    var h1 = document.createElement('h1');
    h1.textContent = 'Vehicle Maintenance Timeline — Report';
    root.appendChild(h1);

    var meta = document.createElement('p');
    meta.className = 'print-meta';
    meta.textContent = 'Generated ' + todayISO() + ' · Vehicle: ' + (v.nickname || '(unnamed)') +
      ' · Odometer: ' + (v.odometer === null || v.odometer === undefined ? 'unknown' : M.formatInt(v.odometer) + ' ' + unit) +
      ' · Records: ' + state.entries.length;
    root.appendChild(meta);

    var table = document.createElement('table');
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    ['Date', 'Odometer', 'Category', 'Description', 'Parts', 'Cost', 'Receipt', 'Next due'].forEach(function (label) {
      var th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    M.sortEntries(state.entries).forEach(function (e) {
      var tr = document.createElement('tr');
      var cells = [
        e.date,
        M.formatInt(e.mileage) + ' ' + unit,
        e.category,
        e.description,
        e.parts || '—',
        typeof e.cost === 'number' ? e.cost.toFixed(2) : '—',
        e.receipt || '—',
        schedulePrintText(e)
      ];
      cells.forEach(function (text) {
        var td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    root.appendChild(table);

    var note = document.createElement('p');
    note.className = 'print-note';
    note.textContent = 'Generated locally from data typed by the user. No network requests were made. This logbook records what the user entered and is not a service recommendation.';
    root.appendChild(note);
  }

  // The report is rebuilt for every print entry point: the Print button below
  // and the browser's own print flow (Ctrl+P / menu Print), which fires
  // `beforeprint`. Without that listener a freshly loaded page printed the
  // empty #print-root shell — a blank page. Rebuilding on beforeprint also
  // keeps a long-lived tab from printing stale records.
  function refreshPrintReport() {
    buildPrintReport();
    els['print-root'].hidden = false;
  }

  function doPrint() {
    refreshPrintReport();
    window.print();
  }

  window.addEventListener('beforeprint', refreshPrintReport);
  window.addEventListener('afterprint', function () {
    els['print-root'].hidden = true;
  });

  // ------------------------------------------------------------- wiring

  els['vehicle-form'].addEventListener('submit', function (ev) {
    ev.preventDefault();
    var probe = M.setVehicle(state, readVehicleForm(), {});
    if (probe.ok) { applyVehicle(false); return; }
    var first = probe.errors[0] || { message: 'Invalid vehicle data.' };
    if (/confirmUnitChange/.test(first.message) && state.entries.length > 0) {
      openConfirm({
        title: 'Change the distance unit?',
        message: 'Your ' + state.entries.length + ' existing record(s) keep their numbers and will now be labelled in \u201C' + els['vehicle-unit'].value + '\u201D. Nothing is converted.',
        acceptLabel: 'Change unit',
        danger: false,
        onAccept: function () { applyVehicle(true); }
      });
    } else {
      toast(first.message, 'error');
    }
  });

  function readVehicleForm() {
    return {
      nickname: els['vehicle-nickname'].value,
      odometer: intOrRaw(els['vehicle-odometer'].value),
      unit: els['vehicle-unit'].value
    };
  }

  function applyVehicle(confirmUnit) {
    var r = M.setVehicle(state, readVehicleForm(), confirmUnit ? { confirmUnitChange: true } : {});
    if (!r.ok) { toast(r.errors[0] ? r.errors[0].message : 'Invalid vehicle data.', 'error'); return; }
    state = r.value;
    renderAll();
    afterAction('Vehicle profile updated');
  }

  els['entry-form'].addEventListener('submit', function (ev) {
    ev.preventDefault();
    var data = readEntryForm();
    var wasEditing = !!editingId;
    var result = wasEditing ? M.updateEntry(state, editingId, data) : M.addEntry(state, data);
    if (!result.ok) {
      renderEntryErrors(result.errors);
      toast('Please fix the ' + result.errors.length + ' listed problem(s).', 'error');
      return;
    }
    state = result.value;
    resetEntryForm();
    renderAll();
    afterAction(wasEditing ? 'Service record updated' : 'Service record added');
  });

  els['entry-cancel'].addEventListener('click', function () { resetEntryForm(); });

  els['filter-search'].addEventListener('input', function () {
    filters.query = els['filter-search'].value;
    renderTimeline();
  });
  els['filter-category'].addEventListener('change', function () {
    filters.category = els['filter-category'].value;
    renderTimeline();
  });
  els['filter-status'].addEventListener('change', function () {
    filters.status = els['filter-status'].value;
    renderTimeline();
  });
  els['filter-reset'].addEventListener('click', function () {
    filters = { query: '', category: '', status: '' };
    syncFilterInputs();
    renderCategoryOptions();
    renderTimeline();
  });

  els['btn-export-json'].addEventListener('click', doExport);
  els['btn-print'].addEventListener('click', doPrint);
  els['btn-load-sample'].addEventListener('click', function () { loadSample(false); });
  els['btn-import'].addEventListener('click', requestImport);

  els['import-file'].addEventListener('change', function () {
    var file = els['import-file'].files && els['import-file'].files[0];
    if (!file) { return; }
    var reader = new FileReader();
    reader.onload = function () {
      els['import-text'].value = String(reader.result || '');
      toast('File loaded into the box — review it, then press \u201CValidate & import…\u201D.', 'ok');
    };
    reader.onerror = function () { toast('Could not read that file.', 'error'); };
    reader.readAsText(file);
  });

  els['confirm-accept'].addEventListener('click', function () {
    var cb = confirmCallback;
    confirmCallback = null;
    closeDialog();
    if (cb) { cb(); }
  });
  els['confirm-cancel'].addEventListener('click', function () {
    confirmCallback = null;
    closeDialog();
  });
  els['confirm-dialog'].addEventListener('close', function () { confirmCallback = null; });
  els['confirm-dialog'].addEventListener('cancel', function () { confirmCallback = null; });

  els['btn-download-raw'].addEventListener('click', function () {
    if (unreadableRaw === null) { return; }
    downloadText('maintenance-timeline-unreadable-' + todayISO() + '.txt', unreadableRaw, 'text/plain');
    toast('Raw stored data downloaded as plain text.', 'ok');
  });

  els['btn-start-fresh'].addEventListener('click', function () {
    openConfirm({
      title: 'Discard the unreadable stored data?',
      message: 'The stored document will be replaced by an empty state. If you have not downloaded the raw data yet, this is your last chance.',
      acceptLabel: 'Start fresh',
      danger: true,
      onAccept: function () {
        storageBlocked = false;
        unreadableRaw = null;
        state = M.createState();
        resetEntryForm();
        renderAll();
        els['storage-banner'].hidden = true;
        afterAction('Started fresh');
      }
    });
  });

  window.addEventListener('keydown', function (ev) {
    if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey) { return; }
    var t = ev.target;
    var typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (ev.key === '/' && !typing) {
      ev.preventDefault();
      els['filter-search'].focus();
    }
  });

  // ---------------------------------------------------------------- boot

  function boot() {
    var loaded = store.load();
    if (loaded.ok && loaded.value) {
      state = loaded.value;
    } else if (!loaded.ok) {
      storageBlocked = true;
      unreadableRaw = loaded.raw || '';
      els['storage-banner'].hidden = false;
      els['storage-banner-text'].textContent =
        'The stored document failed validation: ' +
        (loaded.errors && loaded.errors[0] ? loaded.errors[0].message : 'unknown error') +
        ' It has been left exactly as it is in browser storage until you decide.';
    }

    store.onChange(function () { renderStorageStatus(); });

    els['entry-date'].value = todayISO();
    syncVehicleForm();
    syncFilterInputs();
    renderAll();
    setFormMode();

    window.MaintenanceApp = buildTestHook();
  }

  // ------------------------------------------------------- automation hook

  function buildTestHook() {
    return {
      version: 1,
      selectors: {
        storageStatus: '#storage-status',
        storageBanner: '#storage-banner',
        vehicleForm: '#vehicle-form',
        vehicleNickname: '#vehicle-nickname',
        vehicleOdometer: '#vehicle-odometer',
        vehicleUnit: '#vehicle-unit',
        entryForm: '#entry-form',
        entryDate: '#entry-date',
        entryMileage: '#entry-mileage',
        entryCategory: '#entry-category',
        entryDescription: '#entry-description',
        entrySubmit: '#entry-submit',
        entryCancel: '#entry-cancel',
        entryErrors: '#entry-errors',
        filterSearch: '#filter-search',
        filterCategory: '#filter-category',
        filterStatus: '#filter-status',
        entryList: '#entry-list',
        entryCard: '.entry-card',
        entryEdit: '.entry-edit',
        entryDelete: '.entry-delete',
        entryScheduleBadge: '.entry-schedule',
        exportButton: '#btn-export-json',
        printButton: '#btn-print',
        importText: '#import-text',
        importFile: '#import-file',
        importErrors: '#import-errors',
        importButton: '#btn-import',
        sampleButton: '#btn-load-sample',
        dialog: '#confirm-dialog',
        dialogAccept: '#confirm-accept',
        dialogCancel: '#confirm-cancel',
        toast: '#toast',
        printRoot: '#print-root'
      },
      getState: function () { return JSON.parse(JSON.stringify(state)); },
      entries: function () {
        var today = todayISO();
        return M.sortEntries(state.entries).map(function (e) {
          return {
            id: e.id, date: e.date, mileage: e.mileage, category: e.category,
            description: e.description, cost: e.cost,
            status: M.computeSchedule(e, state.vehicle, today).status
          };
        });
      },
      getStorage: function () {
        var m = store.getMode();
        return {
          mode: m.mode, reason: m.reason, reasonText: m.reasonText,
          blocked: storageBlocked,
          lastSave: lastSave ? { saved: !!lastSave.saved, mode: lastSave.mode, reason: lastSave.reason } : null
        };
      },
      addEntry: function (fields) {
        var r = M.addEntry(state, fields || {});
        if (!r.ok) { return { ok: false, errors: r.errors }; }
        state = r.value;
        renderAll();
        afterAction('Service record added');
        return { ok: true, id: state.entries[state.entries.length - 1].id, entries: state.entries.length };
      },
      updateEntry: function (id, patch) {
        var r = M.updateEntry(state, id, patch || {});
        if (!r.ok) { return { ok: false, errors: r.errors }; }
        state = r.value;
        renderAll();
        afterAction('Service record updated');
        return { ok: true, entries: state.entries.length };
      },
      deleteEntry: function (id) {
        var okDeleted = doDelete(id);
        return { ok: okDeleted, entries: state.entries.length };
      },
      openDeleteConfirm: openDeleteConfirm,
      setFilter: function (f) {
        f = f || {};
        filters.query = f.query === undefined ? '' : String(f.query);
        filters.category = f.category ? String(f.category) : '';
        filters.status = f.status ? String(f.status) : '';
        syncFilterInputs();
        renderCategoryOptions();
        renderTimeline();
        return JSON.parse(JSON.stringify(filters));
      },
      loadSample: loadSample,
      exportJSON: function () { return M.serializeState(state); },
      exportDownload: doExport,
      print: doPrint,
      parseImport: function (text) {
        var r = M.parseState(text);
        return r.ok ? { ok: true, entries: r.value.entries.length } : { ok: false, errors: r.errors };
      },
      requestImport: requestImport,
      applyImportText: function (text) {
        var r = M.parseState(text);
        if (!r.ok) { return { ok: false, errors: r.errors }; }
        applyImported(r.value);
        return { ok: true, entries: state.entries.length };
      },
      persist: persist,
      render: function () { renderAll(); return true; },
      reset: function () {
        state = M.createState();
        resetEntryForm();
        filters = { query: '', category: '', status: '' };
        syncFilterInputs();
        renderAll();
        return true;
      }
    };
  }

  boot();
})();
