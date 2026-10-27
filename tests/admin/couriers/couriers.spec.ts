import { test, expect } from "../../catalog/fixtures";
import { ADMIN_USER, STAFF_USER, seedSession, sessionFor, stubSupabase, type StubUser } from "../auth/adminStubs";
import { createFakeCouriers, makeDelivery, type FakeCouriersDatabase, type FakeCourier } from "./fakeDatabase";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * The owner's courier-pay screen (/admin/couriers, migration 0018) against an in-memory fake of its functions. The amounts
 * and who may see them are verified on real Postgres by scripts/verify-order-management.mjs; these tests drive the screen.
 */
test.beforeEach(({ mode }) => {
  test.skip(mode !== "supabase", "payroll tests use the stubbed-database variant");
});

const DANNY: FakeCourier = {
  courier_id: "00000000-0000-0000-0000-0000000000d1",
  name: "דני השליח",
  phone: "0501234567",
  email: "danny@example.test",
  active: true,
  rate_override_cents: null,
  deliveries: [
    makeDelivery(1101),
    makeDelivery(1102, { street: undefined, address: "אילת 3" } as never),
    makeDelivery(1103, { outcome: "failed", reason: "לא הוצגה תעודה מזהה", pay_cents: 1200 }),
    makeDelivery(1104, { outcome: "failed", reason: "הכתובת לא נמצאה", pay_cents: null }),
  ],
  payouts: [],
};

function seed(): FakeCouriersDatabase {
  return createFakeCouriers([structuredClone(DANNY)]);
}

async function open(page: Page, db: FakeCouriersDatabase, user: StubUser = ADMIN_USER) {
  await stubSupabase(page, { users: [ADMIN_USER, STAFF_USER], extra: db.handle });
  await seedSession(page, sessionFor(user));
  await page.goto("/admin/couriers");
}
const card = (page: Page) => page.getByTestId("courier-pay").first();

test.describe("courier pay", () => {
  test("shows the month's numbers per courier: delivered, failed, runs, days, what is owed, paid and what is left", async ({ page }) => {
    await open(page, seed());
    await expect(page.getByTestId("month-label")).toHaveText("ספטמבר 2026");
    const c = card(page);
    await expect(c).toContainText("דני השליח");
    await expect(c.getByRole("link", { name: /050/ })).toHaveAttribute("href", "tel:0501234567");
    const stats = c.locator("dl").first();
    await expect(stats).toContainText("נמסרו2");
    await expect(stats).toContainText("לא נמסרו2");
    await expect(c.locator("dl").nth(1)).toContainText("לתשלום₪36"); // 1200 x 3 (delivered, delivered, failed-but-paid); the undecided one counts 0
    await expect(c.locator("dl").nth(1)).toContainText("נשאר לשלם₪36");
  });

  test("a failed delivery waiting for a decision is flagged first and does not count until the owner decides", async ({ page }) => {
    const db = seed();
    await open(page, db);
    await expect(card(page).getByRole("alert")).toContainText("משלוח אחד שנכשל מחכה להחלטה שלך");
    const rows = card(page).getByTestId("pay-row");
    await expect(rows.first()).toHaveAttribute("data-pending", "true"); // pending ones come first
    await expect(rows.first()).toContainText("#1104");
    await expect(rows.first().getByTestId("row-pay")).toHaveText("ממתין להחלטה");

    await rows.first().getByRole("button", { name: /לשלם תעריף מלא/ }).click();
    await expect(page.getByRole("status")).toContainText("התשלום על ההזמנה עודכן");
    expect(db.couriers[0].deliveries.find((d) => d.order_number === 1104)?.pay_cents).toBe(1200);
    await expect(card(page).getByRole("alert")).toHaveCount(0);
    await expect(card(page).locator("dl").nth(1)).toContainText("לתשלום₪48");
  });

  test("the owner can pay nothing for it, or another amount, and can correct a delivery that was already paid", async ({ page }) => {
    const db = seed();
    await open(page, db);
    await card(page).getByTestId("pay-row").first().getByRole("button", { name: "בלי תשלום" }).click();
    await expect(page.getByRole("status")).toContainText("עודכן");
    expect(db.couriers[0].deliveries.find((d) => d.order_number === 1104)?.pay_cents).toBe(0);

    const row = card(page).getByTestId("pay-row").filter({ hasText: "#1101" });
    await row.getByRole("button", { name: "שינוי סכום" }).click();
    await row.getByLabel(/סכום לשליח על הזמנה 1101/).fill("15.5");
    await row.getByRole("button", { name: "שמירה" }).click();
    await expect(row.getByTestId("row-pay")).toHaveText("₪15.50");
    expect(db.couriers[0].deliveries.find((d) => d.order_number === 1101)?.pay_cents).toBe(1550);
  });

  test("the default rate and a courier's own rate are set separately; clearing his own goes back to the default", async ({ page }) => {
    const db = seed();
    await open(page, db);
    await page.getByLabel("תעריף ברירת מחדל לכל משלוח (₪)").fill("20");
    await page.getByRole("region", { name: "תעריף ברירת מחדל" }).getByRole("button", { name: "שמירה" }).click();
    await expect(page.getByRole("status")).toContainText("ברירת המחדל לתעריף נשמרה");
    expect(db.defaultRate).toBe(2000);

    const own = card(page).getByLabel("תעריף לכל משלוח של דני השליח (₪)");
    await own.fill("25");
    await card(page).getByRole("button", { name: "שמירת תעריף" }).click();
    await expect(page.getByRole("status")).toContainText("התעריף של השליח נשמר");
    expect(db.couriers[0].rate_override_cents).toBe(2500);
    await expect(card(page)).toContainText("כרגע ₪25");

    await own.fill("");
    await card(page).getByRole("button", { name: "שמירת תעריף" }).click();
    await expect(page.getByRole("status")).toContainText("חזר לברירת המחדל");
    expect(db.couriers[0].rate_override_cents).toBeNull();
    await expect(card(page)).toContainText("כרגע ₪20");
  });

  test("a bad amount is refused before it is sent", async ({ page }) => {
    const db = seed();
    await open(page, db);
    await card(page).getByLabel("תעריף לכל משלוח של דני השליח (₪)").fill("abc");
    await card(page).getByRole("button", { name: "שמירת תעריף" }).click();
    await expect(card(page).getByRole("alert").last()).toContainText("סכום תקין");
    expect(db.log.filter((l) => l.startsWith("rate"))).toHaveLength(0);
  });

  test("recording what was paid shows what is left; a mistake is deleted with a second tap", async ({ page }) => {
    const db = seed();
    await open(page, db);
    await card(page).getByRole("button", { name: /כל היתרה/ }).click();
    await card(page).getByLabel("הערה לתשלום לדני השליח").fill("העברה בנקאית");
    await card(page).getByRole("button", { name: "רישום תשלום" }).click();
    await expect(page.getByRole("status")).toContainText("התשלום נרשם");
    expect(db.couriers[0].payouts[0]).toMatchObject({ amount_cents: 3600, note: "העברה בנקאית" });
    await expect(card(page).locator("dl").nth(1)).toContainText("נשאר לשלם₪0");
    await expect(card(page).getByTestId("payout-row")).toContainText("העברה בנקאית");

    await card(page).getByRole("button", { name: "מחיקה" }).click(); // first tap only asks
    expect(db.couriers[0].payouts).toHaveLength(1);
    await card(page).getByRole("button", { name: "לחצו שוב למחיקה" }).click();
    await expect(card(page).getByTestId("payout-row")).toHaveCount(0);
    expect(db.couriers[0].payouts).toHaveLength(0);
  });

  test("the month's CSV downloads with every delivery and the totals", async ({ page }) => {
    await open(page, seed());
    const download = page.waitForEvent("download");
    await card(page).getByRole("button", { name: "ייצוא CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe("balagan-courier-pay-2026-09-דני-השליח.csv");
    const text = readFileSync((await file.path())!, "utf8");
    expect(text.startsWith("﻿")).toBe(true); // BOM, so Excel shows Hebrew
    expect(text).toContain('"order_number"');
    expect(text).toContain('"1104"');
    expect(text).toContain('"TOTAL"');
    expect(text).toContain('"36.00"');
  });

  test("staff never get the screen: the shell sends them to the orders board", async ({ page }) => {
    const db = seed();
    await open(page, db, STAFF_USER);
    await expect(page).toHaveURL(/\/admin\/orders$/);
    expect(db.log).toHaveLength(0);
  });

  test("the previous month can be browsed; the next month is not offered past the current one", async ({ page }) => {
    const db = seed();
    await open(page, db);
    await expect(page.getByRole("button", { name: "החודש הבא" })).toBeDisabled();
    await page.getByRole("button", { name: "החודש הקודם" }).click();
    await expect(page.getByTestId("month-label")).toHaveText("אוגוסט 2026");
    expect(db.log.at(-1)).toBe("payroll 2026-08-01");
    await expect(page.getByRole("button", { name: "החודש הבא" })).toBeEnabled();
  });

  test("with no couriers or deliveries yet it says so", async ({ page }) => {
    await open(page, createFakeCouriers([]));
    await expect(page.getByText("עדיין אין שליחים או משלוחים בחודש הזה")).toBeVisible();
  });
});
