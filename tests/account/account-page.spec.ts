import { test, expect, gotoReady, buildRpcCatalog, RPC_URL, rpcOk, STOCK_RPC_URL, stockOk, readLocalStorage, V2_CART_KEY } from "../catalog/fixtures";
import { stubMemberRpc, type FakeOrder, type FakeProfile } from "./memberStubs";
import type { Page } from "@playwright/test";

/**
 * /account — the club member's personal area — against the test-only mock login and a stateful fake of the member
 * endpoints. Runs only in the "account" build (the route exists only in builds with a club login).
 */
const SESSION_KEY = "balagan-customer-auth";
const HINT_KEY = "balagan_member_hint_v1";
const E164 = "+972501112222";

const ORDERS: FakeOrder[] = [
  { id: "o2", order_number: 1043, order_status: "out_for_delivery", created_at: "2026-09-19T21:30:00Z", items: [{ product_id: "1", name: "מרלבורו", option: "package", quantity: 1, unit_price_cents: 50000 }] },
  {
    id: "o1", order_number: 1042, order_status: "completed", created_at: "2026-09-10T08:00:00Z",
    items: [
      { product_id: "1", name: "מרלבורו", option: "package", quantity: 1, unit_price_cents: 50000 },
      { product_id: "999999", name: "מוצר שירד מהאתר", option: "unit", quantity: 2 },
      { product_id: null, name: "מוצר שנמחק", option: "unit", quantity: 1 },
    ],
  },
];

const MEMBER: FakeProfile = {
  first_name: "דנה", last_name: "כהן", email: "d@x.test", terms_version: "v1", orders: ORDERS,
  addresses: [
    { id: "a1", street: "הרצל", house_number: "12", floor: "2", apartment: "5" },
    { id: "a2", street: "בן גוריון", house_number: "10" },
  ],
};

async function setup(page: Page, opts: { member?: FakeProfile | null; session?: boolean; unavailable?: string[] } = {}) {
  const stubs = await stubMemberRpc(page, opts.member === null ? {} : { [E164]: opts.member ?? MEMBER });
  await page.route(RPC_URL, rpcOk(buildRpcCatalog()));
  await page.route(STOCK_RPC_URL, stockOk(opts.unavailable ?? []));
  await page.addInitScript(
    ([key, withSession]) => {
      localStorage.setItem("balagan_age_verified", "true");
      if (withSession) localStorage.setItem(key, JSON.stringify({ accessToken: "mock-customer-token.+972501112222", phoneE164: "+972501112222" }));
    },
    [SESSION_KEY, opts.session ?? true] as const
  );
  return stubs;
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name });
const panel = (page: Page) => page.getByRole("tabpanel");

test("a visitor who is not signed in gets the login panel, and nothing is requested for them", async ({ page }) => {
  const stubs = await setup(page, { session: false });
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "האזור האישי" })).toBeVisible();
  await expect(page.getByLabel("טלפון נייד")).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  expect(stubs.profileCalls).toEqual([]);
  expect(stubs.addressCalls).toEqual([]);
});

test("the drawer's member view links to the personal area", async ({ page }) => {
  await setup(page);
  await gotoReady(page);
  await page.getByRole("button", { name: /אזור אישי|התחברות/ }).first().click();
  const link = page.locator('[role="dialog"][aria-label="אזור אישי"]').getByRole("link", { name: "לאזור האישי שלי" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "/account");
});

test("a member sees their orders: number, Israel date, status, items, total, address", async ({ page }) => {
  await setup(page);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "היי דנה" })).toBeVisible();
  await expect(tab(page, "ההזמנות שלי")).toHaveAttribute("aria-selected", "true");

  await expect(page.getByText("הזמנה #1043")).toBeVisible();
  await expect(page.getByText("בדרך אליכם")).toBeVisible();
  await expect(page.getByText("20.9.2026")).toBeVisible(); // 21:30Z on the 19th is already the 20th in Israel
  await expect(page.getByText("הזמנה #1042")).toBeVisible();
  await expect(page.getByText("נמסרה")).toBeVisible();
  await expect(panel(page).getByText("1 × מוצר שנמחק")).toBeVisible();
  await expect(panel(page).getByText("₪515").first()).toBeVisible();
});

test("a member with no orders yet sees a friendly empty state", async ({ page }) => {
  await setup(page, { member: { ...MEMBER, orders: [] } });
  await page.goto("/account");
  await expect(page.getByText("עדיין אין הזמנות")).toBeVisible();
});

test("if the orders cannot be loaded there is a message and a retry", async ({ page }) => {
  const stubs = await setup(page);
  stubs.failOrders = true;
  await page.goto("/account");
  await expect(panel(page).getByRole("alert")).toContainText("משהו השתבש");
  stubs.failOrders = false;
  await panel(page).getByRole("button", { name: "נסו שוב" }).click();
  await expect(page.getByText("הזמנה #1043")).toBeVisible();
});

test("order again: what is available goes into the cart, what is not is named — and nothing is ordered", async ({ page }) => {
  await setup(page);
  await page.goto("/account");
  await page.getByRole("button", { name: /הזמן שוב את הזמנה 1042/ }).click();

  await expect(page.getByText("מוצר אחד נוסף לעגלה.")).toBeVisible();
  const skipped = page.getByText(/לא נוסף לעגלה/);
  await expect(skipped).toContainText("מוצר שירד מהאתר");
  await expect(skipped).toContainText("מוצר שנמחק");
  await expect(page.getByRole("link", { name: "מעבר לתשלום" })).toHaveAttribute("href", "/checkout");

  expect(JSON.parse((await readLocalStorage(page, V2_CART_KEY)) ?? "[]")).toEqual([{ productId: "1", option: "package", quantity: 1 }]);
});

test("order again still goes through the stock check: an item that no longer fits is not added", async ({ page }) => {
  await setup(page, { unavailable: ["1"] });
  await page.goto("/account");
  await page.getByRole("button", { name: /הזמן שוב את הזמנה 1043/ }).click();
  await expect(page.getByText(/לא נוסף לעגלה/)).toContainText("מרלבורו");
  await expect(page.getByRole("link", { name: "מעבר לתשלום" })).toHaveCount(0);
  expect(JSON.parse((await readLocalStorage(page, V2_CART_KEY)) ?? "[]")).toEqual([]);
});

test("addresses: the first is the default, another can be made the default", async ({ page }) => {
  await setup(page);
  await page.goto("/account");
  await tab(page, "כתובות").click();
  const items = panel(page).getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText("הרצל 12");
  await expect(items.first()).toContainText("ברירת מחדל");
  await expect(items.first()).toContainText("קומה 2 · דירה 5");

  await items.nth(1).getByRole("button", { name: "הפוך לברירת מחדל" }).click();
  await expect(items.first()).toContainText("בן גוריון 10");
  await expect(items.first()).toContainText("ברירת מחדל");
});

test("addresses: add (validated), duplicate refused, edit, delete with confirmation", async ({ page }) => {
  await setup(page);
  await page.goto("/account");
  await tab(page, "כתובות").click();

  await panel(page).getByRole("button", { name: "הוספת כתובת" }).click();
  await panel(page).getByRole("button", { name: "שמירה" }).click();
  await expect(panel(page).getByText("נא לבחור רחוב מהרשימה המוצעת")).toBeVisible();
  await expect(panel(page).getByText("נא להזין מספר בית")).toBeVisible();

  await panel(page).getByRole("combobox", { name: "רחוב" }).fill("הרצל");
  await panel(page).getByRole("textbox", { name: "מספר בית" }).fill("12");
  await panel(page).getByRole("textbox", { name: "קומה" }).fill("2");
  await panel(page).getByRole("textbox", { name: "דירה" }).fill("5");
  await panel(page).getByRole("button", { name: "שמירה" }).click();
  await expect(panel(page).getByText("הכתובת הזו כבר שמורה אצלכם.")).toBeVisible(); // same as the existing first one

  await panel(page).getByRole("textbox", { name: "דירה" }).fill("9");
  await panel(page).getByRole("button", { name: "שמירה" }).click();
  const items = panel(page).getByRole("listitem");
  await expect(items).toHaveCount(3);
  await expect(items.first()).toContainText("הרצל 12");
  await expect(items.first()).toContainText("דירה 9");

  await items.nth(2).getByRole("button", { name: "עריכה" }).click();
  await panel(page).getByRole("textbox", { name: "מספר בית" }).fill("77");
  await panel(page).getByRole("button", { name: "שמירה" }).click();
  await expect(items.nth(2)).toContainText("בן גוריון 77");

  await items.nth(2).getByRole("button", { name: "מחיקה" }).click();
  await expect(items).toHaveCount(3); // not deleted yet: it asks first
  await items.nth(2).getByRole("button", { name: "כן, למחוק" }).click();
  await expect(items).toHaveCount(2);
});

test("details: name and e-mail can be changed, the phone cannot, and the greeting follows", async ({ page }) => {
  const stubs = await setup(page);
  await page.goto("/account");
  await tab(page, "הפרטים שלי").click();
  await expect(panel(page).getByRole("textbox", { name: "שם פרטי" })).toHaveValue("דנה");
  await expect(panel(page).getByText("050-111-2222")).toBeVisible();
  await expect(panel(page).getByRole("textbox", { name: "טלפון" })).toHaveCount(0); // not editable

  await panel(page).getByRole("textbox", { name: /אימייל/ }).fill("not-an-email");
  await panel(page).getByRole("button", { name: "שמירה" }).click();
  await expect(panel(page).getByText("נא להזין כתובת אימייל תקינה")).toBeVisible();
  expect(stubs.profilePatches).toEqual([]);

  await panel(page).getByRole("textbox", { name: "שם פרטי" }).fill("רותי");
  await panel(page).getByRole("textbox", { name: /אימייל/ }).fill("");
  await panel(page).getByRole("button", { name: "שמירה" }).click();
  await expect(panel(page).getByText("הפרטים נשמרו.")).toBeVisible();
  expect(stubs.profilePatches).toEqual([{ first_name: "רותי", last_name: "כהן", email: null }]); // phone/terms never sent
  await expect(page.getByRole("heading", { name: "היי רותי" })).toBeVisible();
  expect(await readLocalStorage(page, HINT_KEY)).toBe('{"firstName":"רותי"}');
});

test("preferences: marketing consent can be withdrawn and given again, per channel, without touching the account", async ({ page }) => {
  const stubs = await setup(page);
  await page.goto("/account");
  await tab(page, "העדפות").click();

  const main = panel(page).getByRole("checkbox", { name: /אני מעוניין\/ת לקבל קופונים/ });
  await expect(main).toBeChecked();
  await expect(panel(page).getByRole("checkbox", { name: "SMS" })).toBeChecked();
  await expect(panel(page).getByRole("checkbox", { name: "אימייל" })).toBeChecked();

  await panel(page).getByRole("checkbox", { name: "אימייל" }).click(); // the box follows the server's answer, so click (not uncheck) and then wait
  await expect.poll(() => stubs.consentCalls.at(-1)).toEqual({ p_granted: true, p_channels: ["sms"], p_wording_version: "v1" });
  await expect(panel(page).getByRole("checkbox", { name: "SMS" })).toBeDisabled(); // the last channel can't be unticked

  await main.click();
  await expect(panel(page).getByText(/הסרנו אתכם מרשימת הדיוור/)).toBeVisible();
  expect(stubs.consentCalls.at(-1)).toEqual({ p_granted: false, p_channels: null, p_wording_version: "v1" });
  await expect(panel(page).getByRole("checkbox", { name: "SMS" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "היי דנה" })).toBeVisible(); // still a member
  expect(stubs.members.has(E164)).toBe(true);

  await main.click();
  await expect.poll(() => stubs.consentCalls.at(-1)).toEqual({ p_granted: true, p_channels: ["sms", "email"], p_wording_version: "v1" });
});

test("preferences: signing out returns to the login panel", async ({ page }) => {
  await setup(page);
  await page.goto("/account");
  await tab(page, "העדפות").click();
  await panel(page).getByRole("button", { name: "התנתקות מהמכשיר הזה" }).click();
  await expect(page.getByLabel("טלפון נייד")).toBeVisible();
  expect(await readLocalStorage(page, SESSION_KEY)).toBeNull();
  expect(await readLocalStorage(page, HINT_KEY)).toBeNull();
});

test("preferences: deleting the account asks first, then removes it and signs out", async ({ page }) => {
  const stubs = await setup(page);
  await page.goto("/account");
  await tab(page, "העדפות").click();

  await panel(page).getByRole("button", { name: "מחיקת החשבון שלי" }).click();
  expect(stubs.deleteAccountCalls, "nothing happens before the confirmation").toBe(0);
  await panel(page).getByRole("button", { name: "ביטול" }).click();
  await expect(panel(page).getByRole("button", { name: "מחיקת החשבון שלי" })).toBeVisible();

  await panel(page).getByRole("button", { name: "מחיקת החשבון שלי" }).click();
  await panel(page).getByRole("button", { name: "כן, למחוק" }).click();
  await expect(page.getByText(/החשבון נמחק/)).toBeVisible();
  expect(stubs.deleteAccountCalls).toBe(1);
  expect(stubs.members.has(E164)).toBe(false);
  expect(await readLocalStorage(page, SESSION_KEY)).toBeNull();
  expect(await readLocalStorage(page, HINT_KEY)).toBeNull();
});
