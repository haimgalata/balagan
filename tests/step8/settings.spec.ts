import { test, expect } from "../step3/fixtures";
import { ADMIN_USER, seedSession, sessionFor, stubSupabase } from "../step5/adminStubs";
import { createFakeDatabase, type FakeDatabase } from "./fakeDatabase";
import type { Page } from "@playwright/test";

/**
 * The admin "Business Settings" screen (/admin/settings), driven through the real UI against an in-memory
 * fake of business_hours/business_settings (see fakeDatabase.ts). Two sections, kept independent on purpose
 * (see BusinessSettingsPage.tsx): the physical store's weekly hours, and everything about online orders
 * (weekly hours, minimum order, delivery fee, manual pause).
 */
test.beforeEach(({ mode }) => {
  test.skip(mode !== "supabase", "settings tests use the stubbed-database variant");
});

async function openSettings(page: Page, db: FakeDatabase = createFakeDatabase()): Promise<FakeDatabase> {
  await stubSupabase(page, { extra: db.handle });
  await seedSession(page, sessionFor(ADMIN_USER));
  await page.goto("/admin/settings");
  await expect(page.getByRole("heading", { name: "הגדרות עסק", level: 1 })).toBeVisible();
  await expect(page.getByRole("group", { name: "שעות פתיחת החנות" })).toBeVisible();
  return db;
}

const storeGroup = (page: Page) => page.getByRole("group", { name: "שעות פתיחת החנות" });
const ordersGroup = (page: Page) => page.getByRole("group", { name: "הזמנות אונליין" });

test.describe("loading", () => {
  test("shows the seeded schedules, amounts and pause state", async ({ page }) => {
    await openSettings(page);
    // Sunday (first row) open 09:00-23:00 in both sections; Saturday (last) closed
    await expect(storeGroup(page).getByRole("checkbox", { name: "ראשון" })).toBeChecked();
    await expect(storeGroup(page).getByLabel("שעות פתיחת החנות — שעת פתיחה ביום ראשון")).toHaveValue("09:00");
    await expect(storeGroup(page).getByLabel("שעות פתיחת החנות — שעת סגירה ביום ראשון")).toHaveValue("23:00");
    await expect(storeGroup(page).getByRole("checkbox", { name: "שבת" })).not.toBeChecked();
    await expect(storeGroup(page).getByText("סגור")).toBeVisible();

    await expect(ordersGroup(page).getByLabel("מינימום הזמנה (₪)")).toHaveValue("50");
    await expect(ordersGroup(page).getByLabel("דמי משלוח (₪)")).toHaveValue("15");
    await expect(page.getByRole("switch", { name: "השבתת הזמנות זמנית" })).toHaveAttribute("aria-checked", "false");
  });

  test("a missing migration 0008 shows a setup message instead of the form", async ({ page }) => {
    const db = createFakeDatabase();
    db.failAll({ status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.business_hours' in the schema cache" } });
    await stubSupabase(page, { extra: db.handle });
    await seedSession(page, sessionFor(ADMIN_USER));
    await page.goto("/admin/settings");
    await expect(page.getByRole("alert")).toContainText("0008_business_settings.sql");
    await expect(page.getByRole("group", { name: "שעות פתיחת החנות" })).toHaveCount(0);
  });
});

test.describe("physical store hours", () => {
  test("closing a day and saving persists it", async ({ page }) => {
    const db = await openSettings(page);
    const friday = storeGroup(page).getByRole("checkbox", { name: "שישי" });
    await expect(friday).toBeChecked();
    await friday.uncheck();
    await expect(storeGroup(page).getByLabel("שעות פתיחת החנות — שעת פתיחה ביום שישי")).toHaveCount(0);

    await storeGroup(page).getByRole("button", { name: "שמירה" }).click();
    await expect(page.getByRole("status")).toContainText("שעות פתיחת החנות נשמרו");
    const row = db.hourRow("store", 5);
    expect(row.is_open).toBe(false);
    expect(row.open_time).toBeNull();
    expect(row.close_time).toBeNull();
  });

  test("marking a day open with an invalid time range is refused before saving", async ({ page }) => {
    const db = await openSettings(page);
    await storeGroup(page).getByLabel("שעות פתיחת החנות — שעת פתיחה ביום ראשון").fill("20:00");
    await storeGroup(page).getByLabel("שעות פתיחת החנות — שעת סגירה ביום ראשון").fill("10:00");
    await storeGroup(page).getByRole("button", { name: "שמירה" }).click();
    await expect(storeGroup(page).getByRole("alert")).toContainText("פתיחה לפני סגירה");
    expect(db.hourRow("store", 0).open_time).toBe("09:00"); // unchanged — no request was even sent
  });
});

test.describe("online orders", () => {
  test("editing hours, minimum order and delivery fee together, in one save", async ({ page }) => {
    const db = await openSettings(page);
    await ordersGroup(page).getByRole("checkbox", { name: "שבת" }).check();
    await ordersGroup(page).getByLabel("הזמנות אונליין — שעת פתיחה ביום שבת").fill("10:00");
    await ordersGroup(page).getByLabel("הזמנות אונליין — שעת סגירה ביום שבת").fill("14:00");
    await ordersGroup(page).getByLabel("מינימום הזמנה (₪)").fill("60");
    await ordersGroup(page).getByLabel("דמי משלוח (₪)").fill("20");
    await ordersGroup(page).getByRole("button", { name: "שמירה" }).click();

    await expect(page.getByRole("status")).toContainText("הגדרות ההזמנות נשמרו");
    const saturday = db.hourRow("orders", 6);
    expect(saturday.is_open).toBe(true);
    expect(saturday.open_time).toBe("10:00");
    expect(saturday.close_time).toBe("14:00");
    expect(db.settings.min_order_cents).toBe(6000);
    expect(db.settings.delivery_fee_cents).toBe(2000);
  });

  test("a negative amount is refused before saving", async ({ page }) => {
    const db = await openSettings(page);
    await ordersGroup(page).getByLabel("דמי משלוח (₪)").fill("-5");
    await ordersGroup(page).getByRole("button", { name: "שמירה" }).click();
    await expect(ordersGroup(page).getByRole("alert")).toContainText("סכומים תקינים");
    expect(db.settings.delivery_fee_cents).toBe(1500); // unchanged
  });

  test("the manual pause switch applies immediately, independent of the hours/amounts form", async ({ page }) => {
    const db = await openSettings(page);
    await ordersGroup(page).getByLabel("מינימום הזמנה (₪)").fill("999"); // unsaved edit in the same section
    await page.getByRole("switch", { name: "השבתת הזמנות זמנית" }).click();

    await expect(page.getByRole("status")).toContainText("הזמנות אונליין הושבתו זמנית");
    expect(db.settings.orders_paused).toBe(true);
    expect(db.settings.min_order_cents).toBe(5000); // the unsaved amount edit was NOT sent by the pause toggle
    await expect(page.getByRole("switch", { name: "השבתת הזמנות זמנית" })).toHaveAttribute("aria-checked", "true");

    await page.getByRole("switch", { name: "השבתת הזמנות זמנית" }).click();
    await expect(page.getByRole("status")).toContainText("קבלת הזמנות אונליין הופעלה מחדש");
    expect(db.settings.orders_paused).toBe(false);
  });
});
