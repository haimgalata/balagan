/**
 * Ordering helpers for the categories screen (pure — unit-tested without a browser).
 */

/** Gap between consecutive `sort_order` values; the database's reorder functions also rewrite orders as 10, 20, 30… */
export const SORT_STEP = 10;

/**
 * The list of ids after moving `id` one place up (`-1`) or down (`+1`), or `null` when it is already at that edge
 * (or unknown). Never mutates its input.
 */
export function moveId(ids: readonly string[], id: string, direction: -1 | 1): string[] | null {
  const from = ids.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/**
 * `sort_order` for a NEW item so it lands at the END of its list. A new row must always get this explicitly:
 * the column default is 0, which would put it first.
 */
export function nextSortOrder(existingSortOrders: readonly number[]): number {
  return existingSortOrders.length === 0 ? SORT_STEP : Math.max(...existingSortOrders) + SORT_STEP;
}
