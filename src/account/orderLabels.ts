/** Pure helpers for showing a member's past orders — no React, unit-tested (tests/account/orderLabels.unit.spec.ts). */
import type { MyOrder } from "@/account/types";
import { customerStatusLabel } from "@/order/orderStatusText";

/** What the customer should read for each order status — the same wording as the order-tracking page. */
export function orderStatusLabel(status: string, fulfillment: "delivery" | "pickup" = "delivery"): string {
  return customerStatusLabel(status, fulfillment);
}

/** "active" orders are still on their way to the customer; the rest are history. Drives the chip colour. */
export function orderStatusTone(status: string): "active" | "done" | "bad" {
  if (status === "completed") return "done";
  if (status === "cancelled" || status === "expired") return "bad";
  return "active";
}

/** d.m.yyyy in ISRAEL time — never the visitor's own clock/timezone (same rule as the opening-hours code). */
export function formatOrderDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "numeric", month: "numeric", year: "numeric" }).format(date);
}

/** "2 × מארז מרלבורו, יחידה קנט" — a one-line summary of what was in an order. */
export function summarizeItems(order: MyOrder, maxNames = 3): string {
  const names = order.items.map((item) => `${item.quantity} × ${item.name}${item.option === "package" && item.optionLabel ? ` (${item.optionLabel})` : ""}`);
  if (names.length <= maxNames) return names.join(", ");
  return `${names.slice(0, maxNames).join(", ")} ועוד ${names.length - maxNames}`;
}

/** The address as one line, e.g. "הרצל 12, דירה 5" — or "איסוף עצמי מהחנות" for a pickup order. */
export function orderAddressLine(order: MyOrder): string {
  if (order.fulfillmentMethod === "pickup") return "איסוף עצמי מהחנות";
  const extras = [order.entrance && `כניסה ${order.entrance}`, order.floor && `קומה ${order.floor}`, order.apartment && `דירה ${order.apartment}`].filter(Boolean);
  return [`${order.street} ${order.houseNumber}`.trim(), ...extras].join(", ");
}
