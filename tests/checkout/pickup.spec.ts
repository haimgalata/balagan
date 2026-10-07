import { test, expect, buildRpcCatalog, RPC_URL, rpcOk, STOCK_RPC_URL, stockOk, readLocalStorage, openCart } from "../catalog/fixtures";
import type { Page, Route } from "@playwright/test";

/**
 * Store pickup (migration 0015) as the customer sees it: the cart and checkout without delivery fee / minimum / address,
 * the payload create_order() receives, the order-tracking page and the homepage strip, and ordering blocked while
 * orders are closed. All database calls are stubbed (the rules themselves are verified on Postgres by
 * scripts/verify-order-management.mjs).
 */
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
const SETTINGS_URL = "**/rest/v1/rpc/get_business_settings";
const CREATE_ORDER_URL = "**/rest/v1/rpc/create_order";
const ORDER_STATUS_URL = "**/rest/v1/rpc/get_order_status";
const ORDER_ID = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";

const json = (body: unknown) => async (route: Route) => {
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
  await route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(body) });
};

const week = Array.from({ length: 7 }, (_, day) => ({ day_of_week: day, is_open: true, open_time: "08:00:00", close_time: "22:00:00" }));
const pickupSettings = (over: Record<string, unknown> = {}) => ({
  store_hours: week,
  order_hours: week,
  min_order_cents: 5000,
  delivery_fee_cents: 1500,
  orders_paused: false,
  club_offer_text: null,
  pickup_enabled: true,
  delivery_enabled: false,
  cash_enabled: true,
  card_enabled: false,
  store_address_text: "הרצל 1, נתיבות",
  ...over,
});

// product "1" as a single unit is ₪50 at most — under the ₪50 delivery minimum is irrelevant for pickup either way
const ONE_UNIT = JSON.stringify([{ productId: "1", option: "unit", quantity: 1 }]);

async function setup(page: Page, settings = pickupSettings()) {
  await page.route(RPC_URL, rpcOk(buildRpcCatalog()));
  await page.route(STOCK_RPC_URL, stockOk());
  await page.route(SETTINGS_URL, json(settings));
  await page.addInitScript((cart) => localStorage.setItem("balagan_cart_v2", cart), ONE_UNIT);
}

test.describe("store pickup", () => {
  test.beforeEach(({ mode }) => {
    test.skip(mode !== "supabase", "needs the database-backed variant (settings + create_order)");
  });

  test("cart and info bar: pickup, no delivery line, no minimum", async ({ page }) => {
    await setup(page, pickupSettings({ min_order_cents: 999_999 }));
    await page.goto("/");
    await expect(page.getByText("איסוף עצמי מהחנות").first()).toBeVisible();
    const drawer = await openCart(page);
    await expect(drawer.getByTestId("order-totals")).toBeVisible();
    await expect(drawer.getByTestId("delivery-line")).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "מעבר לתשלום" })).toBeEnabled();
  });

  test("checkout sends a pickup order without an address, then links to the tracking page", async ({ page }) => {
    await setup(page);
    let payload: Record<string, unknown> | null = null;
    await page.route(CREATE_ORDER_URL, async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      payload = (route.request().postDataJSON() as { p_payload: Record<string, unknown> }).p_payload;
      await route.fulfill({
        status: 200, headers: CORS, contentType: "application/json",
        body: JSON.stringify({ order_id: ORDER_ID, order_number: 1042, order_status: "confirmed", payment_status: "pending", payment_method: "cash", fulfillment_method: "pickup", total_cents: 4490, discount_cents: 0, payment_attempt_id: null }),
      });
    });

    await page.goto("/checkout");
    await expect(page.getByRole("heading", { name: "השלמת פרטי ההזמנה" })).toBeVisible();
    await expect(page.getByRole("region", { name: "איסוף עצמי" })).toContainText("הרצל 1, נתיבות");
    await expect(page.getByRole("combobox", { name: "רחוב" })).toHaveCount(0);
    await expect(page.getByTestId("delivery-line")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "מזומן באיסוף" })).toBeVisible();
    await expect(page.getByRole("button", { name: /כרטיס אשראי/ })).toBeDisabled();

    await page.getByRole("textbox", { name: "שם פרטי" }).fill("ישראל");
    await page.getByRole("textbox", { name: "שם משפחה" }).fill("ישראלי");
    await page.getByRole("textbox", { name: "טלפון" }).fill("0501234567");
    await page.getByRole("checkbox", { name: /מי שיאסוף\/תאסוף את ההזמנה הינו\/ה בן\/בת 18/ }).check();
    await page.getByRole("checkbox", { name: /תקנון האתר/ }).check();
    await page.getByRole("button", { name: "לסיום ההזמנה" }).click();

    await expect(page.getByRole("heading", { name: "ההזמנה התקבלה!" })).toBeVisible();
    await expect(page.getByText(/במזומן בעת האיסוף מהחנות/)).toBeVisible();
    expect(payload).toMatchObject({ fulfillment_method: "pickup", payment_method: "cash" });
    const customer = (payload as unknown as { customer: Record<string, unknown> }).customer;
    expect(customer).toMatchObject({ city: null, street: null, house_number: null });
    expect(JSON.parse((await readLocalStorage(page, "balagan_last_order_v1")) ?? "{}")).toMatchObject({ id: ORDER_ID, number: 1042 });

    await page.route(ORDER_STATUS_URL, json({ order_number: 1042, order_status: "ready_for_pickup", payment_status: "pending", payment_method: "cash", fulfillment_method: "pickup", total_cents: 4490 }));
    await page.getByRole("button", { name: /מעקב/ }).click();
    await expect(page).toHaveURL(new RegExp(`/order/${ORDER_ID}$`));
    await expect(page.getByRole("heading", { name: "הזמנה #1042" })).toBeVisible();
    await expect(page.getByTestId("pickup-card")).toContainText("ההזמנה מוכנה — אפשר לבוא לאסוף!");
    await expect(page.getByTestId("pickup-card")).toContainText("הרצל 1, נתיבות");
  });

  test("the homepage shows a strip for an open order and drops it once the order is collected", async ({ page }) => {
    await setup(page);
    await page.addInitScript(
      (id) => localStorage.setItem("balagan_last_order_v1", JSON.stringify({ id, number: 1042, placedAt: Date.now() })),
      ORDER_ID
    );
    let status = "ready_for_pickup";
    await page.route(ORDER_STATUS_URL, async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      await route.fulfill({ status: 200, headers: CORS, contentType: "application/json",
        body: JSON.stringify({ order_number: 1042, order_status: status, payment_status: "pending", payment_method: "cash", fulfillment_method: "pickup", total_cents: 4490 }) });
    });
    await page.goto("/");
    await expect(page.getByTestId("last-order-strip")).toContainText("הזמנה #1042 · מוכנה לאיסוף");
    await expect(page.getByTestId("last-order-strip")).toHaveAttribute("href", `/order/${ORDER_ID}`);

    status = "completed";
    await page.reload();
    await expect(page.getByTestId("last-order-strip")).toHaveCount(0);
    await expect.poll(() => readLocalStorage(page, "balagan_last_order_v1")).toBeNull();
  });

  test("an unknown order id shows 'not found'", async ({ page }) => {
    await setup(page);
    await page.route(ORDER_STATUS_URL, json(null));
    await page.goto(`/order/${ORDER_ID}`);
    await expect(page.getByRole("heading", { name: "ההזמנה לא נמצאה" })).toBeVisible();
  });

  test("while orders are paused the cart cannot go to checkout, and checkout cannot submit", async ({ page }) => {
    await setup(page, pickupSettings({ orders_paused: true }));
    await page.goto("/");
    const drawer = await openCart(page);
    await expect(drawer.getByRole("button", { name: "מעבר לתשלום" })).toBeDisabled();
    await expect(drawer.getByText(/ההזמנות באתר סגורות כרגע/)).toBeVisible();

    await page.goto("/checkout");
    await expect(page.getByText(/ההזמנות באתר סגורות כרגע/)).toBeVisible();
    await expect(page.getByRole("button", { name: "לסיום ההזמנה" })).toBeDisabled();
  });

  test("with no payment method switched on, the order cannot be completed", async ({ page }) => {
    await setup(page, pickupSettings({ cash_enabled: false, card_enabled: true })); // card is not wired in this build
    await page.goto("/checkout");
    await expect(page.getByText("התשלום באתר עדיין לא זמין, ולכן אי אפשר להשלים הזמנה כרגע.")).toBeVisible();
    await expect(page.getByRole("button", { name: "לסיום ההזמנה" })).toBeDisabled();
  });
});
