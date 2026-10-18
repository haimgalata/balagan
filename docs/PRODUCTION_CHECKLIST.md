# Before production: development-only behaviour that must not ship

Run `npm run build && npm run check:prod` before every deploy. It fails if a development login is switched on in the
environment or `.env`/`.env.production*`, or if the build contains a dev-only marker. The rest below is by hand.

## Switched off by construction (verify, don't rebuild)
| Dev-only thing | Where | Why it can't reach production | What you do |
|---|---|---|---|
| **Real-database test login** (`VITE_CUSTOMER_AUTH=realtest`): one test member signs in with e-mail + password | `src/account/auth/testMemberAuth.ts`, `devHost.ts`, `LoginPanel.tsx` (password box), `scripts/dev-club-real.mjs` | `__CUSTOMER_AUTH__` is a compile-time constant, so it is absent from every normal build; `vite build` refuses `realtest`; the dev server refuses it unless `npm run dev:club:real` set `BALAGAN_DEV_REAL=1`; marker `BALAGAN_DEV_ONLY_REALTEST` is asserted absent by `tests/admin/auth/bundle.unit.spec.ts` and `check:prod` | Never set `VITE_CUSTOMER_AUTH` or `VITE_TEST_MEMBER_EMAIL` in a host's build settings. When a real SMS/OTP adapter exists, delete `testMemberAuth.ts`, `devHost.ts`, the `realtest` branch in `loadCustomerAuth.ts`/`vite.config.ts`/`vite-env.d.ts`/`LoginPanel.tsx`, and `dev-club-real.mjs` |
| **LAN access / private-IP allowance / password over plain http** | `dev-club-real.mjs` (`--host 0.0.0.0`), `devHost.ts` | only the dev server started by that script listens on the network; the private-network hostnames are accepted only inside the `realtest` adapter | Use trusted Wi-Fi only; nothing to change for production, delete with the adapter |
| **Mock login** (`VITE_CUSTOMER_AUTH=mock`, code 123456) and the **dev stub** | `src/account/auth/mockAuth.ts`, `scripts/dev-club.mjs`, `scripts/dev-club-stub.mjs`, the `account` Playwright variant | absent from normal builds (bundle test checks the token prefix) | Never set `VITE_CUSTOMER_AUTH=mock` for a real deploy |

## By hand
- [ ] **Real customer login:** the club is OFF in production (`VITE_CUSTOMER_AUTH` unset) until a real SMS/OTP adapter is built and `docs/CUSTOMER_PERMISSIONS_AUDIT.md` ("Remaining before sign-ups are enabled") is done — including SMS rate-limit/captcha, terms + privacy pages and legal sign-off on the consent wording. Coupons are redeemable only through that login.
- [ ] **Supabase public sign-ups:** still OFF until then (`node scripts/security-test.mjs --check-signup` must pass); switch on only with the real adapter, then run `--signups-enabled`.
- [ ] **Test accounts:** `zz-member-probe@example.test` (a verified phone set by SQL) and `zz-user-probe@example.test` exist in the real project. Delete them (Authentication → Users) and their leftover test orders/rows, or at least reset their passwords, before real customers use the system.
- [ ] **Credentials:** `.env.local` holds plaintext admin/staff/test passwords and pasted PowerShell `$env:` lines. Rotate the admin and staff passwords, remove them from the file, and never put them in a file a host can read. The `service_role` key must not exist anywhere in the project.
- [ ] **Host build settings:** only `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and (optionally) `VITE_CATALOG_SOURCE`. No other `VITE_*`.
- [ ] **SPA fallback** configured on the host (see `CLAUDE.md`), so `/admin`, `/checkout` and `/account` work on refresh.
- [ ] **MFA for the owner** (still deferred, see `CLAUDE.md`) before the site goes live to real customers.
- [ ] **Migrations applied in order** (`supabase/README.md`), `0014_coupons.sql` before any client that sends a coupon, `0015_pickup.sql` before any client/admin build from the pickup version, `0016_costs.sql` before an admin build with the costs/scan screens (and before the POS catalog import).
- [ ] **Ordering setup** in `/admin/settings`: the online-order hours are right (the database now refuses orders outside them), "איסוף עצמי מהחנות" chosen with the store address typed, payment methods as decided.
- [ ] **Supplier invoices and the POS export stay out of git** (the repository is public): `seed-data/catalogs (20).xlsx`, invoice photos, `seed-data/pos-import/invoice-costs-*.sql` / `*-review.xlsx` contain purchase costs.
- [ ] **Card payments** (not built yet): payment provider account (confirm it accepts a tobacco merchant), its keys only in Supabase secrets, the payment Edge Functions + signature-verified webhook, the expiry sweep scheduled, `CARD_PAYMENTS_READY` in `src/storefront/lib/fulfillment.ts` turned on, end-to-end test in the provider's sandbox — then `card_enabled` in settings.
