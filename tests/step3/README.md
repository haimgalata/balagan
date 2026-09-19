# Step 3 regression suite

Proves the storefront reads its catalog from the database and still looks and behaves **exactly** like the
pre-migration app (tag `baseline/pre-product-management`), for both catalog sources:

| Variant (Playwright project) | Catalog source | Backend |
|---|---|---|
| `static-desktop` / `static-mobile` | bundled `src/data` files (`VITE_CATALOG_SOURCE=static`) | none |
| `supabase-desktop` / `supabase-mobile` | live-catalog code path | the RPC is answered **inside the browser** with the seeded catalog (built from `tests/baseline/catalog.json`), so failures/slowness can be simulated |
| `live-desktop` / `live-mobile` *(optional)* | your real Supabase project | real network, anon key only |

Uses your installed Chrome (`channel: "chrome"`), fixed clock, blocked web fonts, disabled animations, and waits for all
images to decode, so runs are deterministic.

```
npm run test:e2e                              # everything except the pixel comparison's baseline generation
npx playwright test parity cart catalog navigation --project=supabase-desktop     # one variant
```

## Specs
- `parity.spec.ts` — rendered text (tabs, sub-nav, one line per product card) equals `tests/baseline/dom-text/*.txt`.
- `visual.spec.ts` — 11 screenshots x 2 viewports must have **0 differing pixels** vs. baseline images rendered from the tag.
- `cart.spec.ts` — the 12 saved-cart payloads render exactly as the old app rendered them (one documented difference:
  unresolvable ids are kept in storage instead of erased).
- `catalog.spec.ts` — loading state, cache (stale-while-revalidate), HTTP 500 / malformed / non-JSON / never-answering
  responses, corrupted cache, product removed from the DB while in a saved cart, static mode makes no DB request.
- `navigation.spec.ts` — deep links (incl. `#cigarettes-l&m`), footer links, tab counts, every subcategory lists its
  products in baseline order, search, add unit/pack with the old pack pricing.

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
npx playwright test parity navigation cart visual --project=live-desktop --project=live-mobile
```
This exercises real CORS/headers/network with the real seeded data (what `scripts/verify-seed.mjs` proved equals the baseline).
