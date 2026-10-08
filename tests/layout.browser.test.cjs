'use strict';
/**
 * Vehicle Maintenance Timeline — real-browser layout regression test.
 *
 * Guards the desktop column geometry that previously regressed: panels inside
 * `.col-left` must fit their 430px column (grid min-width:auto + 1fr intrinsic
 * minimum used to inflate them to 482.234px, overlapping the timeline panel by
 * 34.234px at 1440/1024), children must not spill their panel's content box,
 * mobile (390/320) must not overflow the body even with the shipped sample
 * loaded or a legal 40-char category imported (long schedule AND category
 * badges must wrap, and the stacked filters must not stretch to the widest
 * <option>), labels must stay visible, every .panel keeps its children inside
 * its content box on narrow viewports too (the entry-form <fieldset> used to
 * floor at min-content — UA min-width + date-input intrinsic width — and CI's
 * Linux font metrics pushed it past a 320px viewport), a 300px viewport acts
 * as the font-width proxy for that class, and print media must still hide the
 * app layout in favour of #print-root.
 *
 * Run with:  node tests/layout.browser.test.cjs
 *
 * Playwright resolution (first hit wins): $PLAYWRIGHT_MODULE → local
 * node_modules → the parent QA dev install (../../qa/node_modules) → bare
 * 'playwright'. Launch channel: $PLAYWRIGHT_CHANNEL (default 'chrome', same
 * as the QA runner) with a fallback to bundled Chromium.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test, before, after } = require('node:test');

const APP_URL = pathToFileURL(path.join(__dirname, '..', 'index.html')).href;

// ------------------------------------------------------------------ helpers

function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    path.join(__dirname, '..', 'node_modules', 'playwright'),
    path.resolve(__dirname, '..', '..', 'qa', 'node_modules', 'playwright'),
  ].filter(Boolean);
  const tried = [];
  for (const c of candidates) {
    if (!fs.existsSync(c)) { tried.push(c + ' (missing)'); continue; }
    try { return require(c); } catch (e) { tried.push(c + ' (' + e.code + ')'); }
  }
  try { return require('playwright'); } catch (e) { tried.push('playwright (' + e.code + ')'); }
  throw new Error('playwright module not found; tried: ' + tried.join(', '));
}

const round = (n) => +n.toFixed(3);

async function openApp(page) {
  await page.goto(APP_URL, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.MaintenanceApp, null, { timeout: 5000 });
  await settle(page);
}

// Two rAFs: let layout settle after viewport/style changes before measuring.
async function settle(page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function measureDesktop(page) {
  return page.evaluate(() => {
    const rect = (el) => { const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, width: b.width }; };
    const col = rect(document.querySelector('.col-left'));
    const timeline = rect(document.querySelector('#timeline-panel'));
    const panels = [...document.querySelectorAll('.col-left .panel')].map((p) => ({ id: p.id, ...rect(p) }));
    const spills = [];
    for (const p of document.querySelectorAll('.col-left .panel')) {
      const b = p.getBoundingClientRect();
      const cs = getComputedStyle(p);
      const innerLeft = b.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      const innerRight = b.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
      for (const el of p.querySelectorAll('*')) {
        const eb = el.getBoundingClientRect();
        if (eb.width < 0.5 && eb.height < 0.5) continue; // hidden nodes
        if (eb.right > innerRight + 1 || eb.left < innerLeft - 1) {
          spills.push({
            panel: p.id,
            el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
              (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : ''),
            left: eb.left, right: eb.right,
          });
        }
      }
    }
    return { col, timeline, panels, spills };
  });
}

async function measureMobile(page) {
  return page.evaluate(() => {
    const clientWidth = document.documentElement.clientWidth;
    const bodyOverflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth;
    const beyondRight = [];
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('.skip-link') || (el.classList && el.classList.contains('skip-link'))) continue; // intentionally off-canvas
      const b = el.getBoundingClientRect();
      if (b.width < 0.5 && b.height < 0.5) continue;
      if (b.right > clientWidth + 1) beyondRight.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''));
    }
    const hiddenLabels = [];
    for (const label of document.querySelectorAll('main label')) {
      const b = label.getBoundingClientRect();
      const cs = getComputedStyle(label);
      if (b.width < 1 || b.height < 1 || cs.display === 'none' || cs.visibility !== 'visible') {
        hiddenLabels.push(label.textContent.trim().slice(0, 40) || '(empty label)');
      }
    }
    return { clientWidth, bodyOverflow, beyondRight, hiddenLabels };
  });
}

// --------------------------------------------------------------------- suite

let browser;

before(async () => {
  const { chromium } = loadPlaywright();
  const channel = process.env.PLAYWRIGHT_CHANNEL || 'chrome';
  try {
    browser = await chromium.launch({ channel, headless: true });
  } catch (error) {
    console.log('[layout] channel "' + channel + '" unavailable (' + String(error.message).split('\n')[0] + '); using bundled chromium');
    browser = await chromium.launch({ headless: true });
  }
});

after(async () => { if (browser) await browser.close(); });

test('desktop 1440/1024: col-left panels fit their column and never intersect the timeline', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await openApp(page);
    for (const width of [1440, 1024]) {
      await page.setViewportSize({ width, height: 1000 });
      await settle(page);
      const m = await measureDesktop(page);
      console.log('[layout] ' + width + 'px col-left=' + JSON.stringify([round(m.col.left), round(m.col.right)]) +
        ' panels=' + JSON.stringify(m.panels.map((p) => [p.id, round(p.left), round(p.right)])) +
        ' timeline-left=' + round(m.timeline.left) + ' gap=' + round(m.timeline.left - Math.max(...m.panels.map((p) => p.right))) + 'px');
      for (const panel of m.panels) {
        assert.ok(
          panel.right <= m.timeline.left + 0.5,
          'Desktop form overlaps timeline by ' + round(panel.right - m.timeline.left) + ' px at ' + width + 'px viewport (' + panel.id + ')'
        );
        assert.ok(
          panel.right <= m.col.right + 0.5 && panel.left >= m.col.left - 0.5,
          'Panel ' + panel.id + ' escapes .col-left at ' + width + 'px: panel=[' + round(panel.left) + ',' + round(panel.right) +
          '] col=[' + round(m.col.left) + ',' + round(m.col.right) + ']'
        );
      }
      assert.equal(m.spills.length, 0, 'Children spill their panel content box at ' + width + 'px: ' + JSON.stringify(m.spills.slice(0, 8)));
    }
  } finally { await context.close(); }
});

test('mobile 390/320: no body overflow, no right-edge escape, labels visible', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await openApp(page);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await settle(page);
      const m = await measureMobile(page);
      console.log('[layout] ' + width + 'px bodyOverflow=' + round(m.bodyOverflow) + 'px beyondRight=' + m.beyondRight.length + ' hiddenLabels=' + m.hiddenLabels.length);
      // Stacked filters: .field.grow's flex-basis must not leak onto the column
      // axis (it used to make the search field a 220px-tall box at <=560px).
      const searchFieldHeight = await page.evaluate(() => document.querySelector('#filter-search').closest('.field').getBoundingClientRect().height);
      console.log('[layout] ' + width + 'px searchFieldHeight=' + round(searchFieldHeight) + 'px');
      assert.ok(searchFieldHeight < 120, 'Stacked search field inflated at ' + width + 'px: field height ' + round(searchFieldHeight) + 'px (flex-basis 220px leaking onto the column axis)');
      assert.ok(m.bodyOverflow <= 1, 'Mobile body overflow at ' + width + ' px: ' + round(m.bodyOverflow) + ' px');
      assert.equal(m.beyondRight.length, 0, 'Elements escape the right edge at ' + width + 'px: ' + JSON.stringify(m.beyondRight.slice(0, 8)));
      assert.equal(m.hiddenLabels.length, 0, 'Labels not visible at ' + width + 'px: ' + JSON.stringify(m.hiddenLabels));
    }
  } finally { await context.close(); }
});

test('mobile with shipped sample loaded: long schedule badges wrap, no overflow at 390/320', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await openApp(page);
    assert.equal(await page.evaluate(() => window.MaintenanceApp.loadSample(true)), true, 'sample must load without a confirm dialog');
    await page.waitForFunction(() => document.querySelectorAll('.entry-card').length >= 4, null, { timeout: 5000 });

    // Long-badge case built through the real form: date AND odometer overdue.
    await page.locator('#entry-date').fill('2026-10-08');
    await page.locator('#entry-mileage').fill('70000');
    await page.locator('#entry-description').fill('Long badge regression case (fictional)');
    await page.locator('#entry-next-date').fill('2026-01-05');
    await page.locator('#entry-next-mileage').fill('12345');
    await page.locator('#entry-submit').click();
    await page.waitForFunction(() => document.querySelectorAll('.entry-card').length >= 5, null, { timeout: 5000 });

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await settle(page);
      const m = await measureMobile(page);
      const badges = await page.evaluate(() => [...document.querySelectorAll('.entry-schedule')].map((b) => ({
        text: b.textContent,
        right: b.getBoundingClientRect().right,
        scrollWidth: b.scrollWidth,
        clientWidth: b.clientWidth,
      })));
      console.log('[layout] sample ' + width + 'px bodyOverflow=' + round(m.bodyOverflow) + 'px beyondRight=' + m.beyondRight.length +
        ' badges=' + badges.length + ' widestBadgeRight=' + round(Math.max(...badges.map((b) => b.right))) + 'px');
      assert.ok(m.bodyOverflow <= 1, 'Sample-loaded body overflow at ' + width + ' px: ' + round(m.bodyOverflow) + ' px');
      assert.equal(m.beyondRight.length, 0, 'Elements escape the right edge at ' + width + 'px (sample): ' + JSON.stringify(m.beyondRight.slice(0, 8)));
      assert.equal(m.hiddenLabels.length, 0, 'Labels not visible at ' + width + 'px (sample): ' + JSON.stringify(m.hiddenLabels));
      assert.ok(badges.length >= 5, 'Expected at least 5 schedule badges, got ' + badges.length);
      assert.ok(
        badges.some((b) => b.text.includes('Overdue: date passed 2026-01-05; odometer past 12,345 km')),
        'long badge text not rendered: ' + JSON.stringify(badges.map((b) => b.text))
      );
      const clipped = badges.filter((b) => b.scrollWidth > b.clientWidth + 1);
      assert.equal(clipped.length, 0, 'Schedule badge clipped at ' + width + 'px: ' + JSON.stringify(clipped));
      for (const b of badges) {
        assert.ok(b.right <= m.clientWidth + 1, 'Schedule badge escapes viewport at ' + width + 'px: ' + JSON.stringify(b));
      }
    }

    // Data-loaded desktop sanity: the column geometry guard still holds.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await settle(page);
    const d = await measureDesktop(page);
    for (const panel of d.panels) {
      assert.ok(panel.right <= d.timeline.left + 0.5, 'Desktop form overlaps timeline by ' + round(panel.right - d.timeline.left) + ' px with sample data (' + panel.id + ')');
    }
    assert.equal(d.spills.length, 0, 'Children spill panel content box with sample data: ' + JSON.stringify(d.spills.slice(0, 8)));
  } finally { await context.close(); }
});

test('mobile long legal category (40 chars): no overflow at 390/320, badges wrap only when needed', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await openApp(page);

    // Exactly the document the closure review / parent acceptance gate uses: a
    // category at the legal maximum (core.js LIMITS.category = 40, #entry-category
    // maxlength = 40). The 40-char <option> used to inflate the stacked filter
    // column's flex lines to 332px (fields' right edge 367 at a 320px viewport =
    // 47px body overflow) and the nowrap category badge used to stick 6.41px
    // past the viewport — this test guards both.
    const LONG_CATEGORY = 'Timing Belt & Water Pump Replacement Kit';
    const longDoc = {
      format: 'vehicle-maintenance-timeline',
      version: 1,
      updatedAt: '2026-10-08T00:00:00.000Z',
      vehicle: { nickname: 'Fictional Blue Wagon', odometer: 70000, unit: 'km' },
      entries: [{
        id: 'e-long-1',
        createdAt: '2026-10-08T00:00:00.000Z',
        date: '2026-06-01',
        mileage: 68000,
        category: LONG_CATEGORY,
        description: 'Fictional long-category record',
        parts: '',
        cost: null,
        receipt: '',
        notes: '',
        nextDate: null,
        nextMileage: null,
      }],
    };
    await page.locator('#import-text').fill(JSON.stringify(longDoc));
    await page.locator('#btn-import').click();
    await page.locator('#confirm-accept').click();
    await page.waitForFunction(() => document.querySelectorAll('.entry-card').length === 1);
    // The 40-char option must really be present in the category filter, otherwise
    // this regression is not exercising the condition it guards.
    await page.waitForFunction(
      (cat) => [...document.querySelectorAll('#filter-category option')].some((o) => o.textContent === cat),
      LONG_CATEGORY
    );

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await settle(page);
      const m = await measureMobile(page);
      const badge = await page.evaluate(() => {
        const el = document.querySelector('.entry-category');
        const b = el.getBoundingClientRect();
        const card = el.closest('.entry-card');
        const c = card.getBoundingClientRect();
        const cs = getComputedStyle(card);
        const innerRight = c.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
        return {
          text: el.textContent,
          right: b.right,
          height: b.height,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          cardInnerRight: innerRight,
          viewport: document.documentElement.clientWidth,
        };
      });
      console.log('[layout] long-category ' + width + 'px bodyOverflow=' + round(m.bodyOverflow) + 'px beyondRight=' + m.beyondRight.length +
        ' badgeRight=' + round(badge.right) + ' cardInnerRight=' + round(badge.cardInnerRight) + ' badgeHeight=' + round(badge.height));
      assert.ok(m.bodyOverflow <= 1, 'Long-category body overflow at ' + width + ' px: ' + round(m.bodyOverflow) + ' px');
      assert.equal(m.beyondRight.length, 0, 'Elements escape the right edge at ' + width + 'px (long category): ' + JSON.stringify(m.beyondRight.slice(0, 8)));
      assert.equal(m.hiddenLabels.length, 0, 'Labels not visible at ' + width + 'px (long category): ' + JSON.stringify(m.hiddenLabels));
      assert.equal(badge.text, LONG_CATEGORY, 'Long-category record not rendered at ' + width + 'px');
      assert.ok(badge.scrollWidth <= badge.clientWidth + 1, 'Category badge text clipped at ' + width + 'px: ' + JSON.stringify(badge));
      assert.ok(badge.right <= badge.cardInnerRight + 1, 'Category badge escapes its card content box at ' + width + 'px: ' + JSON.stringify(badge));
      assert.ok(badge.right <= badge.viewport + 1, 'Category badge escapes the viewport at ' + width + 'px: ' + JSON.stringify(badge));
    }

    // Short category badges must keep their single-line look (wrap only when needed).
    assert.equal(await page.evaluate(() => window.MaintenanceApp.loadSample(true)), true, 'sample must load (force)');
    await page.waitForFunction(() => document.querySelectorAll('.entry-card').length >= 4, null, { timeout: 5000 });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await settle(page);
      const shortBadge = await page.evaluate(() => {
        const el = [...document.querySelectorAll('.entry-category')].find((b) => b.textContent === 'Oil & Filter');
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { right: b.right, height: b.height, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, viewport: document.documentElement.clientWidth };
      });
      assert.ok(shortBadge, 'Short-category badge ("Oil & Filter") not found at ' + width + 'px');
      assert.ok(shortBadge.scrollWidth <= shortBadge.clientWidth + 1, 'Short category badge clipped at ' + width + 'px: ' + JSON.stringify(shortBadge));
      assert.ok(shortBadge.height < 32, 'Short category badge wrapped at ' + width + 'px (single-line look expected): ' + JSON.stringify(shortBadge));
      assert.ok(shortBadge.right <= shortBadge.viewport + 1, 'Short category badge escapes the viewport at ' + width + 'px: ' + JSON.stringify(shortBadge));
    }
  } finally { await context.close(); }
});

test('rejected import at 320/300: panels hold their content, no overflow (font-width proxy)', async () => {
  // Fresh CI (Linux Chromium) caught 13px of body overflow at 320px in this
  // state: the entry-form <fieldset> floors at min-content (UA min-width:
  // min-content + the date inputs' intrinsic width) and already sat 4px past
  // its own panel's content box on Windows. Same class as the earlier
  // 1fr-floors-at-min-content column bug: fix the floor, then freeze it.
  // 300px is not a supported width — it is the deterministic proxy for Linux's
  // wider glyphs at 320px, so this regression is catchable on any platform.
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await openApp(page);
    const dupDoc = {
      format: 'vehicle-maintenance-timeline',
      version: 1,
      updatedAt: '2026-10-08T00:00:00.000Z',
      vehicle: { nickname: 'Fictional Blue Wagon', odometer: 70000, unit: 'km' },
      entries: [
        { id: 'e-font-1', createdAt: '2026-10-08T00:00:00.000Z', date: '2026-10-01', mileage: 60000, category: 'Oil', description: 'Fictional record', parts: '', cost: null, receipt: '', notes: '', nextDate: null, nextMileage: null },
        { id: 'e-font-1', createdAt: '2026-10-08T00:00:00.000Z', date: '2026-10-02', mileage: 60100, category: 'Oil', description: 'Duplicate id record', parts: '', cost: null, receipt: '', notes: '', nextDate: null, nextMileage: null },
      ],
    };
    await page.locator('#import-text').fill(JSON.stringify(dupDoc));
    await page.locator('#btn-import').click();
    await page.waitForFunction(() => { const e = document.querySelector('#import-errors'); return e && !e.hidden && e.children.length > 0; });

    for (const width of [320, 300]) {
      await page.setViewportSize({ width, height: 844 });
      await settle(page);
      const m = await page.evaluate(() => {
        const spills = [];
        for (const p of document.querySelectorAll('.panel')) {
          const pb = p.getBoundingClientRect();
          const cs = getComputedStyle(p);
          const innerLeft = pb.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
          const innerRight = pb.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight);
          for (const el of p.querySelectorAll('*')) {
            if (el.closest('.skip-link')) continue;
            const eb = el.getBoundingClientRect();
            if (eb.width < 0.5 && eb.height < 0.5) continue;
            if (eb.right > innerRight + 1 || eb.left < innerLeft - 1) {
              spills.push({
                panel: p.id || '(no id)',
                el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
                  (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : ''),
                left: +eb.left.toFixed(1), right: +eb.right.toFixed(1),
              });
            }
          }
        }
        const clientWidth = document.documentElement.clientWidth;
        const bodyOverflow = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth;
        const beyondRight = [];
        for (const el of document.querySelectorAll('body *')) {
          if (el.closest('.skip-link') || (el.classList && el.classList.contains('skip-link'))) continue;
          const b = el.getBoundingClientRect();
          if (b.width < 0.5 && b.height < 0.5) continue;
          if (b.right > clientWidth + 1) beyondRight.push(el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''));
        }
        return { clientWidth, bodyOverflow, beyondRight, spills };
      });
      console.log('[layout] rejected-import ' + width + 'px bodyOverflow=' + round(m.bodyOverflow) + 'px beyondRight=' + m.beyondRight.length + ' panelSpills=' + m.spills.length);
      assert.ok(m.bodyOverflow <= 1, 'Body overflow at ' + width + ' px: ' + round(m.bodyOverflow) + ' px (font-width proxy: <fieldset> must not floor at min-content)');
      assert.equal(m.beyondRight.length, 0, 'Elements escape the right edge at ' + width + 'px (rejected import): ' + JSON.stringify(m.beyondRight.slice(0, 8)));
      assert.equal(m.spills.length, 0, 'Panel children spill their content box at ' + width + 'px (rejected import): ' + JSON.stringify(m.spills.slice(0, 8)));
    }
  } finally { await context.close(); }
});

test('print media: app layout hidden, #print-root shown (unchanged behaviour)', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await openApp(page);
    await page.emulateMedia({ media: 'print' });
    const printState = await page.evaluate(() => ({
      layoutDisplay: getComputedStyle(document.querySelector('.layout')).display,
      printRootDisplay: getComputedStyle(document.querySelector('#print-root')).display,
    }));
    assert.equal(printState.layoutDisplay, 'none', 'Print: .layout must be hidden');
    assert.equal(printState.printRootDisplay, 'block', 'Print: #print-root must be shown');
    await page.emulateMedia({ media: 'screen' });
    const screenState = await page.evaluate(() => getComputedStyle(document.querySelector('.layout')).display);
    assert.equal(screenState, 'grid', 'Screen: .layout must return to grid');
  } finally { await context.close(); }
});
