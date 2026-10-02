import { test, expect } from "../../catalog/fixtures";
import { ADMIN_USER, STAFF_USER, seedSession, sessionFor, stubSupabase } from "../auth/adminStubs";
import { createFakeCoupons, type FakeCoupons } from "./fakeDatabase";
import type { Page } from "@playwright/test";

/**
 * The owner's "קופונים" screen (/admin/coupons), driven through the real UI against an in-memory fake of the coupon tables
 * of migration 0014 (see fakeDatabase.ts): list and status chips, creating a coupon with BOTH independent limits, the
 * locked code and locked discount once used, disable / archive / restore (never delete), who used it, and the guest
 * sentence. The database enforces every rule itself (scripts/verify-order-management.mjs); this covers the screen.
 */
test.beforeEach(({ mode }) => {
  test.skip(mode !== "supabase", "coupon tests use the stubbed-database variant");
});

async function openCoupons(page: Page, db: FakeCoupons = createFakeCoupons()) {
  await stubSupabase(page, { extra: db.handle });
  await seedSession(page, sessionFor(ADMIN_USER));
  await page.goto("/admin/coupons");
  await expect(page.getByRole("heading", { name: "קופונים", level: 1 })).toBeVisible();
  await expect(page.getByTestId("coupon-row").first()).toBeVisible();
  return db;
}

const rows = (page: Page) => page.getByTestId("coupon-row");
const rowOf = (page: Page, code: string) => rows(page).filter({ has: page.locator("code", { hasText: new RegExp(`^${code}$`) }) });
const detail = (page: Page) => page.locator('[role="dialog"][aria-label="פרטי קופון"]');
const form = (page: Page) => page.locator('[role="dialog"][aria-label="קופון חדש"], [role="dialog"][aria-label="עריכת קופון"]');
const openDetail = async (page: Page, code: string) => {
  await page.getByRole("button", { name: `פרטי הקופון ${code}` }).click();
  await expect(detail(page).locator("code").first()).toHaveText(code);
};

test("the list shows every coupon but the archived, with its status, benefit and usage", async ({ page }) => {
  await openCoupons(page);
  await expect(rows(page)).toHaveCount(6); // 7 seeded, 1 archived
  await expect(rowOf(page, "ARCHIVED1")).toHaveCount(0);

  const club = rowOf(page, "CLUB20");
  await expect(club).toContainText("פעיל");
  await expect(club).toContainText("20% הנחה (עד ₪30), בהזמנה מעל ₪100");
  await expect(club).toContainText("עד 100 שימושים · עד 1 לחבר");
  await expect(club).toContainText("2 / 100 · שוחררו 1"); // two live uses, one released
  await expect(rowOf(page, "FREESHIP")).toContainText("משלוח חינם");
  await expect(rowOf(page, "FREESHIP")).toContainText("ללא הגבלת שימושים כוללת · עד 3 לחבר");
  await expect(rowOf(page, "SUMMER10")).toContainText("פג תוקף");
  await expect(rowOf(page, "PAUSED5")).toContainText("מושבת");
  await expect(rowOf(page, "FIRST100")).toContainText("מוצה"); // a reserved card hold counts as used
  await expect(rowOf(page, "NEXTWEEK")).toContainText("מתוזמן");
});

test("filter by status, archive on request, and search by code in any case/spacing or by title", async ({ page }) => {
  await openCoupons(page);
  await page.getByLabel("סינון").selectOption("archived");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("ARCHIVED1");
  await page.getByLabel("סינון").selectOption("active");
  await expect(rows(page)).toHaveCount(2);
  await page.getByLabel("סינון").selectOption("all");

  await page.getByLabel("חיפוש (קוד או שם)").fill(" club 20 ");
  await expect(rows(page)).toHaveCount(1);
  await page.getByLabel("חיפוש (קוד או שם)").fill("קיץ");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("SUMMER10");
  await page.getByLabel("חיפוש (קוד או שם)").fill("אין כזה");
  await expect(page.getByText("אין קופונים שמתאימים לסינון.")).toBeVisible();
});

test("create a coupon: the code is typed by hand and normalized; BOTH limits are set independently", async ({ page }) => {
  const db = await openCoupons(page);
  await page.getByRole("button", { name: "קופון חדש" }).click();
  const f = form(page);
  await expect(f.getByLabel("מקסימום שימושים לכל חבר")).toHaveValue("1"); // a starting point, not a rule
  await expect(f.getByRole("button", { name: /יצירת קוד|אוטומטי/ })).toHaveCount(0); // no code generator

  await f.getByLabel("קוד הקופון").fill(" welcome 25 ");
  await expect(f.getByText("יישמר כ:")).toContainText("WELCOME25");
  await f.getByLabel("שם הקופון").fill("ברוכים הבאים");
  await f.getByLabel("אחוז הנחה").fill("25");
  await f.getByLabel("תקרת הנחה ב-₪ (אופציונלי)").fill("40");
  await f.getByLabel("מינימום הזמנה ב-₪ (אופציונלי)").fill("80");
  await f.getByLabel("תקף עד תאריך (כולל)").fill("2026-10-31");
  await f.getByLabel("מקסימום שימושים בסך הכול").fill("500");
  await f.getByLabel("מקסימום שימושים לכל חבר").fill("3");
  await f.getByLabel("להזמנה ראשונה בלבד").check();
  await expect(f.getByTestId("coupon-preview")).toHaveText("25% הנחה (עד ₪40), בהזמנה מעל ₪80 · עד 500 שימושים · עד 3 לחבר · הזמנה ראשונה בלבד");
  await f.getByRole("button", { name: "שמירה" }).click();

  await expect(form(page)).toBeHidden();
  expect(db.inserts).toHaveLength(1);
  expect(db.inserts[0]).toMatchObject({
    code: "WELCOME25", title: "ברוכים הבאים", discount_type: "percent", discount_value: 25, max_discount_cents: 4000, min_subtotal_cents: 8000,
    max_total_redemptions: 500, max_per_member: 3, first_order_only: true, is_active: true, starts_at: null,
    ends_at: "2026-10-31T22:00:00.000Z", // the end of 31 Oct in Israel (winter time by then): the start of 1 Nov = 22:00Z on the 31st
  });
  await expect(detail(page).locator("code").first()).toHaveText("WELCOME25"); // the new coupon opens in its detail panel
  await expect(rowOf(page, "WELCOME25")).toContainText("0 / 500");
});

test("a free-delivery coupon needs no value; a fixed one needs an amount", async ({ page }) => {
  const db = await openCoupons(page);
  await page.getByRole("button", { name: "קופון חדש" }).click();
  const f = form(page);
  await f.getByLabel("קוד הקופון").fill("SHIPFREE");
  await f.getByLabel("שם הקופון").fill("משלוח");
  await f.getByLabel("משלוח חינם").check();
  await f.getByLabel("מקסימום שימושים לכל חבר").fill("");
  await f.getByRole("button", { name: "שמירה" }).click();
  await expect(form(page)).toBeHidden();
  expect(db.inserts[0]).toMatchObject({ code: "SHIPFREE", discount_type: "free_delivery", discount_value: null, max_discount_cents: null, max_per_member: null, max_total_redemptions: null });
});

test("the form refuses Hebrew codes, bad formats, duplicates and impossible values before anything is sent", async ({ page }) => {
  const db = await openCoupons(page);
  await page.getByRole("button", { name: "קופון חדש" }).click();
  const f = form(page);
  await f.getByLabel("קוד הקופון").fill("קוד123");
  await expect(f.getByText("קוד קופון נכתב באותיות אנגליות ובספרות בלבד")).toBeVisible();
  await f.getByLabel("קוד הקופון").fill("AB");
  await expect(f.getByText("3 עד 24 תווים")).toBeVisible();
  await f.getByLabel("קוד הקופון").fill("club 20");
  await expect(f.getByText("קוד זה כבר קיים")).toBeVisible(); // found after normalization
  await f.getByLabel("קוד הקופון").fill("ARCHIVED1");
  await expect(f.getByText("קוד זה כבר קיים (גם קופון בארכיון שומר את הקוד שלו).")).toBeVisible();

  await f.getByLabel("קוד הקופון").fill("GOOD10");
  await f.getByLabel("שם הקופון").fill("x");
  await f.getByLabel("אחוז הנחה").fill("150");
  await f.getByLabel("מקסימום שימושים בסך הכול").fill("0");
  await f.getByLabel("תקף עד תאריך (כולל)").fill("2026-09-01");
  await f.getByLabel("תקף מתאריך (אופציונלי)").fill("2026-10-01");
  await f.getByRole("button", { name: "שמירה" }).click();
  await expect(f.getByText("אחוז ההנחה חייב להיות מספר שלם בין 1 ל-100.")).toBeVisible();
  await expect(f.getByText("מגבלת השימושים הכוללת חייבת להיות מספר שלם גדול מ-0")).toBeVisible();
  await expect(f.getByText("תאריך הסיום חייב להיות אחרי תאריך ההתחלה.")).toBeVisible();
  expect(db.inserts).toHaveLength(0);
});

test("a duplicate the database reports (created in another tab) is explained inside the form", async ({ page }) => {
  const db = await openCoupons(page);
  await page.getByRole("button", { name: "קופון חדש" }).click();
  const f = form(page);
  await f.getByLabel("קוד הקופון").fill("RACE10");
  await f.getByLabel("שם הקופון").fill("x");
  await f.getByLabel("אחוז הנחה").fill("10");
  db.coupons.push({ ...db.coupons[0], id: "c-race", code: "RACE10" }); // someone else created it meanwhile
  await f.getByRole("button", { name: "שמירה" }).click();
  await expect(f.getByRole("alert").filter({ hasText: "קוד הקופון כבר קיים" })).toBeVisible();
  await expect(form(page)).toBeVisible();
});

test("details: who used the coupon, what was released and why, and the same-door hint", async ({ page }) => {
  await openCoupons(page);
  await openDetail(page, "CLUB20");
  const d = detail(page);
  await expect(d).toContainText("20% הנחה (עד ₪30), בהזמנה מעל ₪100");
  await expect(d.getByTestId("redemption-row")).toHaveCount(3);
  await expect(d.getByTestId("redemption-row").filter({ hasText: "#1201" })).toContainText("050-111-1111");
  await expect(d.getByTestId("redemption-row").filter({ hasText: "#1201" })).toContainText("הרצל 5, דירה 3");
  await expect(d.getByTestId("shared-address-flag")).toHaveCount(2); // two phones behind הרצל 5/3
  await expect(d.getByTestId("redemption-row").filter({ hasText: "#1203" })).toContainText("שוחרר — ההזמנה בוטלה אחרי יציאה למשלוח");
  await expect(d.getByTestId("redemption-row").filter({ hasText: "#1203" }).getByTestId("shared-address-flag")).toHaveCount(0);
  await expect(d.getByRole("link", { name: "הזמנה #1201" })).toHaveAttribute("href", "/admin/orders/1201");
  await expect(d.getByText("עדיין לא נעשה בו שימוש.")).toHaveCount(0);

});

test("disable and enable, then archive and restore — never delete — each change in the history with who did it", async ({ page }) => {
  const db = await openCoupons(page);
  await openDetail(page, "FREESHIP");
  const d = detail(page);
  await expect(d.getByRole("button", { name: /מחיקה|מחק/ })).toHaveCount(0);

  await d.getByRole("button", { name: "השבתה" }).click();
  await expect(d.getByTestId("detail-status")).toHaveText("מושבת");
  await expect(rowOf(page, "FREESHIP")).toContainText("מושבת");
  expect(db.updates.at(-1)).toEqual({ id: "c-ship", body: { is_active: false } });
  await expect(d.getByText("הושבת")).toBeVisible();
  await expect(d.getByText("owner@example.test").first()).toBeVisible();

  await d.getByRole("button", { name: "הפעלה" }).click();
  await expect(d.getByTestId("detail-status")).toHaveText("פעיל");

  await d.getByRole("button", { name: "העברה לארכיון" }).click();
  await expect(d.getByTestId("detail-status")).toHaveText("בארכיון");
  expect(db.updates.at(-1)?.body.archived_at).toEqual(expect.any(String));
  await expect(d.getByRole("button", { name: "השבתה" })).toHaveCount(0); // an archived coupon is not toggled, it is restored
  await d.getByRole("button", { name: "שחזור מהארכיון" }).click();
  await expect(d.getByTestId("detail-status")).toHaveText("פעיל");
  expect(db.updates.at(-1)?.body).toEqual({ archived_at: null });
  expect(db.methods.has("DELETE"), "the screen never even tries to delete").toBe(false);
});

test("a used coupon: code, type and value are locked; limits stay editable and the change is recorded", async ({ page }) => {
  const db = await openCoupons(page);
  await openDetail(page, "CLUB20");
  await detail(page).getByRole("button", { name: "עריכה" }).click();
  const f = form(page);
  await expect(f.getByTestId("coupon-code-readonly")).toHaveText("CLUB20");
  await expect(f.getByText("הקופון כבר נוצל, ולכן סוג ההנחה וערכה נעולים")).toBeVisible();
  await expect(f.getByLabel("אחוזים")).toBeDisabled();
  await expect(f.getByLabel("אחוז הנחה")).toBeDisabled();

  await f.getByLabel("מקסימום שימושים לכל חבר").fill("3");
  await f.getByLabel("מקסימום שימושים בסך הכול").fill("250");
  await f.getByRole("button", { name: "שמירה" }).click();
  await expect(form(page)).toBeHidden();

  const sent = db.updates.at(-1)!.body;
  expect(sent).toMatchObject({ max_per_member: 3, max_total_redemptions: 250, title: "הנחת מועדון" });
  for (const locked of ["code", "discount_type", "discount_value", "max_discount_cents"]) expect(sent, locked).not.toHaveProperty(locked);
  await expect(rowOf(page, "CLUB20")).toContainText("עד 250 שימושים · עד 3 לחבר");
  await expect(detail(page).getByText("מגבלה לחבר: 1 ← 3")).toBeVisible();
  await expect(detail(page).getByText("מגבלת שימושים כוללת: 100 ← 250")).toBeVisible();
});

test("an unused coupon can still change type and value", async ({ page }) => {
  const db = await openCoupons(page);
  await openDetail(page, "PAUSED5");
  await detail(page).getByRole("button", { name: "עריכה" }).click();
  const f = form(page);
  await expect(f.getByLabel("סכום ההנחה ב-₪")).toHaveValue("5");
  await f.getByLabel("סכום ההנחה ב-₪").fill("12.5");
  await f.getByRole("button", { name: "שמירה" }).click();
  await expect(form(page)).toBeHidden();
  expect(db.updates.at(-1)!.body).toMatchObject({ discount_type: "fixed", discount_value: 1250 });
});

test("duplicating starts from the same terms but needs a new code and is off until the owner turns it on", async ({ page }) => {
  await openCoupons(page);
  await openDetail(page, "CLUB20");
  await detail(page).getByRole("button", { name: "שכפול" }).click();
  const f = form(page);
  await expect(f.getByLabel("קוד הקופון")).toHaveValue("");
  await expect(f.getByLabel("שם הקופון")).toHaveValue("הנחת מועדון (עותק)");
  await expect(f.getByLabel("אחוז הנחה")).toHaveValue("20");
  await expect(f.getByLabel("פעיל (ניתן לממש)")).not.toBeChecked();
});

test("the guest sentence: saved as plain public text, cleared back to the default wording", async ({ page }) => {
  const db = await openCoupons(page);
  const box = page.getByRole("textbox", { name: "הודעה לאורחים" });
  await expect(box).toHaveValue("");
  await expect(page.getByRole("button", { name: "שמירת הודעה" })).toBeDisabled(); // nothing changed yet
  await box.fill("חברי מועדון: 10% הנחה השבוע");
  await page.getByRole("button", { name: "שמירת הודעה" }).click();
  await expect(page.getByText("ההודעה נשמרה ומוצגת עכשיו לאורחים בקופה.")).toBeVisible();
  expect(db.offerPatches.at(-1)).toEqual({ club_offer_text: "חברי מועדון: 10% הנחה השבוע" });

  await box.fill("   ");
  await page.getByRole("button", { name: "שמירת הודעה" }).click();
  await expect(page.getByText("ההודעה נוקתה")).toBeVisible();
  expect(db.offerPatches.at(-1)).toEqual({ club_offer_text: null });
});

test("a missing migration or a refusal is explained, with a retry", async ({ page }) => {
  const db = createFakeCoupons();
  db.failWith = { status: 404, body: { code: "PGRST205", message: "Could not find the table 'public.coupons' in the schema cache" } };
  await stubSupabase(page, { extra: db.handle });
  await seedSession(page, sessionFor(ADMIN_USER));
  await page.goto("/admin/coupons");
  await expect(page.getByRole("alert").filter({ hasText: "0014_coupons.sql" }).first()).toBeVisible();
  db.failWith = null;
  await page.getByRole("button", { name: "נסו שוב" }).first().click();
  await expect(rows(page).first()).toBeVisible();
});

test("staff never see the coupons screen: no menu item, and the address sends them to the orders board", async ({ page }) => {
  const db = createFakeCoupons();
  await stubSupabase(page, { users: [STAFF_USER], extra: db.handle });
  await seedSession(page, sessionFor(STAFF_USER));
  await page.goto("/admin/coupons");
  await expect(page).toHaveURL(/\/admin\/orders$/);
  await expect(page.getByRole("link", { name: "קופונים" })).toHaveCount(0);
  expect(db.methods.size, "no coupon request is even made for a staff session").toBe(0);
});

test("the owner's menu has the coupons item", async ({ page }) => {
  await openCoupons(page);
  await expect(page.getByRole("navigation", { name: "ניווט ניהול" }).getByRole("link", { name: "קופונים" })).toHaveAttribute("aria-current", "page");
});
