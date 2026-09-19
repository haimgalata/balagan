# Pre-migration baseline ("before" snapshot)

Frozen from tag **`baseline/pre-product-management`** (commit `7a5a614`): the storefront exactly as it was before
the Supabase product-management migration. Purpose: after every migration step, prove that **product IDs,
category/subcategory navigation, product order, storefront appearance and saved carts did not change**
(except where a decision explicitly says so — see the plan).

## Files

| File | What it is | How it was produced |
|---|---|---|
| `catalog.json` | All 141 products (`position`, `id`, name, brand, category, derived subcategory, `unitPrice`, **old** pack regular/price, `inStock`, image, description), the category → subcategory tree with per-subcategory `productIds` in exact render order, counts, id gaps, sha256 of the product rows | `node --no-warnings scripts/baseline/capture-catalog.mjs` (deterministic; re-running gives a byte-identical file) |
| `cart-legacy-fixtures.json` | 12 raw `localStorage["balagan_cart"]` payloads (empty, 1/9/10/23 units, multi-product incl. out-of-stock + tobacco, ancient `{type:"pack"}`, unknown id, bad quantities, duplicates, non-array, corrupt JSON) + what the OLD model should show | `node --no-warnings scripts/baseline/capture-cart-fixtures.mjs` |
| `cart-legacy-observed.json` | What the OLD app **actually rendered** for each fixture (drawer lines, total, header badge, and the `balagan_cart` value the app wrote back). Cross-checked equal to the computed expectations for all 12 | Playwright browser run (below) |
| `dom-text/{desktop,mobile}-{cigarettes,tobacco}.txt` | One line per rendered product card (brand, name, unit price, pack row, out-of-stock badge, button disabled state) grouped by subcategory anchor, plus the info bar, category tabs and sub-nav text | Playwright `evaluate` on the running dev server |
| screenshots (22 PNGs, **not in git**) | Age gate, both category pages (viewport + full page), 3 deep links, search overlay, out-of-stock card (id 3), cart summary bar, cart drawer — at 1440×900 and 390×844 | Kept outside the repo in `Desktop\balagan-backup-2026-09-19\baseline-screenshots\`. Regenerate any time from the tag (see below) |

Verified at capture time: the rendered text of both categories at both viewports equals `catalog.json` on all
282 card checks (order, name, unit price, old pack prices, out-of-stock state).

## Capture conditions (needed to reproduce)

- Dev server `npm run dev` on `http://localhost:5173`, Chromium 152 via the Playwright tool.
- Viewports 1440×900 and 390×844, `reducedMotion: reduce`, locale `he-IL`, timezone `Asia/Jerusalem`.
- `Date` fixed with `page.clock.setFixedTime('2026-09-20T10:00:00+03:00')` (the business-hours bar is time-dependent).
- `localStorage.balagan_age_verified = "true"` pre-set (except for the age-gate shot); `balagan_cart` set per fixture.
- Screenshots also inject `*{transition:none!important;animation:none!important}` and wait for `document.fonts.ready`.
  Google Fonts are loaded from the network, so a rare font-load difference is possible.

## Facts frozen here

- 141 products, ids `"1"`–`"148"` with gaps `6, 7, 10, 11, 66, 68, 69`; no duplicate ids.
- `cigarettes` 110 products / 20 subcategories, `tobacco` 31 / 12 (32 subcategories); every product maps to a subcategory.
- Out of stock: ids `3` and `9`.
- Old pack rule (global): 10 units, price = `unit × 10 − 10`, struck-through regular = `unit × 10`.
- Old cart behavior: `quantity` = total units; every 10 units auto-priced as a pack (10 units of id 1 = ₪500, 23 units = ₪1153).
  Under the new model (decision D1/D3) 10 saved units re-price to ₪510 with a one-time notice.

## Re-rendering the "before" storefront later

```
git worktree add ../balagan-baseline baseline/pre-product-management
cd ../balagan-baseline && npm install && npm run dev -- --port 5174
```
Point the same capture steps at port 5174 to regenerate screenshots with identical tooling to the "after" run.
