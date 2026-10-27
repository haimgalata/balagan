import { test, expect } from "../catalog/fixtures";
import { ADMIN_USER, COURIER_USER, seedSession, sessionFor, stubSupabase, type StubRequestContext, type StubUser } from "./auth/adminStubs";
import { FAKE_COURIER_NAME, FAKE_COURIER_PHONE, createFakeOrdersDatabase, makeOrder } from "./orders/fakeDatabase";
import { createFakeCustomers } from "./customers/fakeDatabase";
import { createFakeCouriers, makeDelivery } from "./couriers/fakeDatabase";
import { createFakeCoupons } from "./coupons/fakeDatabase";
import { createFakeCosts } from "./costs/fakeDatabase";
import { createFakeDatabase as createSettingsDb } from "./settings/fakeDatabase";
import { createFakeDatabase as createProductsDb } from "./products/fakeDatabase";
import { createFakeDatabase as createCategoriesDb } from "./categories/fakeDatabase";
import type { Page } from "@playwright/test";

/**
 * The admin on a phone (390px wide). `html, body` hide horizontal overflow, so a screen that is too wide for a phone does
 * not scroll — its right-hand side is simply cut off. That is exactly what hid these bugs, so this checks every visible
 * element: none may stick out of the viewport, unless it sits inside an intentional sideways scroller. It also checks the
 * menu: every section must be reachable on a phone and the current one must be in view.
 */
test.beforeEach(({ mode, vp }) => {
  test.skip(mode !== "supabase" || vp !== "mobile", "phone layout checks run only in the stubbed-database mobile variant");
});

type Handle = (context: StubRequestContext) => Promise<boolean>;

async function open(page: Page, handle: Handle, path: string, user: StubUser = ADMIN_USER) {
  await stubSupabase(page, { users: [ADMIN_USER, COURIER_USER], extra: handle });
  await seedSession(page, sessionFor(user));
  await page.goto(path);
  await expect(page.locator("main")).toBeVisible();
}

/** Visible elements whose box leaves the viewport (outside closed drawers, screen-reader-only text and intentional scrollers). */
async function overflowing(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const bad: string[] = [];
    const scrolls = (el: Element) => {
      const s = getComputedStyle(el);
      return (s.overflowX === "auto" || s.overflowX === "scroll") && el.scrollWidth > el.clientWidth;
    };
    for (const el of Array.from(document.body.querySelectorAll("*"))) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (rect.right <= vw + 1 && rect.left >= -1) continue;
      let skip = false;
      for (let a: Element | null = el; a && a !== document.body; a = a.parentElement) {
        if (a.getAttribute("aria-hidden") === "true" || a.classList.contains("sr-only") || scrolls(a.parentElement ?? a)) {
          skip = true;
          break;
        }
        const cs = getComputedStyle(a);
        if (cs.position === "absolute" && cs.width === "1px" && cs.height === "1px") {
          skip = true;
          break;
        }
      }
      if (!skip) bad.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}.${String((el as HTMLElement).className).slice(0, 60)} [${Math.round(rect.left)}..${Math.round(rect.right)}] "${(el.textContent ?? "").trim().slice(0, 30)}"`);
    }
    return bad;
  });
}

/** (a drawer slides in over 300ms; measuring mid-slide would flag its whole panel) */
const noOverflow = async (page: Page) => {
  await page.waitForTimeout(450);
  expect(await overflowing(page), "nothing may stick out of a 390px screen").toEqual([]);
};

test("the menu scrolls, every section is reachable and the current one is in view", async ({ page }) => {
  await open(page, createFakeCustomers().handle, "/admin/customers");
  const nav = page.getByRole("navigation", { name: "ניווט ניהול" });
  const links = nav.getByRole("link");
  await expect(links).toHaveCount(10);
  expect(await nav.evaluate((el) => el.scrollWidth > el.clientWidth), "the menu is wider than a phone and scrolls").toBe(true);
  const current = nav.getByRole("link", { name: "לקוחות" });
  const inView = async (name: string) => nav.getByRole("link", { name }).evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= document.documentElement.clientWidth + 1; }); // 1px: sub-pixel layout
  expect(await inView("לקוחות"), "the current section is scrolled into view").toBe(true);
  await expect(current).toHaveAttribute("aria-current", "page");
  for (const name of ["ראשי", "הזמנות", "קטגוריות", "מוצרים", "קופונים", "עלויות ורווח", "סריקה", "שכר שליחים", "הגדרות עסק"]) {
    await nav.getByRole("link", { name }).scrollIntoViewIfNeeded();
    expect(await inView(name), `${name} can be scrolled to`).toBe(true);
  }
});

test("the overview and the orders board fit a phone, and so does an order's detail panel", async ({ page }) => {
  const orders = createFakeOrdersDatabase([
    makeOrder(1001),
    makeOrder(1002, { order_status: "preparing", delivery_notes: "לצלצל פעמיים וגם להתקשר לפני שמגיעים לכתובת" }),
    makeOrder(1003, { order_status: "out_for_delivery" }),
  ]);
  await open(page, orders.handle, "/admin/orders");
  await expect(page.getByTestId("orders-board")).toBeVisible();
  await expect(page.getByTestId("order-card").first()).toBeVisible();
  await noOverflow(page);
  await page.getByTestId("order-card").first().click();
  await expect(page.locator('[role="dialog"][aria-label^="הזמנה #"]')).toBeVisible();
  await noOverflow(page);
});

test("order history reads as cards on a phone", async ({ page }) => {
  const orders = createFakeOrdersDatabase([makeOrder(2001), makeOrder(2002, { order_status: "completed" }), makeOrder(2003, { order_status: "cancelled" })]);
  await open(page, orders.handle, "/admin/orders/history");
  await expect(page.getByTestId("orders-history")).toBeVisible();
  await page.getByRole("searchbox").fill("2001");
  await page.getByRole("button", { name: "חיפוש", exact: true }).click();
  await expect(page.getByTestId("history-row").first()).toBeVisible();
  await noOverflow(page);
  const row = page.getByTestId("history-row").first();
  await expect(row.locator("td").first(), "a card, not a table cell").toHaveCSS("display", "flex");
});

test("customers fit a phone", async ({ page }) => {
  await open(page, createFakeCustomers().handle, "/admin/customers");
  await expect(page.locator("tbody tr").first()).toBeVisible();
  await noOverflow(page);
});

test("coupons fit a phone: list, details and the form", async ({ page }) => {
  await open(page, createFakeCoupons().handle, "/admin/coupons");
  await expect(page.getByTestId("coupon-row").first()).toBeVisible();
  await noOverflow(page);
  await page.getByRole("button", { name: "פרטי הקופון CLUB20" }).click();
  await expect(page.locator('[role="dialog"][aria-label="פרטי קופון"]').getByTestId("redemption-row").first()).toBeVisible();
  await noOverflow(page);
  await page.locator('[role="dialog"][aria-label="פרטי קופון"]').getByRole("button", { name: "עריכה" }).click();
  await expect(page.locator('[role="dialog"][aria-label="עריכת קופון"]')).toBeVisible();
  await noOverflow(page);
});

test("costs fit a phone: the list as cards and the detail panel", async ({ page }) => {
  await open(page, createFakeCosts().handle, "/admin/costs");
  await expect(page.getByTestId("cost-row-2")).toBeVisible();
  await noOverflow(page);
  await expect(page.getByTestId("cost-row-2").locator("td").first(), "a card, not a table cell").toHaveCSS("display", "flex");
  await page.getByTestId("cost-row-2").getByRole("button", { name: "מרלבורו גולד" }).click();
  await expect(page.getByTestId("cost-breakdown")).toBeVisible();
  await noOverflow(page);
});

test("the scan screen fits a phone, including the product picker", async ({ page }) => {
  await open(page, createFakeCosts().handle, "/admin/scan");
  await expect(page.getByTestId("missing-barcodes")).toBeVisible();
  await page.getByTestId("missing-barcodes").locator("summary").click();
  await noOverflow(page);
  await page.getByLabel("מספר ברקוד").fill("7290000000123");
  await page.getByRole("button", { name: "חיפוש", exact: true }).click();
  await page.getByRole("button", { name: "כן, חפיסה בודדת" }).click();
  await expect(page.getByTestId("scan-results")).toBeVisible();
  await noOverflow(page);
});

test("settings, products and categories fit a phone", async ({ page }) => {
  await open(page, createSettingsDb().handle, "/admin/settings");
  await expect(page.getByRole("heading", { name: "הגדרות עסק", level: 1 })).toBeVisible();
  await noOverflow(page);
});

test("products fit a phone", async ({ page }) => {
  await open(page, createProductsDb().handle, "/admin/products");
  await expect(page.getByTestId("product-row").first()).toBeVisible();
  await noOverflow(page);
});

test("categories fit a phone", async ({ page }) => {
  await open(page, createCategoriesDb().handle, "/admin/categories");
  await expect(page.getByTestId("category-row").first()).toBeVisible();
  await noOverflow(page);
});

test("the board with delivery windows fits a phone: the extra lane and the runs panel", async ({ page }) => {
  const windowed = { delivery_window_id: "w-18", delivery_departure_time: "18:00:00" };
  const orders = createFakeOrdersDatabase(
    [
      makeOrder(3001, { ...windowed, order_status: "ready_for_dispatch", delivery_run_id: "run-x" }),
      makeOrder(3002, { ...windowed, order_status: "preparing" }),
    ],
    {
      windows: true,
      runs: [{ id: "run-x", run_date: "2026-09-20", status: "claimed", courier_id: COURIER_USER.id, courier_name: FAKE_COURIER_NAME, courier_phone: FAKE_COURIER_PHONE, claimed_at: "2026-09-20T06:00:00.000Z", departed_at: null, departure_time: "18:00:00" }],
    }
  );
  await open(page, orders.handle, "/admin/orders");
  await expect(page.getByTestId("lane-ready_for_dispatch")).toBeVisible();
  await expect(page.getByTestId("runs-panel")).toBeVisible();
  await noOverflow(page);
});

test("the courier's screen fits a phone: open runs, a run on the road, and both hand-over forms", async ({ page }) => {
  const stops = { delivery_window_id: "w-18", delivery_departure_time: "18:00:00", delivery_run_id: "run-mine" };
  const orders = createFakeOrdersDatabase(
    [
      makeOrder(3101, { ...stops, order_status: "out_for_delivery", delivery_notes: "לצלצל פעמיים וגם להתקשר לפני שמגיעים לכתובת, הכניסה מהחצר האחורית" }),
      makeOrder(3102, { ...stops, order_status: "out_for_delivery", payment_method: "cash" }),
      makeOrder(3103, { delivery_window_id: "w-21", delivery_departure_time: "21:00:00", delivery_run_id: "run-open", order_status: "ready_for_dispatch" }),
    ],
    {
      windows: true,
      runs: [
        { id: "run-mine", run_date: "2026-09-20", status: "departed", courier_id: COURIER_USER.id, courier_name: FAKE_COURIER_NAME, courier_phone: FAKE_COURIER_PHONE, claimed_at: "2026-09-20T06:00:00.000Z", departed_at: "2026-09-20T07:00:00.000Z", departure_time: "18:00:00" },
        { id: "run-open", run_date: "2026-09-20", status: "open", courier_id: null, courier_name: null, courier_phone: null, claimed_at: null, departed_at: null, departure_time: "21:00:00" },
      ],
    }
  );
  await open(page, orders.handle, "/admin/courier", COURIER_USER);
  await expect(page.getByTestId("my-run")).toBeVisible();
  await expect(page.getByTestId("open-run")).toBeVisible();
  await noOverflow(page);
  const first = page.getByTestId("courier-stop").first();
  await first.getByRole("button", { name: "נמסר", exact: true }).click();
  await expect(first.getByRole("checkbox", { name: /בדקתי תעודה מזהה/ })).toBeVisible();
  await noOverflow(page);
  await first.getByRole("button", { name: "חזרה" }).click();
  await first.getByRole("button", { name: "לא נמסר", exact: true }).click();
  await first.getByLabel("סיבה").selectOption("אחר");
  await expect(first.getByLabel("פירוט הסיבה")).toBeVisible();
  await noOverflow(page);
});

test("the delivery windows editor fits a phone", async ({ page }) => {
  const db = createSettingsDb({ windows: true });
  db.windows.push(
    { id: "w1", departure_time: "13:00:00", order_cutoff_time: "12:00:00", capacity: null, is_active: true },
    { id: "w2", departure_time: "18:00:00", order_cutoff_time: "17:00:00", capacity: 10, is_active: true }
  );
  await open(page, db.handle, "/admin/settings");
  await expect(page.getByTestId("window-row").first()).toBeVisible();
  await noOverflow(page);
});

test("the courier-pay screen fits a phone", async ({ page }) => {
  const db = createFakeCouriers([
    {
      courier_id: "00000000-0000-0000-0000-0000000000d1", name: "דני השליח", phone: "0501234567", email: "danny@example.test", active: true, rate_override_cents: 1500,
      deliveries: [makeDelivery(1101), makeDelivery(1102, { outcome: "failed", reason: "לא הוצגה תעודה מזהה וגם הלקוח סירב לפתוח את הדלת", pay_cents: null })],
      payouts: [{ id: 1, amount_cents: 1000, note: "העברה בנקאית", created_at: "2026-09-30T09:00:00.000Z" }],
    },
  ]);
  await open(page, db.handle, "/admin/couriers");
  await expect(page.getByTestId("courier-pay")).toBeVisible();
  await noOverflow(page);
  await page.getByTestId("pay-row").first().getByRole("button", { name: "סכום אחר" }).click();
  await noOverflow(page);
});
