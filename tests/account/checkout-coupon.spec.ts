import { test, expect, buildRpcCatalog, RPC_URL, rpcOk, STOCK_RPC_URL, stockOk } from "../catalog/fixtures";
import { stubMemberRpc, type FakeProfile } from "./memberStubs";
import { fallbackBusinessSettings } from "../../src/storefront/data/fallbackBusinessSettings";
import type { Page, Route } from "@playwright/test";

/**
 * Coupons in checkout (club build: test-only mock login + stubbed database). The database decides everything — here a
 * stub plays its part just enough to prove the UI's behaviour: a coupon area EVERYONE sees but only an active member can
 * use; the code normalized before it is sent; the discount shown but never granted by the page; the coupon re-checked
 * right before the order and dropped (never auto-submitted) when it stops holding; a server refusal explained; and an
 * order that carries only the code — never an amount. Runs only in the "account" build (playwright.config.ts).
 */
const CREATE_ORDER_URL = "**/rest/v1/rpc/create_order";
const PREVIEW_URL = "**/rest/v1/rpc/preview_coupon";
const SETTINGS_URL = "**/rest/v1/rpc/get_business_settings";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type", "access-control-allow-methods": "*" };
const CART = JSON.stringify([{ productId: "1", option: "package", quantity: 1 }]); // one pack: ₪500, delivery ₪15
const SESSION_KEY = "balagan-customer-auth";
const E164 = "+972501112222";
const MEMBER_TOKEN = `Bearer mock-customer-token.${E164}`;
const MEMBER: Record<string, FakeProfile> = { [E164]: { first_name: "דנה", last_name: "כהן", terms_version: "v1", addresses: [{ id: "a1", street: "הרצל", house_number: "12" }] } };

interface PreviewCall { authorization: string | undefined; code: string; subtotal: number }
interface SentOrder { authorization: string | undefined; payload: { coupon_code?: string; customer: Record<string, unknown> } }

/** The database's answer for each code the stub knows (a stand-in for preview_coupon / create_order's own check). */
type Verdict = { valid: true; code: string; title: string; discount_type: string; discount_cents: number } | { valid: false; reason: string; min_subtotal_cents?: number };
const verdictFor = (code: string, subtotal: number): Verdict => {
  if (code === "CLUB20") return { valid: true, code, title: "הנחת מועדון", discount_type: "percent", discount_cents: Math.floor(subtotal * 0.2) };
  if (code === "FREESHIP") return { valid: true, code, title: "משלוח חינם", discount_type: "free_delivery", discount_cents: 1500 };
  if (code === "BIGSPENDER") return { valid: false, reason: "COUPON_MIN_ORDER", min_subtotal_cents: 90000 };
  if (code === "ONCEONLY") return { valid: false, reason: "COUPON_ALREADY_USED" };
  return { valid: false, reason: "COUPON_INVALID" };
};

async function setup(page: Page, opts: { members?: Record<string, FakeProfile>; session?: boolean; offerText?: string | null } = {}) {
  const stubs = await stubMemberRpc(page, opts.members ?? {});
  const previews: PreviewCall[] = [];
  const sent: SentOrder[] = [];
  const control = {
    /** codes the "database" refuses from now on, with the reason */
    refuse: new Map<string, string>(),
    /** refuse the coupon only when the ORDER is created (preview still says yes) */
    refuseAtOrder: null as string | null,
  };
  await page.route(RPC_URL, rpcOk(buildRpcCatalog()));
  await page.route(STOCK_RPC_URL, stockOk());
  await page.route(SETTINGS_URL, async (route: Route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    await route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify({ ...fallbackBusinessSettings, club_offer_text: opts.offerText ?? null }) });
  });
  await page.route(PREVIEW_URL, async (route: Route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const authorization = route.request().headers()["authorization"];
    const body = JSON.parse(route.request().postData() ?? "{}") as { p_code: string; p_subtotal_cents: number };
    previews.push({ authorization, code: body.p_code, subtotal: body.p_subtotal_cents });
    const refusal = control.refuse.get(body.p_code);
    const verdict: Verdict = refusal ? { valid: false, reason: refusal } : verdictFor(body.p_code, body.p_subtotal_cents);
    await route.fulfill({ status: 200, headers: CORS, contentType: "application/json", body: JSON.stringify(verdict) });
  });
  await page.route(CREATE_ORDER_URL, async (route: Route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const body = JSON.parse(route.request().postData() ?? "{}") as { p_payload: SentOrder["payload"] };
    sent.push({ authorization: route.request().headers()["authorization"], payload: body.p_payload });
    const code = body.p_payload.coupon_code;
    if (code && control.refuseAtOrder) {
      return route.fulfill({ status: 400, headers: CORS, contentType: "application/json", body: JSON.stringify({ code: "P0001", message: control.refuseAtOrder }) });
    }
    const v = code ? verdictFor(code, 50000) : null;
    const discount = v && v.valid ? v.discount_cents : 0;
    await route.fulfill({
      status: 200, headers: CORS, contentType: "application/json",
      body: JSON.stringify({ order_id: "33333333-3333-4333-8333-333333333333", order_number: 1100, order_status: "confirmed", payment_status: "pending", payment_method: "cash", total_cents: 51500 - discount, discount_cents: discount, payment_attempt_id: null }),
    });
  });
  await page.addInitScript(
    ([cart, sessionKey, withSession]) => {
      localStorage.setItem("balagan_cart_v2", cart);
      localStorage.setItem("balagan_age_verified", "true");
      if (withSession) localStorage.setItem(sessionKey, JSON.stringify({ accessToken: "mock-customer-token.+972501112222", phoneE164: "+972501112222" }));
    },
    [CART, SESSION_KEY, opts.session ?? false] as const
  );
  return { stubs, previews, sent, control };
}

const heading = (page: Page) => page.getByRole("heading", { name: "השלמת פרטי ההזמנה" });
const ageBox = (page: Page) => page.getByRole("checkbox", { name: /מקבל\/ת המשלוח הינו\/ה בן\/בת 18/ });
const submit = (page: Page) => page.getByRole("button", { name: "לסיום ההזמנה" }).click();
const total = (page: Page) => page.getByText("סה\"כ לתשלום").locator("xpath=following-sibling::span[1]");
const codeInput = (page: Page) => page.getByLabel("יש לכם קוד קופון?");
const apply = async (page: Page, code: string) => {
  await codeInput(page).fill(code);
  await page.getByRole("button", { name: "החלה" }).click();
};

async function openAsMember(page: Page) {
  const ctx = await setup(page, { session: true, members: MEMBER });
  await page.goto("/checkout");
  await expect(heading(page)).toBeVisible();
  await expect(page.getByText("היי דנה, מחוברים כחברי מועדון בלאגן")).toBeVisible();
  return ctx;
}

test("a guest SEES the coupon area, locked, with the club message and a way to join — and can order without it", async ({ page }) => {
  const { previews, sent } = await setup(page);
  await page.goto("/checkout");
  await expect(heading(page)).toBeVisible();
  const locked = page.getByTestId("coupon-locked");
  await expect(locked).toBeVisible();
  await expect(locked).toContainText("קופונים הם הטבה לחברי מועדון בלאגן.");
  await expect(locked.getByRole("textbox", { name: "קוד קופון (למועדון בלבד)" })).toBeDisabled();
  await expect(codeInput(page)).toHaveCount(0); // no working input at all
  await expect(total(page)).toHaveText("₪515");

  await locked.getByRole("button", { name: "כניסה למועדון לשימוש בקופון" }).click();
  await expect(page.locator('[role="dialog"][aria-label="התחברות למועדון"]').getByLabel("טלפון נייד")).toBeVisible(); // the same sign-in drawer

  // closing it and ordering as a guest works exactly as before, with no coupon in the request
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "שם פרטי" }).fill("ישראל");
  await page.getByRole("textbox", { name: "שם משפחה" }).fill("ישראלי");
  await page.getByRole("textbox", { name: "טלפון" }).fill("0501234567");
  await page.getByRole("combobox", { name: "רחוב" }).fill("הרצל");
  await page.getByRole("textbox", { name: "מספר בית" }).fill("12");
  await ageBox(page).check();
  await page.getByRole("checkbox", { name: /תקנון האתר/ }).check();
  await submit(page);
  await expect(page.getByRole("heading", { name: "ההזמנה התקבלה!" })).toBeVisible();
  expect(sent[0].payload, "a guest's order carries no coupon").not.toHaveProperty("coupon_code");
  expect(previews, "a guest never reaches the preview").toHaveLength(0);
});

test("the owner's one-line offer replaces the default wording for guests", async ({ page }) => {
  await setup(page, { offerText: "חברי מועדון: 10% הנחה השבוע" });
  await page.goto("/checkout");
  await expect(page.getByTestId("coupon-locked")).toContainText("חברי מועדון: 10% הנחה השבוע");
  await expect(page.getByTestId("coupon-locked")).not.toContainText("קופונים הם הטבה לחברי מועדון בלאגן.");
});

test("a verified phone that has not joined yet is locked too, and is invited to finish joining", async ({ page }) => {
  await setup(page, { session: true, members: {} });
  await page.goto("/checkout");
  await expect(page.getByTestId("coupon-locked").getByRole("button", { name: "סיום הצטרפות לשימוש בקופון" })).toBeVisible();
  await expect(codeInput(page)).toHaveCount(0);
});

test("a member applies a code: it is normalized, sent with THEIR token, and the discount shows as its own line", async ({ page }) => {
  const { previews } = await openAsMember(page);
  await expect(page.getByTestId("coupon-form")).toBeVisible();
  await apply(page, " club 20 ");

  await expect(page.getByTestId("coupon-applied")).toContainText("CLUB20");
  await expect(page.getByTestId("coupon-applied")).toContainText("הנחת מועדון");
  await expect(page.getByTestId("coupon-applied")).toContainText("חיסכון של ₪100");
  await expect(page.getByTestId("coupon-discount-line")).toContainText("-₪100");
  await expect(total(page)).toHaveText("₪415"); // ₪500 − ₪100 + ₪15 delivery
  expect(previews[0]).toMatchObject({ authorization: MEMBER_TOKEN, code: "CLUB20", subtotal: 50000 });
});

test("a refused code is explained in words and nothing changes", async ({ page }) => {
  await openAsMember(page);
  await apply(page, "NOPE");
  await expect(page.getByRole("alert").filter({ hasText: "קוד הקופון אינו תקין" })).toBeVisible();
  await expect(total(page)).toHaveText("₪515");

  await apply(page, "bigspender");
  await expect(page.getByRole("alert").filter({ hasText: "הקופון תקף להזמנה מסכום של ₪900 ומעלה." })).toBeVisible();
  await apply(page, "onceonly");
  await expect(page.getByRole("alert").filter({ hasText: "כבר מימשתם את הקופון הזה." })).toBeVisible();
  await expect(page.getByTestId("coupon-applied")).toHaveCount(0);
});

test("a Hebrew-layout typing mistake is spotted", async ({ page }) => {
  await openAsMember(page);
  await codeInput(page).fill("קוד");
  await expect(page.getByText("בדקו את שפת המקלדת")).toBeVisible();
});

test("free delivery: the delivery line shows it waived and the items total is unchanged", async ({ page }) => {
  await openAsMember(page);
  await apply(page, "FREESHIP");
  await expect(page.getByTestId("coupon-applied")).toContainText("משלוח חינם");
  await expect(page.getByText("חינם (קופון)")).toBeVisible();
  await expect(page.getByTestId("coupon-discount-line")).toHaveCount(0);
  await expect(total(page)).toHaveText("₪500"); // items ₪500 + delivery waived
});

test("the order carries only the CODE and the member token — never an amount — and the success screen shows the saving", async ({ page }) => {
  const { sent } = await openAsMember(page);
  await apply(page, "CLUB20");
  await expect(page.getByTestId("coupon-applied")).toBeVisible();
  await ageBox(page).check();
  await submit(page);

  await expect(page.getByRole("heading", { name: "ההזמנה התקבלה!" })).toBeVisible();
  await expect(page.getByText("כולל הנחת מועדון בסך ₪100.")).toBeVisible();
  await expect(page.getByText("₪415")).toBeVisible(); // what the database said was due: 515 − 100
  expect(sent).toHaveLength(1);
  expect(sent[0].authorization).toBe(MEMBER_TOKEN);
  expect(sent[0].payload.coupon_code).toBe("CLUB20");
  expect(Object.keys(sent[0].payload).sort(), "no discount, total or coupon id is ever sent").toEqual(["coupon_code", "customer", "items", "payment_method"]);
});

test("removing the coupon restores the total and the next order has no coupon", async ({ page }) => {
  const { sent } = await openAsMember(page);
  await apply(page, "CLUB20");
  await expect(total(page)).toHaveText("₪415");
  await page.getByRole("button", { name: "הסרת הקופון" }).click();
  await expect(total(page)).toHaveText("₪515");
  await expect(page.getByTestId("coupon-form")).toBeVisible();
  await ageBox(page).check();
  await submit(page);
  await expect(page.getByRole("heading", { name: "ההזמנה התקבלה!" })).toBeVisible();
  expect(sent[0].payload).not.toHaveProperty("coupon_code");
});

test("the discount follows the cart: a bigger basket re-prices it, and one that falls under the coupon's minimum drops it", async ({ page }) => {
  const { previews, control } = await openAsMember(page);
  await apply(page, "CLUB20");
  await expect(total(page)).toHaveText("₪415");

  await page.getByRole("button", { name: /^הוסף / }).first().click(); // two packs
  await expect(page.getByTestId("coupon-discount-line")).toContainText("-₪200");
  await expect(total(page)).toHaveText("₪815");
  expect(previews.at(-1)!.subtotal).toBe(100000);

  control.refuse.set("CLUB20", "COUPON_MIN_ORDER");
  await page.getByRole("button", { name: /^הפחת / }).first().click();
  await expect(page.getByTestId("coupon-applied")).toHaveCount(0);
  await expect(page.getByRole("alert").filter({ hasText: "הקופון תקף להזמנה בסכום גבוה יותר." })).toBeVisible();
  await expect(total(page)).toHaveText("₪515");
});

test("a coupon that stops holding before the order is dropped with the new total — the order is NOT sent until the customer confirms again", async ({ page }) => {
  const { sent, control } = await openAsMember(page);
  await apply(page, "CLUB20");
  await expect(total(page)).toHaveText("₪415");
  await ageBox(page).check();

  control.refuse.set("CLUB20", "COUPON_EXHAUSTED"); // someone took the last use meanwhile
  await submit(page);
  await expect(page.getByText("הקופון שהוחל כבר אינו תקף והוסר, והסכום עודכן.")).toBeVisible();
  await expect(page.getByRole("alert").filter({ hasText: "הקופון מוצה ואינו זמין עוד." })).toBeVisible();
  await expect(total(page)).toHaveText("₪515");
  expect(sent, "nothing was ordered for a discount the customer no longer has").toHaveLength(0);

  await submit(page); // the customer saw the new total and confirms
  await expect(page.getByRole("heading", { name: "ההזמנה התקבלה!" })).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0].payload).not.toHaveProperty("coupon_code");
});

test("if the database refuses the coupon while creating the order, it is dropped and explained", async ({ page }) => {
  const { sent, control } = await openAsMember(page);
  await apply(page, "CLUB20");
  await ageBox(page).check();
  control.refuseAtOrder = "COUPON_ALREADY_USED";
  await submit(page);
  await expect(page.getByRole("alert").filter({ hasText: "כבר מימשתם את הקופון הזה." }).first()).toBeVisible();
  await expect(page.getByTestId("coupon-applied")).toHaveCount(0);
  await expect(total(page)).toHaveText("₪515");
  await expect(page.getByRole("heading", { name: "ההזמנה התקבלה!" })).toHaveCount(0);
  expect(sent).toHaveLength(1);
});

test("signing out takes the coupon with it and locks the area again", async ({ page }) => {
  await openAsMember(page);
  await apply(page, "CLUB20");
  await expect(total(page)).toHaveText("₪415");
  await page.getByRole("button", { name: "התנתקות" }).click();
  await expect(page.getByTestId("coupon-locked")).toBeVisible();
  await expect(total(page)).toHaveText("₪515");
});
