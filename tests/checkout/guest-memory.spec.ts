import { test, expect, buildRpcCatalog, RPC_URL, rpcOk, STOCK_RPC_URL, stockOk, readLocalStorage } from "../catalog/fixtures";
import type { Route } from "@playwright/test";

/**
 * Decision: a guest's details are remembered on the SAME device/browser (never anywhere else) so a repeat order
 * isn't retyped. Runs on the normal "supabase" build — i.e. with the club login OFF, as production is today — which
 * also proves that build shows no club UI at all.
 */
const CREATE_ORDER_URL = "**/rest/v1/rpc/create_order";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "*" };
const CART = JSON.stringify([{ productId: "1", option: "package", quantity: 1 }]);
const GUEST_KEY = "balagan_guest_details_v1";

test.beforeEach(({ mode }) => {
  test.skip(mode !== "supabase", "create_order only exists in the database-backed variant");
});

async function setup(page: import("@playwright/test").Page) {
  await page.route(RPC_URL, rpcOk(buildRpcCatalog()));
  await page.route(STOCK_RPC_URL, stockOk());
  await page.route(CREATE_ORDER_URL, async (route: Route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    await route.fulfill({
      status: 200, headers: CORS, contentType: "application/json",
      body: JSON.stringify({ order_id: "44444444-4444-4444-8444-444444444444", order_number: 9, order_status: "confirmed", payment_status: "pending", payment_method: "cash", total_cents: 51500, payment_attempt_id: null }),
    });
  });
  await page.addInitScript((cart) => {
    // only seed once: a later navigation in the same test must see what the first order saved
    if (localStorage.getItem("balagan_age_verified") === null) {
      localStorage.setItem("balagan_age_verified", "true");
    }
    localStorage.setItem("balagan_cart_v2", cart);
  }, CART);
}

test("after an order the details are remembered; the next checkout starts filled in, and they can be forgotten", async ({ page }) => {
  await setup(page);
  await page.goto("/checkout");
  await expect(page.getByRole("heading", { name: "השלמת פרטי ההזמנה" })).toBeVisible();
  // production build: no club UI, only the plain note about this device
  await expect(page.getByText("חברי מועדון בלאגן")).toHaveCount(0);
  await expect(page.getByText("הפרטים יישמרו במכשיר הזה בלבד")).toBeVisible();
  await expect(page.getByRole("button", { name: "מחיקת הפרטים השמורים" })).toHaveCount(0); // nothing saved yet

  await page.getByRole("textbox", { name: "שם פרטי" }).fill("ישראל");
  await page.getByRole("textbox", { name: "שם משפחה" }).fill("ישראלי");
  await page.getByRole("textbox", { name: "טלפון" }).fill("0501234567");
  await page.getByRole("combobox", { name: "רחוב" }).fill("הרצל");
  await page.getByRole("textbox", { name: "מספר בית" }).fill("12");
  await page.getByRole("textbox", { name: "דירה" }).fill("3");
  await page.getByRole("checkbox", { name: /מקבל\/ת המשלוח הינו\/ה בן\/בת 18/ }).check();
  await page.getByRole("checkbox", { name: /תקנון האתר/ }).check();
  await page.getByRole("button", { name: "לסיום ההזמנה" }).click();
  await expect(page.getByRole("heading", { name: "ההזמנה התקבלה!" })).toBeVisible();

  // saved locally — and ONLY the delivery details: no confirmations, no payment choice
  const stored = JSON.parse((await readLocalStorage(page, GUEST_KEY)) ?? "null");
  expect(stored).toMatchObject({ firstName: "ישראל", lastName: "ישראלי", phone: "0501234567", street: "הרצל", houseNumber: "12", apartment: "3" });
  expect(Object.keys(stored).sort()).toEqual(
    ["apartment", "email", "entrance", "firstName", "floor", "houseNumber", "intercomCode", "lastName", "notes", "phone", "street"]
  );

  await page.goto("/checkout");
  await expect(page.getByRole("textbox", { name: "שם פרטי" })).toHaveValue("ישראל");
  await expect(page.getByRole("textbox", { name: "טלפון" })).toHaveValue("0501234567");
  await expect(page.getByRole("combobox", { name: "רחוב" })).toHaveValue("הרצל");
  await expect(page.getByRole("checkbox", { name: /מקבל\/ת המשלוח הינו\/ה בן\/בת 18/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /תקנון האתר/ })).not.toBeChecked();

  await page.getByRole("button", { name: "מחיקת הפרטים השמורים" }).click();
  await expect(page.getByRole("textbox", { name: "שם פרטי" })).toHaveValue("");
  await expect(page.getByRole("combobox", { name: "רחוב" })).toHaveValue("");
  expect(await readLocalStorage(page, GUEST_KEY)).toBeNull();
});

test("a failed order saves nothing", async ({ page }) => {
  await setup(page);
  await page.unroute(CREATE_ORDER_URL);
  await page.route(CREATE_ORDER_URL, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    await route.fulfill({ status: 400, headers: CORS, contentType: "application/json", body: JSON.stringify({ message: "INSUFFICIENT_STOCK: 1" }) });
  });
  await page.goto("/checkout");
  await page.getByRole("textbox", { name: "שם פרטי" }).fill("ישראל");
  await page.getByRole("textbox", { name: "שם משפחה" }).fill("ישראלי");
  await page.getByRole("textbox", { name: "טלפון" }).fill("0501234567");
  await page.getByRole("combobox", { name: "רחוב" }).fill("הרצל");
  await page.getByRole("textbox", { name: "מספר בית" }).fill("12");
  await page.getByRole("checkbox", { name: /מקבל\/ת המשלוח הינו\/ה בן\/בת 18/ }).check();
  await page.getByRole("checkbox", { name: /תקנון האתר/ }).check();
  await page.getByRole("button", { name: "לסיום ההזמנה" }).click();
  await expect(page.getByText("אחד או יותר מהמוצרים בסל אינו זמין")).toBeVisible();
  expect(await readLocalStorage(page, GUEST_KEY)).toBeNull();
});
