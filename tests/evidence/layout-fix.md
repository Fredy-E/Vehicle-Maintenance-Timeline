# Layout fix — desktop column overlap + mobile badge overflow

Date: 2026-10-08 · Verified in real Chrome (Playwright 1.63.0, `channel: chrome`, headless) · No commits/publishing.

## Symptoms (RED)

| Viewport | Before fix |
|---|---|
| 1440 | `.col-left` panels 482.234px wide inside a 430px column → panel right 572.234 vs timeline left 538 → **34.234px overlap** (same at 1024: 512.234 vs 478) |
| 320 (empty state) | body overflow **35px** |
| 390 / 360 / 320 (shipped sample loaded) | `.entry-schedule` badge inherits `white-space: nowrap` from `.badge`, renders 341px wide → right edge 417 → body overflow **27 / 57 / 97px** |

## Root causes & fixes (style.css only — 3 scoped edits)

1. **Panels are grid items with default `min-width: auto`** — wide intrinsic content (date/file inputs, nowrap unit suffixes) pushed them past the 430px track. Fix: `min-width: 0` on `.panel` (line ~188).
2. **`.field-row` tracks `1fr 1fr` floor at each field's min-content** (~405–410px per two-column row) → children spilled the column even when the panel was constrained. Fix: `grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)` (line ~207).
   Variant isolation: fix 1 alone leaves 19 child spills at 1440; fix 2 alone leaves the 320px body overflow; both are required.
3. **`.entry-schedule` inherited `white-space: nowrap`** from `.badge`, so long data-driven text ("Overdue: date passed …; odometer past … km") could not wrap on narrow screens. Fix: `.entry-schedule { white-space: normal; }` (line ~333) — scoped to the schedule badge only; category badges keep `nowrap`.

## Verified GREEN (after fix)

- `node tests/core.test.cjs` → **71/71 pass** (65/65 when this fix first landed — the unit suite has grown since).
- `node tests/layout.browser.test.cjs` (real-browser regression suite, 4 tests at this landing — 5 since the closure fix below) → **5/5 pass**:
  - 1440: panels [90,520] vs timeline left 538 → **gap 18px**, 0 child spills; 1024: panels [30,460] vs 478 → gap 18px, 0 spills.
  - 390/320: bodyOverflow 0px, 0 right-edge escapes, 0 hidden labels.
  - Sample loaded (4 records) + long-badge record added via the real form: bodyOverflow 0px at 390/320, 5 badges, widest badge right 338px / 268px (wrapped, not clipped); data-loaded desktop sanity clean.
  - Print emulation: `.layout` hidden, `#print-root` shown (print block untouched).
- `npm run test:browser` (full file:// smoke incl. the original overlap assert, mobile, print, import/export) → **2/2 PASS**.

## Out of scope (noted, not edited)

- `core.js` `removeEntry` removes **every** entry whose `id` matches, and import validation can admit duplicate ids — deleting one record can therefore remove several. Owned by the core workstream; no concurrent edit made here.

## Closure fix (2026-10-08): legal 40-char category at 320px

A closure review found one remaining overflow: an entry whose category is at the legal 40-char maximum (`Timing Belt & Water Pump Replacement Kit` — `LIMITS.category = 40` in core.js) made the document 47px wider than a 320px viewport. Reproduced first with a throwaway Playwright probe, then as a failing case in `tests/layout.browser.test.cjs` (RED), then fixed in `style.css` (GREEN). No commits/publishing.

### RED (before the fix, real Chrome)

| Viewport | Measurement |
|---|---|
| 320 | body overflow **47px** (`scrollWidth` 367 vs 320) |
| 320 | `.filters` fields stretched to **332px** (right edge 367) — under `flex-wrap: wrap` the stacked column's flex lines size to the widest item's max-content, and the 40-char `<option>` makes the category `<select>` 332px wide |
| 320 | `span.entry-category.badge` (inherits `.badge`'s `white-space: nowrap`) right edge 326.41 → **6.41px past the viewport**, 58.41px past its card content edge |
| 390 | already 0px overflow (fields 332px, still inside the viewport) |

### Fix (2 scoped style.css edits)

1. Line 564: inside `@media (max-width: 560px)`, `.filters` gains `flex-wrap: nowrap` — a single stacked column is the only layout wanted there, and removing wrapping stops the widest `<option>` from stretching every field.
2. Line 339: `.entry-category { white-space: normal; }` next to the `.entry-schedule` fix — the category badge may wrap; short categories still render on one line.

### GREEN (after the fix, real Chrome)

- 320px long-category: body overflow **0px**, 0 right-edge escapes; fields back to 250px (the panel content width); badge right 268 = card content edge (wraps to 2 lines, 44.38px tall, `scrollWidth` 190 = `clientWidth` 190 — not clipped).
- 390px long-category: body overflow **0px**; badge stays single-line (25.19px tall), right 326.41 ≤ card content edge 338.
- Empty 320px baseline unchanged: 0px overflow, fields 250px, filters block 482.39px tall (same as before).
- `node tests/core.test.cjs` → **71/71 pass** (core untouched).
- `node tests/layout.browser.test.cjs` → **5/5 pass** (new regression imports the same long-category document at 390 and 320; short `Oil & Filter` badges stay single-line; desktop 1440/1024 gaps still 18px; sample and print cases unchanged).
- `node tests/browser.cjs` (full file:// smoke incl. duplicate-import check) → **2/2 PASS**.
- Parent gate `qa/acceptance.cjs maintenance-main maintenance-blocked-storage` → **RED before the fix** (`Mobile body overflow at 320 px: 47 px`), **2/2 PASS after**.

Second-pass polish (parent, after the closure fix): the observation above was fixed — inside the same ≤560px block, `.filters .field.grow { flex: 0 0 auto; }` resets the basis so the stacked search field is content-height (measured 220px → **69.797px** at both 390 and 320). A regression assertion now lives in `tests/layout.browser.test.cjs` ("mobile 390/320" test: search field height < 120px). Re-verified after this edit: `node tests/core.test.cjs` → 71/71 · `node tests/layout.browser.test.cjs` → **5/5** · parent gate `qa/acceptance.cjs maintenance-main maintenance-blocked-storage` → **2/2** (desktop geometry unchanged: gaps still 18px; long-category 320px still 0px overflow). `style.css` md5 after the polish: `1f0109a957f210cec4923a2c6311fd25`.
