# Regression suites (tests/step3 storefront, tests/step4 cart, tests/step5 admin, tests/step6 categories)

Proves the storefront reads its catalog from the database and still looks and behaves **exactly** like the
pre-migration app (tag `baseline/pre-product-management`), for both catalog sources:

| Variant (Playwright project) | Catalog source | Backend |
|---|---|---|
| `static-desktop` / `static-mobile` | bundled fallback catalog `src/data/fallbackCatalog.ts` (`VITE_CATALOG_SOURCE=static`) | none |
| `supabase-desktop` / `supabase-mobile` | live-catalog code path | the RPC is answered **inside the browser** with the seeded catalog (built from `tests/baseline/catalog.json`), so failures/slowness can be simulated |
| `live-desktop` / `live-mobile` *(optional)* | your real Supabase project | real network, anon key only |

Uses your installed Chrome (`channel: "chrome"`), fixed clock, blocked web fonts, disabled animations, and waits for all
images to decode, so runs are deterministic.

```
npm run test:unit    # pure functions (pricing, cart storage/migration, fallback catalog) — no browser, ~1 s
npm run test:e2e     # browser suites on static + stubbed-database variants, desktop + mobile
npx playwright test parity navigation catalog --project=supabase-desktop     # one variant
```

## Specs
- `parity.spec.ts` — rendered text (tabs, sub-nav, one line per product card) equals `tests/baseline/dom-text/*.txt`.
- `visual.spec.ts` — 11 screenshots x 2 viewports must have **0 differing pixels** vs. baseline images rendered from the tag.
- `catalog.spec.ts` — loading state, cache (stale-while-revalidate), HTTP 500 / malformed / non-JSON / never-answering
  responses, corrupted cache, product removed from the DB while in a saved cart, static mode makes no DB request.
- `tests/step4/cart-migration.spec.ts` — the 12 captured dev carts migrate to the explicit-option cart (`balagan_cart_v2`):
  units stay units, the old `balagan_cart` key is untouched, nothing is deleted, out-of-stock lines are excluded.
- `tests/step4/cart-options.spec.ts` — the customer chooses unit or package explicitly (10 units = ₪510, 1 package = ₪500),
  the badge counts purchase items (2 units + 1 package = 3), independent lines/steppers, float-free totals, per-option
  sales/labels/availability, a product without a package.
- `tests/step4/*.unit.spec.ts`, `tests/step5/*.unit.spec.ts` — pure unit tests (`playwright.unit.config.ts`); `bundle.unit.spec.ts` does a real
  production build and proves the admin code (incl. the Supabase client) is a separate on-demand chunk absent from the customer bundle.
- `tests/step5/admin-auth.spec.ts` — the private `/admin`: login, generic errors (no user enumeration), non-admin refusal, session
  persistence, sign-out, 60-minute idle logout, noindex. Uses an in-browser fake of Supabase Auth/is_admin()/admin tables
  (stubbed-database variant only). `no-admin-links.spec.ts` proves nothing on the customer site links to or loads the admin.
- `tests/step5/admin-live.spec.ts` *(optional, you run it)* — the same login against your real project; credentials come only
  from environment variables (`LIVE_ADMIN_EMAIL`/`LIVE_ADMIN_PASSWORD`, optional `LIVE_USER_EMAIL`/`LIVE_USER_PASSWORD`).
- `tests/step6/categories.spec.ts` — the admin Categories screen through the real UI against an in-memory fake of the database's
  admin tables/functions (`fakeDatabase.ts`, which also serves the public catalog so tests can check the SHOP after an admin edit):
  list/counts, create (slug suggestion + validation), edit (slug read-only), visibility, up/down ordering, delete rules,
  stale-list and failure handling. `categories-helpers.unit.spec.ts` covers slug rules, ordering and error mapping.
- `tests/step6/categories-live.spec.ts` *(optional, you run it; needs migration 0005)* — the same flows on the real database using
  only hidden `zz-e2e-…` probe rows (real categories are never touched).
- `navigation.spec.ts` — deep links (incl. `#cigarettes-l&m`), footer links, tab counts, every subcategory lists its
  products in baseline order, search, adding a unit and a package as two separate lines.

## Screenshots are not in git (about 15 MB) — regenerate them from the tag
```powershell
git worktree add --detach ..\balagan-baseline baseline/pre-product-management
cmd /c mklink /J ..\balagan-baseline\node_modules node_modules          # reuse dependencies
$env:BASELINE_DIR = (Resolve-Path ..\balagan-baseline).Path
npx playwright test visual --update-snapshots --project=baseline-desktop --project=baseline-mobile
Remove-Item Env:BASELINE_DIR
cmd /c rmdir ..\balagan-baseline\node_modules                            # removes only the link
git worktree remove --force ..\balagan-baseline
npx playwright test visual                                               # compare the current code
```

## Run against your real Supabase project (anon key only)
```powershell
$env:LIVE_SUPABASE_URL="https://YOUR-PROJECT.supabase.co"; $env:LIVE_SUPABASE_ANON_KEY="<anon or publishable key>"
npx playwright test parity navigation cart-migration cart-options --project=live-desktop --project=live-mobile
```
This exercises real CORS/headers/network with the real seeded data (what `scripts/verify-seed.mjs` proved equals the baseline).

## Snapshot approval note (Step 4)
The only intended pixel changes vs the pre-migration baseline are the **cart summary bar and cart drawer** screenshots
(`*-10-cart-summary-bar.png`, `*-11-cart-drawer.png`): the cart now shows one row per chosen option, the badge counts
purchase items and out-of-stock lines are excluded. Every other screenshot must stay at 0 differing pixels. After reviewing
the new cart images, accept them with:
`npx playwright test visual -g "10/11" --update-snapshots` (static projects; the database variants must then pass unchanged).
