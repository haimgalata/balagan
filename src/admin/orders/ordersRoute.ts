/** Pure path handling for the orders area (no React / Supabase — unit-tested). */
import { ADMIN_ROOT } from "@/admin/adminRoute";

export const ORDERS_PATH = `${ADMIN_ROOT}/orders`;
export const ORDERS_HISTORY_PATH = `${ORDERS_PATH}/history`;

export type OrdersRoute = { view: "board" } | { view: "history" } | { view: "order"; number: number } | { view: "none" };

/** Already-normalized admin path (lower-case, no trailing slash) -> which orders screen, or "none". */
export function parseOrdersPath(path: string): OrdersRoute {
  if (path === ORDERS_PATH) return { view: "board" };
  if (path === ORDERS_HISTORY_PATH) return { view: "history" };
  const match = new RegExp(`^${ORDERS_PATH}/(\\d{1,9})$`).exec(path);
  if (match) return { view: "order", number: Number(match[1]) };
  return { view: "none" };
}

export const isOrdersPath = (path: string): boolean => parseOrdersPath(path).view !== "none";
