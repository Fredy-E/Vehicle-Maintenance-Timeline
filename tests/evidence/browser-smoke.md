# Browser smoke test — real Chrome, real file:// (recorded 2026-10-08)

Environment: Windows 11, Chrome 154.0.8037.98 driven over CDP (dedicated automation
profile, not the user's normal profile), page opened as
`file:///C:/Users/Admin/Documents/Codex/2026-10-07/automotive/Vehicle-Maintenance-Timeline/index.html`.
All checks below are transcribed from the actual driver outputs (trimmed).

## Boot

```
TITLE:    Vehicle Maintenance Timeline — offline service logbook
APIS:     object / object            (window.Maintenance / window.MaintenanceApp)
CHIP:     Browser storage ready      (data-mode="storage")
STORAGE:  {"mode":"storage","reason":null,"blocked":false,"lastSave":null}
CARDS:    0 (fresh)  ·  empty note: "No service records yet. …"
UNIT:     km  ·  default date: 2026-10-08
```

Note: this Chrome **does** allow `localStorage` on `file://`, and it persisted across
reloads (verified below). When a browser blocks it, the app flips to the visible
in-memory mode instead — covered by unit tests with fake storage and by the
corrupted-storage scenario below.

## Workflows driven through the real UI (DOM events, not the test hook)

| Step | Result |
|---|---|
| Vehicle form `requestSubmit()` | toast `"Vehicle profile updated — saved to browser storage."`, chip `"Saved to browser storage"` |
| Add record #1 via form | 1 card; toast `"Service record added — saved to browser storage."` |
| Add record #2 via form | 2 cards; newest-first sort confirmed (`firstDate: "Sep 15, 2026"`) |
| Search filter `"zzz-nomatch"` | 0 cards + empty note `"No records match the current filters."` |
| Search filter `"tiRE"` (case-insensitive) | 1 card; summary `"showing 1 of 2 · 2 records · …"` |
| Edit flow (`.entry-edit` → change description → submit) | form switched to "Edit service record", cancel visible, card updated, back to "Add a service record" |
| Delete → dialog → **Cancel** | dialog opened with the record name; 2 cards remain |
| Delete → dialog → **Confirm** | 1 card remains; toast `"Service record deleted — saved to browser storage."` |
| Import of malformed JSON via `#btn-import` | errors shown (`$.format — format must be "vehicle-maintenance-timeline" (got "nope")`); records still 1; state unchanged |
| Load sample (records exist) | confirmation dialog shown ("This replaces your vehicle profile and 1 existing record(s)…") → 4 fictional records |
| Round-trip import of `exportJSON()` output | confirmation → applied; re-export byte-identical (`exportStable: true`) |
| Reload (`goto_url` same page) | 4 cards restored, nickname restored, chip `"Browser storage ready"` |

## Corrupted-storage scenario (end-to-end)

Wrote garbage (`{broken json not a state`) into the storage key, then reloaded:

```
bannerVisible: true
bannerText:    "The stored document failed validation: not valid JSON: Expected property name or '}' …"
chip:          "Storage: unreadable data found — decide below"
storage:       {"blocked":true, …}
entries:       0   (nothing loaded, nothing overwritten)
```

An action while blocked stayed honest:

```
lastSave: {"saved":false,"mode":"memory","reason":"storage-unreadable"}
toast:    "Service record added — held in memory only (stored data is unreadable — settle the banner first). …"
```

"Start fresh (discard)" (with confirmation) cleared the banner and resumed normal
saving; the fictional sample was reloaded for the final visual pass.

## Bug found during this smoke pass (fixed and re-verified)

The "Stored data could not be read" banner and the "Cancel edit" button were visible
even when they should be hidden: author CSS rules (`display: flex` / `inline-flex`)
override the UA stylesheet's `[hidden] { display: none }`. Fixed with an explicit
`[hidden] { display: none !important; }` rule in `style.css` and re-verified:

```
CLEAN LOAD:   bannerHidden true · bannerVisible false · cancelHidden true · cancelVisible false
DURING EDIT:  cancel button visible · AFTER CANCEL: hidden again
```

Also polished from the visual pass: sticky-header opacity/blur (no more ghosting of
scrolled-under content) and `scroll-margin-top` so `scrollIntoView` never tucks a
panel under the sticky header.

## Screenshots

Captured at three stages (boot/fresh, mid-workflow, final loaded state). Final state:
two-column layout, timeline rail with round status markers (amber = due, red =
overdue), readable badges, summary `"4 records · total cost 388.65 · latest
Aug 21, 2026 @ 65,300 km · 1 overdue · 3 due"`, no banner, no overlaps.
