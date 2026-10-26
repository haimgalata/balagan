import { test, expect, buildRpcCatalog, RPC_URL, rpcOk, STOCK_RPC_URL, stockOk } from "../catalog/fixtures";
import type { Page, Route } from "@playwright/test";

/**
 * Delivery windows (migration 0017) as the customer sees them: the picker in checkout, what create_order() receives,
 * the refusals the database can answer with, and the order-tracking page. All database calls are stubbed — the rules
 * themselves (cut-off, "N hours ahead", capacity) are verified on Postgres by scripts/verify-order-management.mjs.
 */
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
const SETTINGS_URL = "**/rest/v1/rpc/get_business_settings";
const SLOTS_URL = "**/rest/v1/rpc/get_delivery_slots";
const CREATE_ORDER_URL = "**/rest/v1/rpc/create_order";
const ORDER_STATUS_URL = "**/rest/v1/rpc/get_order_status";
const ORDER_ID = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

const reply = (body: unknown, status = 200) => async (route: Route) => {
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
  await route.fulfill({ status, headers: CORS, contentType: "application/json", body: JSON.stringify(body) });
};

const week = Array.from({ length: 7 }, (_, day) => ({ day_of_week: day, is_open: true, open_time: "08:00:00", close_time: "23:00:00" }));
const settings = (over: Record<string, unknown> = {}) => ({
  store_hours: week,
  order_hours: week,
  min_order_cents: 5000,
  delivery_fee_cents: 1500,
  orders_paused: false,
  club_offer_text: null,
  pickup_enabled: false,
  delivery_enabled: true,
  cash_enabled: true,
  card_enabled: false,
  store_address_text: null,
  delivery_advance_hours: 4,
  delivery_windows: [
    { id: "w-13", departure_time: "13:00:00", order_cutoff_time: "12:00:00" },
    { id: "w-18", departure_time: "18:00:00", order_cutoff_time: "17:00:00" },
    { id: "w-21", departure_time: "21:00:00", order_cutoff_time: "20:00:00" },
  ],
  ...over,
});
const slots = (...available: [string, string, boolean][]) => available.map(([id, departure_time, ok]) => ({ id, departure_time, available: ok }));

const CART = JSON.stringify([{ productId: "1", option: "package", quantity: 1 }]);
const CREATED = { order_id: ORDER_ID, order_number: 1042, order_status: "confirmed", payment_status: "pending", payment_method: "cash", fulfillment_method: "delivery", total_cents: 51500, discount_cents: 0, payment_attempt_id: null };

async function setup(page: Page, opts: { settings?: unknown; slots?: unknown } = {}) {
  await page.route(RPC_URL, rpcOk(buildRpcCatalog()));
  await page.route(STOCK_RPC_URL, stockOk());
  await page.route(SETTINGS_URL, reply(opts.settings ?? settings()));
  await page.route(SLOTS_URL, reply(opts.slots ?? slots(["w-13", "13:00:00", false], ["w-18", "18:00:00", true], ["w-21", "21:00:00", true])));
  await page.addInitScript((cart) => localStorage.setItem("balagan_cart_v2", cart), CART);
}

async function fillDetails(page: Page) {
  await page.getByRole("textbox", { name: "שם פרטי" }).fill("ישראל");
  await page.getByRole("textbox", { name: "שם משפחה" }).fill("ישראלי");
  await page.getByRole("textbox", { name: "טלפון" }).fill("0501234567");
  await page.getByRole("combobox", { name: "רחוב" }).fill("הרצל");
  await page.getByRole("textbox", { name: "מספר בית" }).fill("12");
  await page.getByRole("checkbox", { name: /מקבל\/ת המשלוח הינו\/ה בן\/בת 18/ }).check();
  await page.getByRole("checkbox", { name: /תקנון האתר/ }).check();
}

test.describe("delivery windows at checkout", () => {
  test.beforeEach(({ mode }) => {
    test.skip(mode !== "supabase", "needs the database-backed variant (settings + create_order)");
  });

  test("the picker lists today's windows, starts on the first open one, and the choice is sent to create_order()", async ({ page }) => {
    await setup(page);
    let payload: Record<string, unknown> | null = null;
    await page.route(CREATE_ORDER_URL, async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      payload = (route.request().postDataJSON() as { p_payload: Record<string, unknown> }).p_payload;
      await route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(CREATED) });
    });
    await page.goto("/checkout");
    const group = page.getByRole("radiogroup", { name: "חלון משלוח" });
    await expect(group.getByRole("radio")).toHaveCount(3);
    await expect(group.getByRole("radio", { name: /יציאה ב-13:00/ })).toBeDisabled(); // past its cut-off / full: shown, not selectable
    await expect(group.getByRole("radio", { name: /יציאה ב-18:00/ })).toBeChecked(); // the first open one
    await group.getByRole("radio", { name: /יציאה ב-21:00/ }).click();
    await expect(group.getByRole("radio", { name: /יציאה ב-21:00/ })).toBeChecked();

    await fillDetails(page);
    await page.getByRole("button", { name: "לסיום ההזמנה" }).click();
    await expect(page.getByRole("heading", { name: "ההזמנה התקבלה!" })).toBeVisible();
    expect(payload).toMatchObject({ fulfillment_method: "delivery", delivery_window_id: "w-21" });
  });

  test("with no window defined there is nothing to choose and nothing is sent", async ({ page }) => {
    await setup(page, { settings: settings({ delivery_windows: [], delivery_advance_hours: undefined }), slots: [] });
    let payload: Record<string, unknown> | null = null;
    await page.route(CREATE_ORDER_URL, async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      payload = (route.request().postDataJSON() as { p_payload: Record<string, unknown> }).p_payload;
      await route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(CREATED) });
    });
    await page.goto("/checkout");
    await expect(page.getByRole("heading", { name: "השלמת פרטי ההזמנה" })).toBeVisible();
    await expect(page.getByTestId("delivery-windows")).toHaveCount(0);
    await fillDetails(page);
    await page.getByRole("button", { name: "לסיום ההזמנה" }).click();
    await expect(page.getByRole("heading", { name: "ההזמנה התקבלה!" })).toBeVisible();
    expect(payload).not.toHaveProperty("delivery_window_id");
  });

  test("when every window is closed or full, the order cannot be placed", async ({ page }) => {
    await setup(page, { slots: slots(["w-13", "13:00:00", false], ["w-18", "18:00:00", false]) });
    await page.goto("/checkout");
    await expect(page.getByText("אין כרגע חלון משלוח פנוי להיום")).toBeVisible();
    await expect(page.getByRole("button", { name: "לסיום ההזמנה" })).toBeDisabled();
  });

  test("if the chosen window filled up in the meantime the customer is told, and the list is refreshed", async ({ page }) => {
    await setup(page);
    await page.route(CREATE_ORDER_URL, reply({ message: "WINDOW_FULL" }, 400));
    await page.goto("/checkout");
    await fillDetails(page);
    // by the time the customer submits, 18:00 has filled up
    await page.unroute(SLOTS_URL);
    await page.route(SLOTS_URL, reply(slots(["w-13", "13:00:00", false], ["w-18", "18:00:00", false], ["w-21", "21:00:00", true])));
    await page.getByRole("button", { name: "לסיום ההזמנה" }).click();
    await expect(page.getByText("חלון המשלוח שנבחר התמלא")).toBeVisible();
    const group = page.getByRole("radiogroup", { name: "חלון משלוח" });
    await expect(group.getByRole("radio", { name: /יציאה ב-18:00/ })).toBeDisabled();
    await expect(group.getByRole("radio", { name: /יציאה ב-21:00/ })).toBeEnabled();
  });

  test("known windows but the list cannot be loaded: checkout does not guess", async ({ page }) => {
    await setup(page);
    await page.unroute(SLOTS_URL);
    await page.route(SLOTS_URL, reply({ message: "boom" }, 500));
    await page.goto("/checkout");
    await expect(page.getByRole("heading", { name: "לא ניתן לטעון את חלונות המשלוח כרגע" })).toBeVisible();
    await expect(page.getByRole("button", { name: "לסיום ההזמנה" })).toHaveCount(0);
  });

  test("pickup never asks for a window", async ({ page }) => {
    await setup(page, { settings: settings({ pickup_enabled: true, delivery_enabled: false, store_address_text: "הרצל 1, נתיבות" }) });
    await page.goto("/checkout");
    await expect(page.getByRole("region", { name: "איסוף עצמי" })).toBeVisible();
    await expect(page.getByTestId("delivery-windows")).toHaveCount(0);
  });
});

test.describe("the order page for a windowed delivery", () => {
  test.beforeEach(({ mode }) => {
    test.skip(mode !== "supabase", "needs the database-backed variant");
  });

  const status = (over: Record<string, unknown>) => ({
    order_number: 1042, order_status: "preparing", payment_status: "paid", payment_method: "card", fulfillment_method: "delivery", total_cents: 51500,
    delivery_departure_time: "18:00:00", ...over,
  });

  test("shows when the delivery leaves and the extra step while it waits for the courier", async ({ page }) => {
    await setup(page);
    await page.route(ORDER_STATUS_URL, reply(status({ order_status: "ready_for_dispatch" })));
    await page.goto(`/order/${ORDER_ID}`);
    await expect(page.getByTestId("delivery-departure")).toContainText("משלוח יוצא ב-18:00");
    await expect(page.getByRole("list", { name: "שלבי ההזמנה" }).getByRole("listitem")).toHaveCount(5);
    await expect(page.getByRole("list", { name: "שלבי ההזמנה" }).getByRole("listitem").nth(2)).toHaveAttribute("aria-current", "step");
  });

  test("an order with no window keeps the four steps and shows no departure line", async ({ page }) => {
    await setup(page);
    await page.route(ORDER_STATUS_URL, reply(status({ delivery_departure_time: null })));
    await page.goto(`/order/${ORDER_ID}`);
    await expect(page.getByRole("list", { name: "שלבי ההזמנה" }).getByRole("listitem")).toHaveCount(4);
    await expect(page.getByTestId("delivery-departure")).toHaveCount(0);
  });

  test("a delivery that could not be handed over says so and offers the store's phone", async ({ page }) => {
    await setup(page);
    await page.route(ORDER_STATUS_URL, reply(status({ order_status: "delivery_failed" })));
    await page.goto(`/order/${ORDER_ID}`);
    await expect(page.getByRole("alert")).toContainText("המשלוח לא נמסר");
    await expect(page.getByRole("list", { name: "שלבי ההזמנה" })).toHaveCount(0);
  });
});
