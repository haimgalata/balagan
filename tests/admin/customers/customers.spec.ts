import { test, expect } from "../../catalog/fixtures";
import { ADMIN_USER, STAFF_USER, seedSession, sessionFor, stubSupabase } from "../auth/adminStubs";
import { createFakeCustomers, type FakeCustomers } from "./fakeDatabase";
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

/**
 * The owner's "לקוחות" screen (/admin/customers), driven through the real UI against an in-memory fake of the owner-only
 * customer functions (see fakeDatabase.ts and migration 0013): headline numbers, the searchable member list, and the
 * audience exports (who may lawfully be contacted, and who must not be).
 */
test.beforeEach(({ mode }) => {
  test.skip(mode !== "supabase", "customers tests use the stubbed-database variant");
});

async function openCustomers(page: Page, db: FakeCustomers = createFakeCustomers()) {
  const stub = await stubSupabase(page, { extra: db.handle });
  await seedSession(page, sessionFor(ADMIN_USER));
  await page.goto("/admin/customers");
  await expect(page.getByRole("heading", { name: "לקוחות", level: 1 })).toBeVisible();
  return { db, stub };
}

const stat = (page: Page, label: string) => page.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");
const rows = (page: Page) => page.locator("tbody tr");

async function exportAndRead(page: Page, kind: string) {
  await page.getByRole("button", { name: `ייצוא ${kind}` }).click();
  const confirm = page.getByRole("group", { name: `אישור ייצוא ${kind}` });
  await expect(confirm).toContainText("הקובץ יכיל פרטים אישיים");
  const downloadPromise = page.waitForEvent("download");
  await confirm.getByRole("button", { name: "כן, לייצא" }).click();
  const download = await downloadPromise;
  const text = readFileSync(await download.path(), "utf8");
  return { download, text };
}

test("the owner sees the numbers and the newest members first", async ({ page }) => {
  await openCustomers(page);
  // 30 live members (26 generic + dana, evil, oren, michal; the deleted one is not a member), 1 deleted
  await expect(stat(page, "חברים במועדון")).toHaveText("30");
  await expect(stat(page, "מחקו את החשבון")).toHaveText("1");
  await expect(stat(page, "הסירו הסכמה לדיוור")).toHaveText("1");
  // SMS: 26 generic + dana + evil; e-mail: 26 generic have no e-mail on file -> dana + michal only
  await expect(stat(page, "ניתן לשלוח להם SMS")).toHaveText("28");
  await expect(stat(page, "ניתן לשלוח להם אימייל")).toHaveText("2");

  await expect(rows(page)).toHaveCount(25); // one page
  await expect(page.getByText("מציג 1–25 מתוך 30")).toBeVisible();
  // newest first: the "evil" member joined on the 21st
  await expect(rows(page).first()).toContainText("הנוכל");
});

test("a member row shows name, local phone, e-mail, Israel dates, order count and the marketing state", async ({ page }) => {
  await openCustomers(page);
  await page.getByLabel("חיפוש (שם, טלפון או אימייל)").fill("דנה");
  await page.getByRole("button", { name: "חיפוש", exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
  const row = rows(page).first();
  await expect(row).toContainText("דנה כהן");
  await expect(row).toContainText("050-111-2222");
  await expect(row).toContainText("dana@x.test");
  await expect(row).toContainText("20.9.2026");
  await expect(row.getByRole("cell", { name: "5", exact: true })).toBeVisible();
  await expect(row).toContainText("SMS + אימייל");
});

test("search by phone (any local format) and by e-mail; the filter narrows by consent", async ({ page }) => {
  await openCustomers(page);
  const search = page.getByLabel("חיפוש (שם, טלפון או אימייל)");

  await search.fill("050-444-5555");
  await page.getByRole("button", { name: "חיפוש", exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("אורן לוי");
  await expect(rows(page).first()).toContainText("הסיר/ה הסכמה");

  await search.fill("michal@");
  await page.getByRole("button", { name: "חיפוש", exact: true }).click();
  await expect(rows(page).first()).toContainText("מיכל בר");

  await search.fill("");
  await page.getByRole("button", { name: "חיפוש", exact: true }).click();
  await page.getByLabel("הסכמה לדיוור").selectOption("withdrawn");
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first()).toContainText("אורן");

  await page.getByLabel("הסכמה לדיוור").selectOption("email");
  await expect(rows(page)).toHaveCount(2); // dana + michal
  await search.fill("אין כזה אדם");
  await page.getByRole("button", { name: "חיפוש", exact: true }).click();
  await expect(page.getByText("לא נמצאו חברים.")).toBeVisible();
});

test("pagination: next and previous, and a new search goes back to page one", async ({ page }) => {
  await openCustomers(page);
  await expect(page.getByRole("button", { name: "הקודם" })).toBeDisabled();
  await page.getByRole("button", { name: "הבא" }).click();
  await expect(page.getByText("מציג 26–30 מתוך 30")).toBeVisible();
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByRole("button", { name: "הבא" })).toBeDisabled();
  await page.getByRole("button", { name: "הקודם" }).click();
  await expect(page.getByText("מציג 1–25 מתוך 30")).toBeVisible();

  await page.getByRole("button", { name: "הבא" }).click();
  await page.getByLabel("הסכמה לדיוור").selectOption("sms");
  await expect(page.getByText(/מציג 1–25 מתוך 28/)).toBeVisible();
});

test("exporting the SMS audience: asks first, downloads a clean UTF-8 CSV of exactly the consenting members, and logs it", async ({ page }) => {
  const { db } = await openCustomers(page);
  const { download, text } = await exportAndRead(page, "רשימת SMS");

  expect(download.suggestedFilename()).toMatch(/^balagan-marketing-sms-\d{4}-\d{2}-\d{2}\.csv$/);
  expect(text.charCodeAt(0)).toBe(0xfeff); // BOM: Excel shows the Hebrew correctly
  const lines = text.slice(1).split("\r\n").filter(Boolean);
  expect(lines[0]).toBe('"phone","phone_local","first_name","last_name","consent_at","wording_version"');
  expect(lines).toHaveLength(1 + 28);
  expect(text).toContain('"+972501112222","0501112222","דנה","כהן"');
  expect(text, "a withdrawn member is not in a marketing list").not.toContain("+972504445555");
  expect(text, "a deleted member is not in a marketing list").not.toContain("+972506667777");
  expect(text, "an e-mail-only member is not in the SMS list").not.toContain("+972505556666");
  // a customer-typed name that looks like a spreadsheet formula is defused
  expect(text).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);

  await expect(page.getByText(/רשימת SMS: הורדו 28 שורות/)).toBeVisible();
  expect(db.exportsLog).toEqual([{ kind: "sms", count: 28, actor: ADMIN_USER.email }]);
  await expect(page.getByText(/ייצוא אחרון: .* · 28 שורות/)).toBeVisible();
});

test("cancelling the confirmation exports nothing", async ({ page }) => {
  const { db } = await openCustomers(page);
  await page.getByRole("button", { name: "ייצוא רשימת אימייל" }).click();
  await page.getByRole("group", { name: "אישור ייצוא רשימת אימייל" }).getByRole("button", { name: "ביטול" }).click();
  await expect(page.getByRole("button", { name: "ייצוא רשימת אימייל" })).toBeVisible();
  expect(db.calls.filter((c) => c === "admin_export_audience")).toEqual([]);
  expect(db.exportsLog).toEqual([]);
});

test("the e-mail audience needs an address, and the do-not-contact list has the withdrawn and the deleted", async ({ page }) => {
  await openCustomers(page);
  const mail = await exportAndRead(page, "רשימת אימייל");
  const mailLines = mail.text.slice(1).split("\r\n").filter(Boolean);
  expect(mailLines[0].startsWith('"email","first_name"')).toBe(true);
  expect(mailLines).toHaveLength(1 + 2); // dana + michal (the 26 generic members have no address; the withdrawn one is out)
  expect(mail.text).toContain("dana@x.test");
  expect(mail.text).toContain("michal@x.test");
  expect(mail.text).not.toContain("oren@x.test");

  const sup = await exportAndRead(page, "רשימת הסרה (אין לפנות)");
  expect(sup.download.suggestedFilename()).toMatch(/^balagan-do-not-contact-/);
  expect(sup.text).toContain('"+972504445555","0504445555","oren@x.test","withdrawn"');
  expect(sup.text).toContain('"+972506667777","0506667777","","deleted"');
  expect(sup.text, "someone who still consents is not on the do-not-contact list").not.toContain("+972501112222");
});

test("an empty audience downloads nothing but is still logged", async ({ page }) => {
  const db = createFakeCustomers();
  db.members.forEach((m) => { m.channels = m.channels.filter((c) => c !== "email"); });
  await openCustomers(page, db);
  await page.getByRole("button", { name: "ייצוא רשימת אימייל" }).click();
  await page.getByRole("group", { name: "אישור ייצוא רשימת אימייל" }).getByRole("button", { name: "כן, לייצא" }).click();
  await expect(page.getByText(/אין כרגע אף אחד ברשימה הזו, לכן לא הורד קובץ/)).toBeVisible();
  expect(db.exportsLog).toEqual([{ kind: "email", count: 0, actor: ADMIN_USER.email }]);
});

test("a refusal or a missing migration is explained, with a retry", async ({ page }) => {
  const db = createFakeCustomers();
  db.failWith = { status: 404, body: { code: "PGRST202", message: "Could not find the function public.admin_list_customers in the schema cache" } };
  await stubSupabase(page, { extra: db.handle });
  await seedSession(page, sessionFor(ADMIN_USER));
  await page.goto("/admin/customers");
  await expect(page.getByRole("alert").first()).toContainText("0013_customer_admin.sql");
  await expect(page.getByRole("alert")).toHaveCount(2); // the numbers and the list both explain it

  db.failWith = null;
  await page.getByRole("button", { name: "נסו שוב" }).last().click();
  await expect(rows(page).first()).toBeVisible();
});

test("staff never see the customers screen: no menu item, and the address sends them to the orders board", async ({ page }) => {
  const db = createFakeCustomers();
  const stub = await stubSupabase(page, { users: [STAFF_USER], extra: db.handle });
  await seedSession(page, sessionFor(STAFF_USER));
  await page.goto("/admin/customers");
  await expect(page).toHaveURL(/\/admin\/orders$/);
  await expect(page.getByRole("link", { name: "לקוחות" })).toHaveCount(0);
  expect(db.calls, "no customer function is even called for a staff session").toEqual([]);
  void stub;
});

test("the owner's menu has the customers item", async ({ page }) => {
  await openCustomers(page);
  const item = page.getByRole("navigation", { name: "ניווט ניהול" }).getByRole("link", { name: "לקוחות" });
  await expect(item).toHaveAttribute("aria-current", "page");
});
