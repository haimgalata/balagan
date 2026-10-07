/**
 * What a CUSTOMER reads for each order status — shared by the order-tracking page, the homepage's "your order" strip
 * and the club member's order list, so the three never word the same state differently. Pure, imports nothing.
 * (The store's own board has its own staff wording in src/admin/orders/orderModel.ts.)
 */
export type CustomerFulfillment = "delivery" | "pickup";

const COMMON: Record<string, string> = {
  pending: "ממתינה לתשלום",
  confirmed: "התקבלה",
  preparing: "בהכנה",
  cancelled: "בוטלה",
  expired: "פגה",
};

export function customerStatusLabel(status: string, fulfillment: CustomerFulfillment = "delivery"): string {
  if (status === "ready_for_pickup") return "מוכנה לאיסוף";
  if (status === "out_for_delivery") return "בדרך אליכם";
  if (status === "completed") return fulfillment === "pickup" ? "נאספה" : "נמסרה";
  return COMMON[status] ?? "בטיפול";
}

/** Still moving through the store (worth checking again) — as opposed to finished or dead. */
export function isOpenOrderStatus(status: string): boolean {
  return status === "pending" || status === "confirmed" || status === "preparing" || status === "out_for_delivery" || status === "ready_for_pickup";
}
