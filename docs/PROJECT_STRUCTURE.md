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

The boundary that actually needed to be made explicit was **inside** `src/`: the customer storefront vs. the privileged admin app vs. the couple of primitives both share. That's what `src/storefront/`, `src/admin/`, `src/shared/` now do.

## `src/` — the frontend

```
src/
├── main.tsx, App.tsx, index.css, vite-env.d.ts   bootstrap — picks storefront or admin by pathname
├── styles/theme.css                              global theme (CSS vars), used by both apps' Tailwind classes
├── storefront/       customer-facing app (default at "/")
│   ├── components/   presentational UI (Header, Hero, ProductCard, CartDrawer, ...)
│   ├── context/      CatalogContext, CartContext, BusinessSettingsContext
│   ├── hooks/        useStoreStatus, useOrderStatus, useLocalStorage, ...
│   ├── lib/          catalogApi, pricing, cartStorage, scheduleStatus, stockApi — the storefront's Supabase boundary (plain `fetch`, no supabase-js)
│   ├── pages/        HomePage
│   ├── types/        Product, ProductOption, CartItem, ...
│   └── data/         fallbackCatalog.ts / fallbackBusinessSettings.ts — generated offline fallbacks, used at runtime
├── admin/            the private /admin app, loaded on demand via a dynamic import in main.tsx
│   ├── categories/, products/, settings/   one vertical per admin screen (Page + API + validation/errors + hooks)
│   └── shared/apiError.ts                  the only thing shared between the three admin verticals
└── shared/
    └── ui/           Button.tsx, Drawer.tsx — the ONLY code shared between storefront and admin
```

**Why this split:** `src/admin/` was already a near-standalone subtree before this reorganization — it has zero relative imports and depends on the rest of `src/` only through `Button`/`Drawer`. Moving the storefront's own components/context/hooks/lib/pages/types under `src/storefront/` makes that same isolation visible in the folder layout, and gives every future customer-facing or admin-facing feature an obvious, symmetric home.

**The customer/admin bundle split is real, not just organizational**: `src/admin/adminRoute.ts` is the only admin file in the customer bundle (a plain path check). Everything else under `src/admin/` — including `@supabase/supabase-js` itself — ships only in a separate, lazily-loaded chunk. `tests/admin/auth/bundle.unit.spec.ts` builds the app for real and asserts this on every run.

## `supabase/` — the backend

```
supabase/
├── migrations/0001_*.sql … 0008_*.sql   schema, RLS + is_admin(), storage bucket, public RPCs, admin support, stock, business settings
├── seed.sql                              generated — loads seed-data/ into a fresh database
└── README.md                             apply/verify instructions
```

This is the actual backend: table definitions, Row Level Security policies, and the whitelisted RPCs (`get_storefront_catalog()`, `get_business_settings()`, `check_stock_availability()`) that are the *only* way the frontend ever touches data. Anonymous visitors have no table access at all — everything goes through an RPC with an explicit column whitelist. The admin app has real table access, but only because `is_admin()` grants it after RLS checks pass.

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
└── admin/
    ├── auth/          login, session, idle logout, bundle-isolation guard
    ├── categories/    admin Categories screen
    ├── products/      admin Products screen + shared inventory
    └── settings/      admin Business Settings screen
```

`*.unit.spec.ts` files run via `npm run test:unit` (pure logic, no browser); everything else runs via `npm run test:e2e` (Playwright + Chrome). `*-live.spec.ts` files are optional and only run when `LIVE_SUPABASE_URL`/`LIVE_*` credentials are set.

## Where future systems should go

| System | Frontend | Backend |
|---|---|---|
| **Orders** | Customer checkout/history in `src/storefront/` (near `CartDrawer.tsx`); admin order management in a new `src/admin/orders/` | New `supabase/migrations/0009_orders.sql` + RPCs |
| **Customers/users** | Real accounts extend `src/storefront/` (near `AccountDrawer.tsx`) | Supabase Auth changes for customer accounts (separate from admin auth) |
| **Deliveries** | Admin-side in a new `src/admin/deliveries/`; customer-facing status in `src/storefront/` | Extends the orders schema/RPCs |
| **Payments** | Not yet decided — this static-SPA-plus-Supabase setup has no safe place to run payment/webhook logic today (likely a Supabase Edge Function or a real server later) | — |
| **Inventory** | Extends the existing shared-stock model in `src/admin/products/` | Extends `stock_base_units` / `check_stock_availability()` |
| **Admin/employee management** | New `src/admin/employees/` vertical | Extends the `admin_users` allow-list |
| **Production deployment** | Root-level host config (`netlify.toml` / `vercel.json` / etc. — see `CLAUDE.md`) | — |

The rule of thumb: if it's something a customer or the admin sees and interacts with, it goes under `src/storefront/` or `src/admin/` respectively, following the existing per-feature-vertical pattern (`categories/`, `products/`, `settings/`). If it's a rule the database should enforce regardless of what the frontend does, it goes in a new numbered `supabase/migrations/000N_*.sql` file.
