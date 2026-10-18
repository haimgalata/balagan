import { test, expect } from "../catalog/fixtures";
import { ADMIN_USER, seedSession, sessionFor, stubSupabase, type StubRequestContext } from "./auth/adminStubs";
import { createFakeOrdersDatabase, makeOrder } from "./orders/fakeDatabase";
import { createFakeCustomers } from "./customers/fakeDatabase";
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

async function open(page: Page, handle: Handle, path: string) {
  await stubSupabase(page, { extra: handle });
  await seedSession(page, sessionFor(ADMIN_USER));
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
  await expect(links).toHaveCount(9);
  expect(await nav.evaluate((el) => el.scrollWidth > el.clientWidth), "the menu is wider than a phone and scrolls").toBe(true);
  const current = nav.getByRole("link", { name: "לקוחות" });
  const inView = async (name: string) => nav.getByRole("link", { name }).evaluate((el) => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.right <= document.documentElement.clientWidth + 1; }); // 1px: sub-pixel layout
  expect(await inView("לקוחות"), "the current section is scrolled into view").toBe(true);
  await expect(current).toHaveAttribute("aria-current", "page");
  for (const name of ["ראשי", "הזמנות", "קטגוריות", "מוצרים", "קופונים", "עלויות ורווח", "סריקה", "הגדרות עסק"]) {
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
