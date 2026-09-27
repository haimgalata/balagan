# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

E-commerce site for a physical Hebrew-speaking tobacco/smoking-products store ("בלאגן - מרכז הסיגריות והטבק"). React + TypeScript + Vite + Tailwind CSS + lucide-react, backed by Supabase (Postgres + Row Level Security + Auth + Storage) for the catalog and a private admin area. The build is still a static SPA — Vite just outputs `dist/`; nothing runs server-side except Supabase itself.

**The "מעבר לתשלום" (checkout) button in `CartDrawer.tsx` is intentionally inert.** There is no order-processing/payment backend; wiring one up is a future step, not something to add unprompted. Everything documented below as "the real protection" (RLS, `is_admin()`) exists precisely because the admin area and the database are real and reachable — don't reintroduce a "no backend" assumption anywhere in this codebase.

## Commands

```
npm install       # install dependencies
npm run dev       # start Vite dev server (default port 5173)
npm run build     # tsc -b (typecheck) && vite build -> dist/
npm run preview   # preview the production build
npm run test:unit # pure logic tests (*.unit.spec.ts), via Playwright's test runner, no browser needed
npm run test:e2e  # full browser suite (storefront regression + admin), Playwright + installed Chrome
```

No ESLint config exists in the repo. `supabase/` holds the database side: migrations (`supabase/migrations/000N_*.sql`, apply in order, see `supabase/README.md`), the generated seed (`supabase/seed.sql`), and one-off Node scripts run manually (never as part of `npm run build`/CI): `scripts/generate-seed.mjs` (static catalog → `seed.sql`), `scripts/verify-seed.mjs` (live database vs. the frozen baseline), `scripts/security-test.mjs` (RLS/RPC/storage behavior against a real project, admin credentials via environment variables only — never the `service_role` key, never committed).

## Architecture

### Hebrew / RTL is foundational, not a layer

`index.html` sets `<html lang="he" dir="rtl">`. Layout is expected to work via CSS logical properties (`start`/`end`, `ms-`/`me-`, `ps-`/`pe-`) rather than physical `left`/`right`, so it flips correctly for RTL without special-casing. DOM order matters for flex layout under `dir="rtl"` (first child renders on the right) — e.g. `Header.tsx` relies on this instead of manual reordering.

### Centralized theme

All brand colors live as CSS custom properties in `src/styles/theme.css` (`--color-bg`, `--color-gold`, etc., as `R G B` triplets). `tailwind.config.js` maps them to `brand.*` Tailwind colors (`bg-brand-gold`, `text-brand-text-muted`, ...). Components must use these `brand-*` classes — never hardcode hex colors. To re-theme the whole site, edit `theme.css` only.

### Catalog: read from Supabase, not hardcoded

- The storefront has **no table access** — anonymous visitors can only call the whitelisted RPC `get_storefront_catalog()` (`supabase/migrations/0004_rpc.sql`, updated by `0006`). It returns visible categories → subcategories → products, already ordered, with an explicit column whitelist (no barcode, no stock counts, no hidden rows).
- `src/lib/catalogApi.ts` fetches it with one plain `fetch` — **no `@supabase/supabase-js` in the customer bundle**; that library is admin-only (see below). `src/context/CatalogContext.tsx` (`CatalogProvider`/`useCatalog`) is the single source of the catalog: stale-while-revalidate cache (`localStorage["balagan_catalog_v1"]`), "loading" status only on a first-ever visit with nothing cached, and a bundled offline fallback (`src/data/fallbackCatalog.ts`, generated) if the network/database is unreachable and there's no cache either.
- `VITE_CATALOG_SOURCE=static` (or missing Supabase env vars) makes the storefront use the bundled fallback catalog exclusively — an instant rollback switch, and how the site behaved before Supabase existed.
- `src/data/products.ts` / `categories.ts` are **no longer the live source** — they're the one-off seed input (`scripts/generate-seed.mjs` → `supabase/seed.sql`) and the input to the generated offline fallback. Don't edit them expecting the storefront to change; edit the database (via `/admin`) instead.
- Linking convention: a product's subcategory comes from an explicit `subcategory_id` (`product.subcategorySlug` in the mapped shape); `CategorySection.tsx` groups by it, falling back to a slug derived from `brand` only when `subcategorySlug` is absent (legacy/offline data only — new products always carry an explicit subcategory, enforced by the admin form whenever the category has one).

### Business settings: read from Supabase, not hardcoded

- Same architecture as the catalog, for a different, smaller dataset: physical-store opening hours, online-order hours, minimum order, delivery fee, and a manual order-pause switch. Public RPC `get_business_settings()` (`supabase/migrations/0008_business_settings.sql`) is the only read path — `src/lib/businessSettingsApi.ts` (plain `fetch`, no supabase-js) + `src/context/BusinessSettingsContext.tsx` (`BusinessSettingsProvider`/`useBusinessSettings`) mirror `catalogApi.ts`/`CatalogContext.tsx`: stale-while-revalidate cache (`localStorage["balagan_business_settings_v1"]`) and a bundled offline fallback (`src/data/fallbackBusinessSettings.ts`) — but no "loading" status, since showing today's placeholder hours immediately (swapped for live data once fetched) is a fine first paint for a pill/banner, unlike the product catalog.
- `src/lib/scheduleStatus.ts`'s `computeScheduleStatus()`/`getIsraelNow()` turn a weekly schedule into "open now" + today's hours label, anchored explicitly to `Asia/Jerusalem` via `Intl.DateTimeFormat` — never the visitor's own device clock/timezone (a real visitor abroad, or with a wrong clock, must still see the Israel-local answer). `src/hooks/useStoreStatus.ts` (the **physical store**) and `src/hooks/useOrderStatus.ts` (**online orders**) each wrap it for their own schedule, re-ticking every 60 seconds.
- These are two clearly separate concepts, not one conflated status: `Hero.tsx`'s pill (physical-store open/closed + today's hours, in the same spot it's always been) is a button that expands `StoreHoursPanel.tsx` — the full week, today highlighted — directly beneath it. `BusinessInfoBar.tsx` (the sticky strip below `Hero`) is specifically the **online-orders** banner (green "הזמנות פתוחות" / red "הזמנות סגורות") + today's order hours + minimum order + delivery fee, all from `useOrderStatus()`. `CartDrawer.tsx`'s footer reads the same min-order/delivery-fee numbers straight from `useBusinessSettings()`, so it can never drift from the banner.
- **The manual `orders_paused` override is one-way**: `isOpen = schedule says open AND NOT orders_paused` (see `useOrderStatus.ts`). It can only force online orders closed early; there is no way to force them open outside the configured schedule — a deliberate simplicity/safety choice.

### Navigation is scroll-anchors, not a router

There's no router; it's a single page (`HomePage.tsx`). Category/subcategory links are `href="#slug"` / `href="#slug-subSlug"` hashes pointing at section ids rendered by `CategorySection.tsx` (per category) and the `id="popular"`/`id="categories"` sections in `HomePage.tsx`. `/admin` is a separate, unrelated entry point (see below) — it isn't part of this page or its hash routing.

### Cart state, pricing, and the shared-stock check

- `src/context/CartContext.tsx` (`CartProvider`/`useCart`) holds cart lines. A line is a **product + the option the customer explicitly chose** (`"unit"` or `"package"`) — nothing is ever converted between them (adding 10 loose units never becomes a package). Persistence is `src/lib/cartStorage.ts` under `localStorage["balagan_cart_v2"]`; an old `balagan_cart` (pre-option-model) is migrated once and left byte-for-byte untouched afterward.
- Prices are never stored in the cart — read live from the catalog via `src/lib/pricing.ts` (`getOptionPricing`, `getLineTotalCents`, ...), in integer agorot (no floating-point artifacts). A line whose product/option can't currently be resolved (catalog loading, hidden, package removed) stays in storage but isn't shown or priced — never destructively pruned.
- **Shared-stock quantity check** (`supabase/migrations/0007_stock_availability.sql`, `src/lib/stockApi.ts`): `addItem`/`increment` are `async` — before changing the cart they ask `check_stock_availability()` whether the product's *total* requested quantity (unit + package lines converted to the same base-unit count via `getOptionBaseUnits`/`getLineBaseUnits` in `pricing.ts`) still fits its shared stock. The RPC is boolean-only (`{product_id, available}`) and never reveals the actual stock count, `track_stock`, or whether a hidden product exists — the cart never gets to see the number, only a yes/no for the quantity it's proposing. If the check itself fails (network error), the add is refused too (**fails closed**) with its own message, rather than let an unverified quantity through. This is a UX safeguard only — it doesn't reserve or lock stock, and a future real order-processing system must still revalidate everything server-side.
- Opening the cart drawer re-checks every distinct product already in the cart in the background (catches stock that dropped after items were added) and flags a line that no longer fits (`CartLine.overLimit`) with a visible warning; the customer can still decrease/remove it, which re-checks that product immediately.
- Toasts (`Toast.tsx`, driven by `CartContext`'s `toast` state) come in two kinds: `"success"` (added) and `"warning"` (blocked — not enough stock, or the check couldn't be completed).

### Admin area (`/admin`) — real protection is in the database, not the route

- `src/main.tsx` loads `src/admin/AdminApp.tsx` **on demand** only when the address is under `/admin` (`src/admin/adminRoute.ts` — a pure path check, no React/Supabase — is the *only* admin code in the customer bundle; a real-build test, `tests/step5/bundle.unit.spec.ts`, enforces this). Nothing on the customer site links to `/admin`; it's `noindex`.
- Authentication is Supabase Auth (email + password; public sign-ups must stay disabled in the dashboard). Authorization is **independent of authentication**: an `admin_users` allow-list checked by `is_admin()` (`supabase/migrations/0002_rls.sql`) — being logged in is never enough. Every table has default-deny Row Level Security with policies gated on `is_admin()`; the admin route guard (`src/admin/useAdminSession.ts`) is UX only. 60-minute idle logout.
- **MFA is deferred, not implemented.** `is_admin()` has a commented-out line requiring an `aal2` (MFA-verified) session — flip it on (and re-run `0002_rls.sql`) only once the admin UI has a TOTP-enrollment screen (not built yet), and only when the site is about to go live to real customers. Enabling the line before that screen exists would lock the admin out of writes.
- **Categories** (`/admin/categories`, `src/admin/categories/*`, migration `0005`): Hebrew/English names, visibility, up/down ordering, add/delete (delete blocked while something still holds products/subcategories — hide instead). A slug is chosen once at creation and locked afterward (it's the public `#anchor`).
- **Products** (`/admin/products`, `src/admin/products/*`, migration `0006`): two tabs — a searchable/filterable/paginated list (find, add, edit, hide, real permanent delete with a two-step confirm — nothing else references a product, unlike categories) and a separate ordering view (pick one category+subcategory group, up/down; a category with no subcategories skips straight to its one group). **Shared inventory**: one `stock_base_units` count per product plus `track_stock`; `unit_in_stock`/`package_in_stock` are `GENERATED` columns (`stock_base_units >= required OR NOT track_stock`, AND the independent manual `unit_available`/`package_available` switches) — a unit and its package draw from the *same* pool, not separate counters. A product's photo is always optional, in create AND in edit: `ProductImagePicker.tsx` (create — stages a file locally, no product id exists yet) and `ImageUploader.tsx` (edit — uploads and saves immediately, independently of the rest of the form) both funnel through the same `uploadProductImage`/`updateProduct` in `productsApi.ts`; a create's image step failing never rolls back the product itself (see `ProductsListTab.submitCreate`).
- **Business Settings** (`/admin/settings`, `src/admin/settings/*`, migration `0008`): two sections — physical-store weekly hours, and everything about online orders (weekly hours, minimum order, delivery fee, a manual pause switch that's a one-way override — see below). No drawer; each section is a plain form with an explicit "שמירה", except the pause switch, which applies immediately (an emergency control shouldn't wait on an unrelated unsaved edit in the same form).

### Database

`supabase/migrations/0001` through `0008` (apply in order; each file's header says what it does and whether it's re-runnable). High-level: `0001` schema, `0002` RLS + `is_admin()`, `0003` the `product-images` storage bucket, `0004` the public catalog RPC, `0005` admin Categories support, `0006` admin Products support (shared inventory), `0007` the cart's stock-availability RPC, `0008` `business_hours`/`business_settings` + the public `get_business_settings()` RPC. `supabase/README.md` has apply/verify instructions for each. Product ids stay `text` (`"1"`…`"148"` with intentional gaps, inherited from the pre-migration static catalog); new products get `149, 150, …` from `product_id_seq`.

### Shared UI primitives

- `components/ui/Button.tsx` — the only place button variant styling (`primary`/`secondary`/`outline`/`ghost`) is defined.
- `components/ui/Drawer.tsx` — shared slide-in panel (backdrop, Escape-to-close, scroll lock, transform-based slide) used by `CartDrawer.tsx`, `MobileNavigation.tsx`, and the admin's `CategoryFormDrawer.tsx`/`ProductFormDrawer.tsx`. Extend this rather than building a second drawer implementation.

### Known gotcha: off-canvas panels and horizontal scroll

`Drawer.tsx` hides panels via `-translate-x-full`/`translate-x-full` while keeping them in the DOM. Chrome still counts a translated-off-screen fixed/absolute element toward `document.documentElement.scrollWidth`, which silently adds a phantom horizontal scrollbar. This is why `src/index.css` sets `overflow-x: hidden` on `html, body` — don't remove it, and apply the same fix if you add another off-canvas element.

### Known gotcha: testing from a real phone over `npm run dev`

`npm run dev` serves plain HTTP with no TLS. Opening it from a real phone over the LAN by IP address (`http://192.168.x.x:5173`) is **not a secure context** (only `https:`/`localhost`/`127.0.0.1` count) — desktop and even DevTools' mobile emulation don't hit this, because both stay on `localhost`. Anything that depends on a secure-context-gated browser API (e.g. `crypto.randomUUID()` — this bit `uploadProductImage` in `productsApi.ts` once; it now uses a plain non-crypto id) will silently misbehave ONLY in this specific real-device-over-LAN case, never in production (a real deploy is HTTPS). If something "works on desktop but not on a real phone" during dev, check `window.isSecureContext` on the phone before assuming the bug is about the phone, the file, or the network.

### Path alias

`@/` resolves to `src/` (configured in both `vite.config.ts` and `tsconfig.app.json`).

### Assets

- `/public/images/logo.png` and `/public/images/header-logo.png` are the real business logo (used by `Hero.tsx`/`AgeGate.tsx` and `Header.tsx` respectively) — never regenerate/replace them in code.
- `/public/images/products/placeholder.svg` is the stand-in image for a product until it has a real photo (see the admin's optional image upload above).

### Environment variables and deploying

`.env.example` lists what's needed: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` (the anon/publishable key only — **the `service_role` key must never appear anywhere in this project**, in code, an env file, or a commit), and `VITE_CATALOG_SOURCE`. Vite bakes these into the build, so whatever host serves the production build needs the same variables set in its build settings.

No hosting provider is configured in this repo yet (no `netlify.toml`/`vercel.json`/etc.). Whichever static host is eventually chosen must be told to serve `index.html` for unknown paths (an "SPA fallback" / rewrite rule) — without it, a customer directly navigating or refreshing on `/admin` gets the host's own 404 instead of the app. One-line reference for when a host is picked (not yet added as a file):
- **Netlify** (`netlify.toml`): `[[redirects]]` with `from = "/*"`, `to = "/index.html"`, `status = 200`.
- **Vercel** (`vercel.json`): `"rewrites": [{ "source": "/(.*)", "destination": "/index.html" }]`.
- **Cloudflare Pages**: SPA fallback is automatic for a Vite build with no extra config.
