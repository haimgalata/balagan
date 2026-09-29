import { test, expect, buildRpcCatalog, RPC_URL, rpcOk, STOCK_RPC_URL, stockOk, V2_CART_KEY, readLocalStorage } from "../catalog/fixtures";
import type { Route } from "@playwright/test";

/**
 * The cart → checkout details flow (Task 1) is covered elsewhere. These tests cover the NEW seam: a
 * validated details form actually calling create_order() (supabase/migrations/0009_orders.sql) and
 * reaching a real order-confirmed screen — using a stubbed RPC response, the same way every other
 * "supabase" mode test stubs get_storefront_catalog()/check_stock_availability() (see ../catalog/fixtures).
 * The RPC's own logic (idempotency, atomic stock reservation, concurrency safety) is verified separately
 * against a scratch Postgres — this is purely "does the UI call it correctly and react to what it returns."
 */
const CREATE_ORDER_URL = "**/rest/v1/rpc/create_order";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };

const createOrderOk = (result: Record<string, unknown>) => async (route: Route) => {
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
  await route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(result) });
};
const createOrderError = (message: string) => async (route: Route) => {
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
  await route.fulfill({ status: 400, headers: CORS, contentType: "application/json", body: JSON.stringify({ message }) });
};

// A package of product "1" (₪500) comfortably clears the fallback ₪50 minimum order.
const CART_WITH_A_PACKAGE = JSON.stringify([{ productId: "1", option: "package", quantity: 1 }]);

async function fillDetailsAndSubmit(page: import("@playwright/test").Page) {
  await page.getByRole("textbox", { name: "שם פרטי" }).fill("ישראל");
  await page.getByRole("textbox", { name: "שם משפחה" }).fill("ישראלי");
  await page.getByRole("textbox", { name: "טלפון" }).fill("0501234567");
  await page.getByRole("combobox", { name: "רחוב" }).fill("הרצל");
  await page.getByRole("textbox", { name: "מספר בית" }).fill("12");
  await page.getByRole("checkbox", { name: /מקבל\/ת המשלוח הינו\/ה בן\/בת 18/ }).check();
  await page.getByRole("checkbox", { name: /תקנון האתר/ }).check();
  await page.getByRole("button", { name: "לסיום ההזמנה" }).click();
}

test.describe("checkout → create_order()", () => {
  test.beforeEach(({ mode }) => {
    test.skip(mode !== "supabase", "create_order only exists in the database-backed variant");
  });

  test("a cash order is created, the customer sees a real order number, and the cart is cleared", async ({ page }) => {
    await page.route(RPC_URL, rpcOk(buildRpcCatalog()));
    await page.route(STOCK_RPC_URL, stockOk());
    await page.route(
      CREATE_ORDER_URL,
      createOrderOk({
        order_id: "11111111-1111-4111-8111-111111111111",
        order_number: 1042,
        order_status: "confirmed",
        payment_status: "pending",
        payment_method: "cash",
        total_cents: 51500,
        payment_attempt_id: null,
      })
    );
    await page.addInitScript((cart) => localStorage.setItem("balagan_cart_v2", cart), CART_WITH_A_PACKAGE);
    await page.addInitScript(() => localStorage.setItem("balagan_age_verified", "true"));

    await page.goto("/checkout");
    await expect(page.getByRole("heading", { name: "השלמת פרטי ההזמנה" })).toBeVisible();

    await fillDetailsAndSubmit(page);

    await expect(page.getByRole("heading", { name: "ההזמנה התקבלה!" })).toBeVisible();
    await expect(page.getByText("#1042")).toBeVisible();
    await expect(page.getByText(/מזומן במעמד המסירה/)).toBeVisible();

    // the cart is really emptied — not just visually hidden behind the success panel
    expect(await readLocalStorage(page, V2_CART_KEY)).toBe("[]");
  });

  test("a server-side rejection (e.g. stock ran out) shows a Hebrew message and keeps the customer on the form", async ({ page }) => {
    await page.route(RPC_URL, rpcOk(buildRpcCatalog()));
    await page.route(STOCK_RPC_URL, stockOk());
    await page.route(CREATE_ORDER_URL, createOrderError("INSUFFICIENT_STOCK: 1"));
    await page.addInitScript((cart) => localStorage.setItem("balagan_cart_v2", cart), CART_WITH_A_PACKAGE);
    await page.addInitScript(() => localStorage.setItem("balagan_age_verified", "true"));

    await page.goto("/checkout");
    await expect(page.getByRole("heading", { name: "השלמת פרטי ההזמנה" })).toBeVisible();

    await fillDetailsAndSubmit(page);

    await expect(page.getByText("אחד או יותר מהמוצרים בסל אינו זמין יותר בכמות המבוקשת")).toBeVisible();
    // no success screen, no cart wipe — the customer can adjust the cart and try again
    await expect(page.getByRole("heading", { name: "השלמת פרטי ההזמנה" })).toBeVisible();
    expect(await readLocalStorage(page, V2_CART_KEY)).toBe(CART_WITH_A_PACKAGE);
  });

  test("submitting sends the idempotency key, and a retry after success is impossible (no second click needed to prove it — key is cleared)", async ({ page }) => {
    await page.route(RPC_URL, rpcOk(buildRpcCatalog()));
    await page.route(STOCK_RPC_URL, stockOk());
    let capturedBody: Record<string, unknown> | null = null;
    await page.route(CREATE_ORDER_URL, async (route) => {
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      capturedBody = JSON.parse(route.request().postData() ?? "{}");
      await route.fulfill({
        status: 200,
        headers: CORS,
        contentType: "application/json",
        body: JSON.stringify({
          order_id: "22222222-2222-4222-8222-222222222222",
          order_number: 7,
          order_status: "confirmed",
          payment_status: "pending",
          payment_method: "cash",
          total_cents: 51500,
          payment_attempt_id: null,
        }),
      });
    });
    await page.addInitScript((cart) => localStorage.setItem("balagan_cart_v2", cart), CART_WITH_A_PACKAGE);
    await page.addInitScript(() => localStorage.setItem("balagan_age_verified", "true"));

    await page.goto("/checkout");
    await fillDetailsAndSubmit(page);
    await expect(page.getByRole("heading", { name: "ההזמנה התקבלה!" })).toBeVisible();

    expect(capturedBody).not.toBeNull();
    expect(typeof capturedBody!.p_idempotency_key).toBe("string");
    expect((capturedBody!.p_idempotency_key as string).length).toBeGreaterThan(10);
    // cleared after success — a later, separate order would get a fresh key, never silently reuse this one
    expect(await page.evaluate(() => sessionStorage.getItem("balagan_checkout_idempotency_key"))).toBeNull();
  });
});
