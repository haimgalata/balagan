/**
 * Real, static delivery/minimum-order figures — shared by `BusinessInfoBar`
 * (the sticky info strip) and `CartDrawer`'s footer, so they never drift
 * out of sync. Not interactive: there's no real delivery flow yet (see
 * `CLAUDE.md`), this is informational only.
 */
export const MINIMUM_ORDER = 50;
export const DELIVERY_FEE = 15;
