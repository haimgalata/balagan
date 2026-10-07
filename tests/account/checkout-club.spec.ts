import { test, expect, buildRpcCatalog, RPC_URL, rpcOk, STOCK_RPC_URL, stockOk, readLocalStorage } from "../catalog/fixtures";
import { stubMemberRpc, type FakeProfile } from "./memberStubs";
import type { Page, Route } from "@playwright/test";

/**
 * Checkout with the club login (test-only mock adapter + stubbed database): the choice BEFORE payment, a member's
 * prefilled one-tap form, saved addresses, the member token on create_order, and every "not really a member" state
 * falling back to the unchanged guest checkout. Runs only in the "account" build (playwright.config.ts).
 */
const CREATE_ORDER_URL = "**/rest/v1/rpc/create_order";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type", "access-control-allow-methods": "*" };
const CART = JSON.stringify([{ productId: "1", option: "package", quantity: 1 }]);
const SESSION_KEY = "balagan-customer-auth";
const HINT_KEY = "balagan_member_hint_v1";
const GUEST_KEY = "balagan_guest_details_v1";
const PHONE = "050-111-2222";
const E164 = "+972501112222";
const MEMBER_TOKEN = `Bearer mock-customer-token.${E164}`;

interface SentOrder {
  authorization: string | undefined;
  body: { p_payload: { customer: Record<string, unknown>; payment_method: string; items: unknown[] }; p_idempotency_key: string };
}

async function setup(page: Page, opts: { members?: Record<string, FakeProfile>; session?: boolean; guestMemory?: Record<string, string> } = {}) {
  const stubs = await stubMemberRpc(page, opts.members ?? {});
  const sent: SentOrder[] = [];
  const events: string[] = [];
  await page.route(RPC_URL, rpcOk(buildRpcCatalog()));
  await page.route(STOCK_RPC_URL, stockOk());
  await page.route(CREATE_ORDER_URL, async (route: Route) => {
    if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    events.push("create_order");
    sent.push({ authorization: route.request().headers()["authorization"], body: JSON.parse(route.request().postData() ?? "{}") });
    await route.fulfill({
      status: 200, headers: CORS, contentType: "application/json",
      body: JSON.stringify({ order_id: "33333333-3333-4333-8333-333333333333", order_number: 1100, order_status: "confirmed", payment_status: "pending", payment_method: "cash", total_cents: 51500, payment_attempt_id: null }),
    });
  });
  page.on("request", (request) => {
    if (/rpc\/join_club/.test(request.url()) && request.method() === "POST") events.push("join_club");
  });
  await page.addInitScript(
    ([cart, sessionKey, withSession, guestKey, guestJson]) => {
      localStorage.setItem("balagan_cart_v2", cart);
      localStorage.setItem("balagan_age_verified", "true");
      if (withSession) localStorage.setItem(sessionKey, JSON.stringify({ accessToken: "mock-customer-token.+972501112222", phoneE164: "+972501112222" }));
      if (guestJson) localStorage.setItem(guestKey, guestJson);
    },
    [CART, SESSION_KEY, opts.session ?? false, GUEST_KEY, opts.guestMemory ? JSON.stringify(opts.guestMemory) : ""] as const
  );
  return { stubs, sent, events };
}

const heading = (page: Page) => page.getByRole("heading", { name: "השלמת פרטי ההזמנה" });
const ageBox = (page: Page) => page.getByRole("checkbox", { name: /מקבל\/ת המשלוח הינו\/ה בן\/בת 18/ });
const termsBox = (page: Page) => page.getByRole("checkbox", { name: /תקנון האתר/ });
const submit = (page: Page) => page.getByRole("button", { name: "לסיום ההזמנה" }).click();

async function fillGuestDetails(page: Page) {
  await page.getByRole("textbox", { name: "שם פרטי" }).fill("ישראל");
  await page.getByRole("textbox", { name: "שם משפחה" }).fill("ישראלי");
  await page.getByRole("textbox", { name: "טלפון" }).fill("0501234567");
  await page.getByRole("combobox", { name: "רחוב" }).fill("הרצל");
  await page.getByRole("textbox", { name: "מספר בית" }).fill("12");
}

test("a guest sees the choice, can ignore it, and orders with no member token", async ({ page }) => {
  const { sent } = await setup(page);
  await page.goto("/checkout");
  await expect(heading(page)).toBeVisible();
  await expect(page.getByText("חברי מועדון בלאגן מזמינים מהר יותר")).toBeVisible();
  await expect(page.getByRole("button", { name: "התחברות / הצטרפות למועדון" })).toBeVisible();

  await fillGuestDetails(page);
  await ageBox(page).check();
  await termsBox(page).check();
  await submit(page);

  await expect(page.getByRole("heading", { name: "ההזמנה התקבלה!" })).toBeVisible();
  expect(sent).toHaveLength(1);
  expect(sent[0].authorization, "a guest's request carries no member token").toBeUndefined();
  expect(sent[0].body.p_payload.customer.terms_accepted).toBe(true);
  expect(await readLocalStorage(page, SESSION_KEY)).toBeNull();
});

test("join BEFORE paying: login in a drawer, the form switches to the member's, and the order carries their token", async ({ page }) => {
  const { stubs, sent, events } = await setup(page, { guestMemory: { firstName: "ישן", street: "הרצל" } });
  await page.goto("/checkout");
  await expect(heading(page)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "שם פרטי" })).toHaveValue("ישן"); // guest memory, while still a guest

  await page.getByRole("button", { name: "התחברות / הצטרפות למועדון" }).click();
  const drawer = page.locator('[role="dialog"][aria-label="התחברות למועדון"]');
  await expect(drawer.getByRole("button", { name: "המשך כאורח" })).toBeVisible();
  await drawer.getByLabel("טלפון נייד").fill(PHONE);
  await drawer.getByRole("button", { name: "שלחו לי קוד" }).click();
  await drawer.getByLabel("קוד אימות").fill("123456");

  // a new phone: the one mandatory confirmation — nothing proceeds without it
  const join = drawer.getByRole("button", { name: "הצטרפות למועדון" });
  await expect(join).toBeDisabled();
  await drawer.getByLabel(/אני מעל גיל 21/).check();
  await join.click();

  // now a member: drawer closed, card says so, phone is locked, the remembered guest details are gone
  await expect(page.getByText("מחוברים כחברי מועדון בלאגן")).toBeVisible();
  await expect(drawer).toBeHidden();
  await expect(page.getByRole("textbox", { name: "טלפון" })).toHaveCount(0);
  await expect(page.locator("form").getByText(PHONE)).toBeVisible();
  await expect(page.getByText("מאומת בהתחברות")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "שם פרטי" })).toHaveValue("");
  expect(await readLocalStorage(page, GUEST_KEY)).toBeNull();
  expect(stubs.addressCalls).toHaveLength(1);

  await page.getByRole("textbox", { name: "שם פרטי" }).fill("דנה");
  await page.getByRole("textbox", { name: "שם משפחה" }).fill("כהן");
  await page.getByRole("combobox", { name: "רחוב" }).fill("הרצל");
  await page.getByRole("textbox", { name: "מספר בית" }).fill("5");
  await ageBox(page).check();
  await termsBox(page).check(); // first order: this member has not accepted the terms yet
  await submit(page);

  await expect(page.getByRole("heading", { name: "ההזמנה התקבלה!" })).toBeVisible();
  expect(events.indexOf("join_club")).toBeGreaterThanOrEqual(0);
  expect(events.indexOf("join_club"), "registration happened BEFORE the order").toBeLessThan(events.indexOf("create_order"));
  expect(sent).toHaveLength(1);
  expect(sent[0].authorization).toBe(MEMBER_TOKEN);
  const customer = sent[0].body.p_payload.customer;
  expect(customer.phone).toBe(PHONE);
  expect(customer.first_name).toBe("דנה");
  expect(customer.age_confirmed).toBe(true);
  expect(Object.keys(sent[0].body.p_payload).sort(), "no customer id is ever sent in the order").toEqual(["customer", "fulfillment_method", "items", "payment_method"]);
  // a member's details are not kept as device memory
  expect(await readLocalStorage(page, GUEST_KEY)).toBeNull();
});

test("a returning member: details, saved address and terms are already done — age confirmation and one tap", async ({ page }) => {
  const { stubs, sent } = await setup(page, {
    session: true,
    members: {
      [E164]: {
        first_name: "דנה", last_name: "כהן", email: "d@x.test", terms_version: "v1",
        addresses: [
          { id: "a1", street: "הרצל", house_number: "12", floor: "2", apartment: "5", intercom_code: "77", notes: "להתקשר" },
          { id: "a2", street: "בן גוריון", house_number: "10" },
        ],
      },
    },
  });
  await page.goto("/checkout");
  await expect(heading(page)).toBeVisible();

  await expect(page.getByText("היי דנה, מחוברים כחברי מועדון בלאגן")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "שם פרטי" })).toHaveValue("דנה");
  await expect(page.getByRole("textbox", { name: "שם משפחה" })).toHaveValue("כהן");
  await expect(page.getByRole("textbox", { name: /אימייל/ })).toHaveValue("d@x.test");
  await expect(page.getByText("משלוח אל")).toBeVisible();
  await expect(page.getByText("הרצל 12")).toBeVisible();
  await expect(page.getByText("קומה 2 · דירה 5")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "מספר בית" })).toHaveCount(0); // the full address fields are folded away
  await expect(termsBox(page)).toHaveCount(0); // current terms version already accepted
  await expect(ageBox(page), "18+ is confirmed on EVERY order, members included").toBeVisible();

  // not ticking the age box still blocks the order
  await submit(page);
  await expect(page.getByText("יש לאשר את הצהרת הגיל כדי להמשיך")).toBeVisible();
  expect(sent).toHaveLength(0);

  await ageBox(page).check();
  await submit(page);
  await expect(page.getByRole("heading", { name: "ההזמנה התקבלה!" })).toBeVisible();

  expect(stubs.addressCalls).toHaveLength(1);
  expect(sent).toHaveLength(1);
  expect(sent[0].authorization).toBe(MEMBER_TOKEN);
  expect(sent[0].body.p_payload.customer).toMatchObject({
    first_name: "דנה", last_name: "כהן", phone: PHONE, email: "d@x.test", street: "הרצל", house_number: "12",
    floor: "2", apartment: "5", intercom_code: "77", notes: "להתקשר", age_confirmed: true, terms_accepted: true,
  });
});

test("a member can switch to another saved address, or type a new one", async ({ page }) => {
  const { sent } = await setup(page, {
    session: true,
    members: { [E164]: { first_name: "דנה", last_name: "כהן", terms_version: "v1", addresses: [{ id: "a1", street: "הרצל", house_number: "12" }, { id: "a2", street: "בן גוריון", house_number: "10", entrance: "ב" }] } },
  });
  await page.goto("/checkout");
  await expect(page.getByText("הרצל 12")).toBeVisible();

  await page.getByRole("button", { name: "שינוי" }).click();
  await expect(page.getByRole("radio")).toHaveCount(3); // two saved + "new"
  await page.getByRole("radio", { name: /בן גוריון 10/ }).click();
  await expect(page.getByText("בן גוריון 10")).toBeVisible();
  await expect(page.getByText("כניסה ב")).toBeVisible();
  await ageBox(page).check();
  await submit(page);
  await expect(page.getByRole("heading", { name: "ההזמנה התקבלה!" })).toBeVisible();
  expect(sent[0].body.p_payload.customer).toMatchObject({ street: "בן גוריון", house_number: "10", entrance: "ב" });
});

test("choosing 'new address' shows the full fields, with a way back to the saved ones", async ({ page }) => {
  await setup(page, {
    session: true,
    members: { [E164]: { first_name: "דנה", last_name: "כהן", terms_version: "v1", addresses: [{ id: "a1", street: "הרצל", house_number: "12" }] } },
  });
  await page.goto("/checkout");
  await page.getByRole("button", { name: "שינוי" }).click();
  await page.getByRole("radio", { name: "כתובת חדשה" }).click();
  await expect(page.getByRole("combobox", { name: "רחוב" })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "מספר בית" })).toBeVisible();
  await page.getByRole("button", { name: "בחירה מכתובת שמורה" }).click();
  await expect(page.getByRole("radio")).toHaveCount(2);
});

test("a member with no saved address yet sees the normal address fields", async ({ page }) => {
  await setup(page, { session: true, members: { [E164]: { first_name: "דנה", last_name: "כהן", terms_version: "v1" } } });
  await page.goto("/checkout");
  await expect(page.getByText("היי דנה, מחוברים כחברי מועדון בלאגן")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "רחוב" })).toBeVisible();
  await expect(page.getByRole("button", { name: "בחירה מכתובת שמורה" })).toHaveCount(0);
});

test("a verified phone that never joined orders as a guest: ordinary form, no member token", async ({ page }) => {
  const { sent } = await setup(page, { session: true, members: {} });
  await page.goto("/checkout");
  await expect(page.getByText("ההצטרפות למועדון לא הושלמה")).toBeVisible();
  await fillGuestDetails(page);
  await ageBox(page).check();
  await termsBox(page).check();
  await submit(page);
  await expect(page.getByRole("heading", { name: "ההזמנה התקבלה!" })).toBeVisible();
  expect(sent[0].authorization).toBeUndefined();
});

test("if the member profile cannot be loaded, checkout falls back to the guest form and says so — then retry works", async ({ page }) => {
  const { stubs, sent } = await setup(page, {
    session: true,
    members: { [E164]: { first_name: "דנה", last_name: "כהן", terms_version: "v1" } },
  });
  stubs.failProfile = true;
  await page.goto("/checkout");
  await expect(page.getByText("לא הצלחנו לטעון את פרטי החבר")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "טלפון" })).toBeVisible(); // ordinary guest form

  stubs.failProfile = false;
  await page.getByRole("button", { name: "נסו שוב" }).click();
  await expect(page.getByText("היי דנה, מחוברים כחברי מועדון בלאגן")).toBeVisible();
  expect(sent).toHaveLength(0);
});

test("signing out at checkout returns to the guest form", async ({ page }) => {
  await setup(page, { session: true, members: { [E164]: { first_name: "דנה", last_name: "כהן", terms_version: "v1" } } });
  await page.goto("/checkout");
  await expect(page.getByText("היי דנה, מחוברים כחברי מועדון בלאגן")).toBeVisible();
  await page.getByRole("button", { name: "התנתקות" }).click();
  await expect(page.getByRole("button", { name: "התחברות / הצטרפות למועדון" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "טלפון" })).toBeVisible();
  expect(await readLocalStorage(page, SESSION_KEY)).toBeNull();
  expect(await readLocalStorage(page, HINT_KEY)).toBeNull();
});
