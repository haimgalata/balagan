# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Frontend-only e-commerce prototype for a physical Hebrew-speaking tobacco/smoking-products store ("בלגן - מרכז הסיגריות והטבק"). React + TypeScript + Vite + Tailwind CSS + lucide-react.

**Hard constraint: no backend.** No database, auth, server, admin panel, or payment processor (Stripe/Supabase/Firebase/etc.) has been added intentionally — don't introduce one unless explicitly asked. The cart and age-gate are entirely client-side, backed by `localStorage`. The "מעבר לתשלום" (checkout) button in `CartDrawer.tsx` is intentionally inert.

## Commands

```
npm install       # install dependencies
npm run dev       # start Vite dev server (default port 5173)
npm run build     # tsc -b (typecheck) && vite build -> dist/
npm run preview   # preview the production build
```

There is no test suite and no lint script configured (no ESLint config exists in the repo).

## Architecture

### Hebrew / RTL is foundational, not a layer

`index.html` sets `<html lang="he" dir="rtl">`. Layout is expected to work via CSS logical properties (`start`/`end`, `ms-`/`me-`, `ps-`/`pe-`) rather than physical `left`/`right`, so it flips correctly for RTL without special-casing. DOM order matters for flex layout under `dir="rtl"` (first child renders on the right) — e.g. `Header.tsx` relies on this instead of manual reordering.

### Centralized theme

All brand colors live as CSS custom properties in `src/styles/theme.css` (`--color-bg`, `--color-gold`, etc., as `R G B` triplets). `tailwind.config.js` maps them to `brand.*` Tailwind colors (`bg-brand-gold`, `text-brand-text-muted`, ...). Components must use these `brand-*` classes — never hardcode hex colors. To re-theme the whole site, edit `theme.css` only.

### Data-driven catalog (no hardcoded product/category info in components)

- `src/data/categories.ts` — the single source for site navigation. `Header`, `DesktopNavigation`, `MobileNavigation`, and `Footer` all render from this array; adding a category/subcategory here requires no component changes.
- `src/data/products.ts` — the single source for products, plus helpers `getProductsByCategory(slug)` and `getPopularProducts()`.
- Convention linking the two: `Category.slug` matches `Product.category`. `Subcategory.slug` matches `Product.brand.toLowerCase().replace(/\s+/g, "-")` (e.g. brand `"Golden Virginia"` → slug `"golden-virginia"`). `CategorySection.tsx` uses this to group products by brand and to generate anchor ids — keep it in mind when adding a product for an existing subcategory.

### Navigation is scroll-anchors, not a router

There's no router; it's a single page (`HomePage.tsx`). Category/subcategory links are `href="#slug"` / `href="#slug-subSlug"` hashes pointing at section ids rendered by `CategorySection.tsx` (per category) and the `id="popular"`/`id="categories"` sections in `HomePage.tsx`.

### Cart state

`src/context/CartContext.tsx` (`CartProvider`/`useCart`) holds cart line items and derives `lines` (joined with live product data), `totalCount`, `totalPrice`. Persistence goes through the generic `src/hooks/useLocalStorage.ts` hook under key `balagan_cart`. The same hook backs the age-gate flag (`balagan_age_verified` in `AgeGate.tsx`).

### Shared UI primitives

- `components/ui/Button.tsx` — the only place button variant styling (`primary`/`secondary`/`outline`/`ghost`) is defined.
- `components/ui/Drawer.tsx` — shared slide-in panel (backdrop, Escape-to-close, scroll lock, transform-based slide) used by both `CartDrawer.tsx` and `MobileNavigation.tsx`. Extend this rather than building a second drawer implementation.

### Known gotcha: off-canvas panels and horizontal scroll

`Drawer.tsx` hides panels via `-translate-x-full`/`translate-x-full` while keeping them in the DOM. Chrome still counts a translated-off-screen fixed/absolute element toward `document.documentElement.scrollWidth`, which silently adds a phantom horizontal scrollbar. This is why `src/index.css` sets `overflow-x: hidden` on `html, body` — don't remove it, and apply the same fix if you add another off-canvas element.

### Path alias

`@/` resolves to `src/` (configured in both `vite.config.ts` and `tsconfig.app.json`).

### Assets

- `/public/images/logo.jpeg` is the real business logo — never regenerate/replace it in code.
- `/public/images/products/placeholder.svg` is the stand-in image for all mock products until real product photos exist.
