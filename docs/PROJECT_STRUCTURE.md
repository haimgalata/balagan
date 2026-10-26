# Project structure

A practical guide to where things live and why. For what the app does and how each part works, see `CLAUDE.md`; this doc is only about the folder layout.

## Top-level folders

```
balagan/
├── docs/            this doc
├── seed-data/        static catalog data — tooling input only, not runtime code
├── src/              the app (frontend) — storefront + admin + shared UI
├── supabase/         the backend — schema, RLS, RPCs, storage config
├── scripts/          one-off Node tooling that bridges seed-data/supabase/src
├── tests/            unit + browser tests, one folder per feature area
└── (root config: package.json, vite.config.ts, tailwind.config.js, tsconfig*.json, .env.example)
```

## Why not a top-level `frontend/`/`backend/` split?

There's no server to put in a `backend/` folder — Supabase (a hosted Postgres + Auth + Storage service) *is* the backend, and it already lives in its own top-level folder (`supabase/`). The build is a single static SPA (`vite build` → `dist/`); nothing runs server-side except Supabase itself. Splitting `src/` into a same-level `frontend/` folder would just add a layer of indirection around the one thing (`src/`) that was always frontend.

The boundary that actually needed to be made explicit was **inside** `src/`: the customer storefront vs. the `/checkout` app vs. the privileged admin app vs. the couple of primitives shared between storefront and admin. That's what `src/storefront/`, `src/checkout/`, `src/admin/`, `src/shared/` now do.

## `src/` — the frontend

```
src/
├── main.tsx, App.tsx, index.css, vite-env.d.ts   bootstrap — picks storefront, checkout, or admin by pathname
├── styles/theme.css                              global theme (CSS vars), used by all three apps' Tailwind classes
├── storefront/       customer-facing app (default at "/")
│   ├── components/   presentational UI (Header, Hero, ProductCard, CartDrawer, CartLineRow, ...)
│   ├── context/      CatalogContext, CartContext, BusinessSettingsContext
│   ├── hooks/        useStoreStatus, useOrderStatus, useLocalStorage, ...
│   ├── lib/          catalogApi, pricing, cartStorage, scheduleStatus, stockApi — the storefront's Supabase boundary (plain `fetch`, no supabase-js)
│   ├── pages/        HomePage
│   ├── types/        Product, ProductOption, CartItem, ...
│   └── data/         fallbackCatalog.ts / fallbackBusinessSettings.ts — generated offline fallbacks, used at runtime
├── checkout/         the /checkout app, loaded on demand via a dynamic import in main.tsx
│   ├── checkoutRoute.ts            pure path check — the only checkout code in the customer bundle
│   ├── CheckoutApp.tsx              wraps storefront's Catalog/BusinessSettings/Cart providers
│   ├── CheckoutPage.tsx, OrderSummary.tsx, DetailsForm.tsx, StreetField.tsx
│   ├── useCheckoutValidation.ts     re-validates cart/prices/stock at mount, tab refocus, and pre-submit
│   ├── lib/ordersApi.ts             create_order()/get_order_status() — plain fetch, no supabase-js
│   ├── lib/idempotency.ts           one id per checkout attempt, survives a refresh via sessionStorage
│   └── data/netivotStreets.ts       static street list — delivery is Netivot-only (source noted in the file)
├── admin/            the private /admin app, loaded on demand via a dynamic import in main.tsx
│   ├── categories/, products/, settings/, orders/   one vertical per admin screen (Page + API + validation/errors + hooks)
│   └── shared/apiError.ts                  the only thing shared between the three admin verticals
└── shared/
    └── ui/           Button.tsx, Drawer.tsx — the ONLY code shared between storefront and admin
```

**Why this split:** `src/admin/` was already a near-standalone subtree before this reorganization — it has zero relative imports and depends on the rest of `src/` only through `Button`/`Drawer`. Moving the storefront's own components/context/hooks/lib/pages/types under `src/storefront/` makes that same isolation visible in the folder layout, and gives every future customer-facing or admin-facing feature an obvious, symmetric home. `src/checkout/` is **not** isolated the same way admin is — it deliberately reuses `src/storefront/`'s context/lib/components (`CartContext`, `CatalogContext`, `pricing.ts`, `stockApi.ts`, `CartLineRow.tsx`) so it always sees the exact same cart/catalog state as the homepage; it gets its own top-level folder (rather than living inside `src/storefront/`) because, like admin, it's a separate on-demand entry point reached by pathname, not part of the single-page/hash-anchor storefront.

**The bundle split is real, not just organizational**: `src/admin/adminRoute.ts` and `src/checkout/checkoutRoute.ts` are the only admin/checkout files in the customer bundle (plain path checks). Everything else under `src/admin/` — including `@supabase/supabase-js` itself — and everything under `src/checkout/` ships only in its own separate, lazily-loaded chunk. `tests/admin/auth/bundle.unit.spec.ts` builds the app for real and asserts this for admin on every run.

## `supabase/` — the backend

```
supabase/
├── migrations/0001_*.sql … 0009_*.sql   schema, RLS + is_admin(), storage bucket, public RPCs, admin support, stock, business settings, orders
├── seed.sql                              generated — loads seed-data/ into a fresh database
└── README.md                             apply/verify instructions
```

This is the actual backend: table definitions, Row Level Security policies, and the whitelisted RPCs (`get_storefront_catalog()`, `get_business_settings()`, `check_stock_availability()`, `create_order()`, `get_order_status()`) that are the *only* way the frontend ever touches data. Anonymous visitors have no table access at all — everything goes through an RPC with an explicit column whitelist. The admin app has real table access, but only because `is_admin()` grants it after RLS checks pass. `confirm_payment()` is a step further: granted only to `service_role`, not reachable by `anon`/`authenticated` at all — a future webhook-only trust tier (see `supabase/README.md`'s "Orders" section).

## Shared / config / infrastructure

- **Root config** (`package.json`, `vite.config.ts`, `tailwind.config.js`, `postcss.config.js`, `tsconfig*.json`, `.env.example`) — applies to the whole project, not to either app specifically.
- **`seed-data/`** — `products.ts` / `categories.ts`, the original static catalog. Not imported by the app at runtime; it exists only as input to the scripts below. Edit the database (via `/admin`), not these files, to change what customers see.
- **`scripts/`** — one-off Node tooling, never run as part of `npm run build` or CI:
  - `generate-seed.mjs` — `seed-data/*` → `supabase/seed.sql`
  - `generate-fallback-catalog.mjs` — `seed-data/*` → `src/storefront/data/fallbackCatalog.ts`
  - `verify-seed.mjs` / `security-test.mjs` — check a live Supabase project (anon key + test credentials only, never `service_role`)
  - `baseline/`, `legacy/` — frozen pre-migration snapshot tooling, kept for historical comparison

## `tests/`

One folder per feature area (renamed from development-milestone names so the layout matches what's being tested, not when it was built):

```
tests/
├── baseline/        frozen pre-migration snapshots (fixtures, not specs)
├── catalog/          storefront catalog: loading, caching, parity, visual regression
├── cart/              cart model, pricing, stock-limit UI
├── checkout/          /checkout route check (unit) — validation/details-form coverage grows with the feature
└── admin/
    ├── auth/          login, session, idle logout, bundle-isolation guard
    ├── categories/    admin Categories screen
    ├── products/      admin Products screen + shared inventory
    ├── settings/      admin Business Settings screen
    └── orders/        order management: pure model/route/error unit tests + the board/history/actions browser tests (fake orders database)
```

`*.unit.spec.ts` files run via `npm run test:unit` (pure logic, no browser); everything else runs via `npm run test:e2e` (Playwright + Chrome). `*-live.spec.ts` files are optional and only run when `LIVE_SUPABASE_URL`/`LIVE_*` credentials are set.

## Where future systems should go

| System | Frontend | Backend |
|---|---|---|
| **Orders** | Cart → checkout → real order (cash) all live in `src/checkout/`, done. Still to build: order *history* for customers in `src/storefront/` (near `AccountDrawer.tsx`, once customer auth exists — the RLS policy is already in place); admin order management — **done**, in `src/admin/orders/` (Active board, history/search, actions, alerts) | `supabase/migrations/0009_orders.sql` (`orders`/`order_items`/`payment_attempts`/`payment_events`, `create_order()`/`get_order_status()`/`confirm_payment()`), done. `supabase/migrations/0010_order_management.sql` (owner/staff roles, lifecycle, `order_status_events`, `transition_order()`/`resolve_stock_return()`), done. Still to build: a webhook Edge Function calling `confirm_payment()` once a payment provider is chosen |
| **Customers/users (Balagan Club)** | `src/account/` — a lazily loaded vertical (login seam, session context, join step, and the `/account` personal area in `src/account/page/`); only `AccountDrawer.tsx` + `src/account/memberHint.ts` are in the main bundle. Login provider undecided: the build constant `__CUSTOMER_AUTH__` is `off` in production, `mock` for the e2e `account` variant (see `CLAUDE.md` "Club accounts"). Checkout integration (prefill, saved addresses, member token) lives in `src/checkout/` behind its `club.tsx` seam | `0011` (customer-permission hardening) and `0012` (`customers`, `customer_consents`, `customer_addresses`, `join_club()`, `get_my_orders()` …) — applied to the database separately from the app; the member's phone is always read from `auth.users.phone` |
| **Customer management (owner)** | `src/admin/customers/` — the owner's member list, numbers and audience exports (owner only; the shell hides it from staff) | `0013_customer_admin.sql` — owner-only functions + the closed `customer_exports` log; no direct table access |
| **Deliveries** | **Done (windows, runs, courier):** the courier's own screen in `src/admin/courier/` (route `/admin/courier`), the board's lane + runs panel in `src/admin/orders/` (`runModel.ts`, `RunsPanel.tsx`), the owner's windows editor in `src/admin/settings/`, the window picker in `src/checkout/` (`useDeliverySlots.ts`, pure rules in `src/storefront/lib/deliveryWindows.ts`) and the departure line on `src/order/`. Not built: route optimisation, customer notifications | `supabase/migrations/0017_delivery.sql` (`delivery_windows`, `delivery_runs`, the `courier` role, the courier RPCs, `get_delivery_slots()`) |
| **Payments** | No provider chosen yet. The schema is ready for one (`payment_attempts`/`payment_events`, `payment_method: 'card'` support in `create_order()`), and the plan is a Supabase Edge Function: one to prepare/redirect to the provider, one signature-verified webhook calling `confirm_payment()` (granted only to `service_role` — never reachable from the browser) | Extends `supabase/migrations/0009_orders.sql` — no `orders`/`order_items` schema change expected |
| **Inventory** | Extends the existing shared-stock model in `src/admin/products/` | Extends `stock_base_units` / `check_stock_availability()` |
| **Admin/employee management** | New `src/admin/employees/` vertical (UI to add/remove individual employee accounts — today the shared staff account is created by hand, see `supabase/README.md`) | Extends the `admin_users` allow-list (`role` column already exists, `owner`/`staff`) |
| **Production deployment** | Root-level host config (`netlify.toml` / `vercel.json` / etc. — see `CLAUDE.md`) | — |

The rule of thumb: if it's something a customer or the admin sees and interacts with, it goes under `src/storefront/` or `src/admin/` respectively, following the existing per-feature-vertical pattern (`categories/`, `products/`, `settings/`). If it's a rule the database should enforce regardless of what the frontend does, it goes in a new numbered `supabase/migrations/000N_*.sql` file.
