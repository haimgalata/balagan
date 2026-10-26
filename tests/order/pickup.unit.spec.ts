import { test, expect } from "@playwright/test";
import {
  addressLine,
  advanceAction,
  backAction,
  canCancel,
  cancelHoldsStock,
  cancelReasons,
  statusLabel,
} from "../../src/admin/orders/orderModel";
import { getOrderingRules, CARD_PAYMENTS_READY } from "../../src/storefront/lib/fulfillment";
import { parseRpcBusinessSettings, type RpcBusinessSettings } from "../../src/storefront/lib/businessSettingsApi";
import { fallbackBusinessSettings } from "../../src/storefront/data/fallbackBusinessSettings";
import { isOrderPathname, orderIdFromPathname, orderPath } from "../../src/order/orderRoute";
import { customerStatusLabel, isOpenOrderStatus } from "../../src/order/orderStatusText";
import { parseLastOrder, readLastOrder, saveLastOrder, forgetLastOrder, LAST_ORDER_KEY } from "../../src/order/lastOrder";
import { parsePublicOrderStatus } from "../../src/order/orderStatusApi";

const ID = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

test.describe("the board's pickup lifecycle (mirrors transition_order, migration 0015)", () => {
  test("pickup: new -> preparing -> ready for pickup -> collected", () => {
    expect(advanceAction("confirmed", "pickup")?.to).toBe("preparing");
    expect(advanceAction("preparing", "pickup")).toEqual({ to: "ready_for_pickup", label: "מוכנה לאיסוף" });
    expect(advanceAction("ready_for_pickup", "pickup")).toEqual({ to: "completed", label: "נאספה" });
    expect(advanceAction("out_for_delivery", "pickup")).toBeNull();
  });
  test("delivery is unchanged and never offers ready_for_pickup", () => {
    expect(advanceAction("preparing")?.to).toBe("out_for_delivery");
    expect(advanceAction("preparing", "delivery")?.to).toBe("out_for_delivery");
    expect(advanceAction("ready_for_pickup", "delivery")).toBeNull();
  });
  test("one step back, and the owner reopens to the method's own last step", () => {
    expect(backAction("ready_for_pickup", "staff", "pickup")?.to).toBe("preparing");
    expect(backAction("ready_for_pickup", "staff", "delivery")).toBeNull();
    expect(backAction("completed", "staff", "pickup")).toBeNull();
    expect(backAction("completed", "owner", "pickup")?.to).toBe("ready_for_pickup");
    expect(backAction("completed", "owner", "delivery")?.to).toBe("out_for_delivery");
  });
  test("a ready order can be cancelled and its stock comes back at once", () => {
    expect(canCancel("ready_for_pickup")).toBe(true);
    expect(cancelHoldsStock("ready_for_pickup")).toBe(false);
    expect(cancelReasons("pickup")).toContain("הלקוח לא הגיע לאסוף");
    expect(cancelReasons("pickup")).not.toContain("כתובת לא תקינה / מחוץ לאזור");
    expect(cancelReasons()).toContain("כתובת לא תקינה / מחוץ לאזור");
  });
  test("labels and the address line", () => {
    expect(statusLabel("ready_for_pickup")).toBe("מוכנה לאיסוף");
    expect(statusLabel("completed", "pickup")).toBe("נאספה");
    expect(statusLabel("completed", "delivery")).toBe("נמסרה");
    expect(addressLine({ fulfillment_method: "pickup", street: null, house_number: null, city: null })).toBe("איסוף עצמי מהחנות");
    expect(addressLine({ street: "הרצל", house_number: "1", city: "נתיבות" })).toBe("הרצל 1, נתיבות");
  });
});

test.describe("ordering rules the storefront derives from the public settings", () => {
  const settings = (over: Partial<RpcBusinessSettings> = {}): RpcBusinessSettings => ({ ...fallbackBusinessSettings, ...over });

  test("settings from before migration 0015 mean delivery + cash, as before", () => {
    const rules = getOrderingRules(settings());
    expect(rules).toMatchObject({ fulfillment: "delivery", deliveryFeeCents: 1500, minOrderCents: 5000, cashEnabled: true, cardEnabled: false, storeAddress: null });
  });
  test("pickup: no delivery fee, no minimum, the store address", () => {
    const rules = getOrderingRules(settings({ pickup_enabled: true, delivery_enabled: false, store_address_text: "  הרצל 1, נתיבות " }));
    expect(rules).toMatchObject({ fulfillment: "pickup", deliveryFeeCents: 0, minOrderCents: 0, storeAddress: "הרצל 1, נתיבות" });
  });
  test("card is offered only when a provider is wired in this build AND the owner switched it on", () => {
    expect(getOrderingRules(settings({ card_enabled: true })).cardEnabled).toBe(CARD_PAYMENTS_READY);
    expect(getOrderingRules(settings({ card_enabled: false })).cardEnabled).toBe(false);
    expect(getOrderingRules(settings({ cash_enabled: false })).cashEnabled).toBe(false);
  });
  test("the settings parser accepts the new fields and refuses wrong types", () => {
    const base = { ...fallbackBusinessSettings };
    expect(parseRpcBusinessSettings({ ...base, pickup_enabled: true, store_address_text: "x" })).not.toBeNull();
    expect(parseRpcBusinessSettings(base)).not.toBeNull();
    expect(parseRpcBusinessSettings({ ...base, pickup_enabled: "yes" })).toBeNull();
    expect(parseRpcBusinessSettings({ ...base, store_address_text: 5 })).toBeNull();
  });
});

test.describe("the order-tracking page", () => {
  test("/order/<uuid> only", () => {
    expect(isOrderPathname("/order")).toBe(true);
    expect(isOrderPathname(`/order/${ID}`)).toBe(true);
    expect(isOrderPathname("/orders")).toBe(false);
    expect(orderIdFromPathname(`/order/${ID}`)).toBe(ID);
    expect(orderIdFromPathname(`/order/${ID.toUpperCase()}/`)).toBe(ID);
    expect(orderIdFromPathname("/order/1042")).toBeNull();
    expect(orderIdFromPathname(`/order/${ID}/x`)).toBeNull();
    expect(orderPath(ID)).toBe(`/order/${ID}`);
  });
  test("customer wording", () => {
    expect(customerStatusLabel("ready_for_pickup", "pickup")).toBe("מוכנה לאיסוף");
    expect(customerStatusLabel("completed", "pickup")).toBe("נאספה");
    expect(customerStatusLabel("completed")).toBe("נמסרה");
    expect(customerStatusLabel("whatever")).toBe("בטיפול");
    expect(isOpenOrderStatus("ready_for_pickup")).toBe(true);
    expect(isOpenOrderStatus("completed")).toBe(false);
    expect(isOpenOrderStatus("cancelled")).toBe(false);
  });
  test("the status response is checked, and carries no personal data through", () => {
    const ok = parsePublicOrderStatus({ order_number: 7, order_status: "preparing", payment_status: "pending", payment_method: "cash", fulfillment_method: "pickup", total_cents: 900, phone: "x" });
    expect(ok).toEqual({ orderNumber: 7, orderStatus: "preparing", paymentStatus: "pending", paymentMethod: "cash", fulfillmentMethod: "pickup", totalCents: 900, deliveryDepartureTime: null });
    expect(parsePublicOrderStatus({ order_number: "7" })).toBeNull();
    expect(parsePublicOrderStatus(null)).toBeNull();
  });
});

test.describe("the last order remembered on this device", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data };
  };
  const now = Date.parse("2026-10-07T12:00:00Z");

  test("round-trips, expires after 3 days, and is forgotten on demand", () => {
    const s = memory();
    saveLastOrder({ id: ID, number: 1042, placedAt: now }, s);
    expect(readLastOrder(s, now + 60_000)).toEqual({ id: ID, number: 1042, placedAt: now });
    expect(readLastOrder(s, now + 3 * 24 * 3600_000 + 1)).toBeNull();
    forgetLastOrder(s);
    expect(s.data.has(LAST_ORDER_KEY)).toBe(false);
  });
  test("trusts nothing from storage", () => {
    expect(parseLastOrder("not json", now)).toBeNull();
    expect(parseLastOrder(JSON.stringify({ id: "1042", number: 1042, placedAt: now }), now)).toBeNull();
    expect(parseLastOrder(JSON.stringify({ id: ID, number: "1", placedAt: now }), now)).toBeNull();
    expect(readLastOrder({ getItem: () => { throw new Error("blocked"); }, setItem: () => undefined, removeItem: () => undefined }, now)).toBeNull();
  });
});
