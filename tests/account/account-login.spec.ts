import { test, expect, gotoReady, readLocalStorage } from "../catalog/fixtures";
import { stubMemberRpc } from "./memberStubs";
import type { Page } from "@playwright/test";

/**
 * The club login flow AFTER authentication, against the test-only mock login adapter (code 123456) and a stateful
 * fake of the member RPCs: phone -> code -> (new phone: the one mandatory confirmation) -> member. Runs only in the
 * "account" build (playwright.config.ts) — production builds contain none of this code.
 */
const DRAWER = '[role="dialog"][aria-label="אזור אישי"]';
const HINT_KEY = "balagan_member_hint_v1";
const SESSION_KEY = "balagan-customer-auth";
const PHONE = "050-111-2222";
const E164 = "+972501112222";

const openAccount = async (page: Page) => {
  await page.getByRole("button", { name: /אזור אישי|התחברות/ }).first().click();
  const drawer = page.locator(DRAWER);
  await expect(drawer).toBeVisible();
  return drawer;
};

async function loginWithCode(page: Page, phone = PHONE) {
  const drawer = page.locator(DRAWER);
  await drawer.getByLabel("טלפון נייד").fill(phone);
  await drawer.getByRole("button", { name: "שלחו לי קוד" }).click();
  await expect(drawer.getByLabel("קוד אימות")).toBeVisible();
  await drawer.getByLabel("קוד אימות").fill("123456");
}

test("a guest's drawer asks for a phone and makes no member calls", async ({ page }) => {
  const stubs = await stubMemberRpc(page);
  await gotoReady(page);
  const drawer = await openAccount(page);
  await expect(drawer.getByText("התחברות / הצטרפות למועדון בלאגן")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "שלחו לי קוד" })).toBeDisabled();
  expect(stubs.profileCalls, "no session -> nothing to ask the database").toEqual([]);
  expect(await readLocalStorage(page, HINT_KEY)).toBeNull();
});

test("a new phone: code, then ONE mandatory confirmation, then member — and it survives a reload", async ({ page }) => {
  const stubs = await stubMemberRpc(page);
  await gotoReady(page);
  const drawer = await openAccount(page);

  // phone validation: Israeli mobile only
  await drawer.getByLabel("טלפון נייד").fill("08-994-5190");
  await drawer.getByRole("button", { name: "שלחו לי קוד" }).click();
  await expect(drawer.getByRole("alert")).toContainText("מספר טלפון נייד תקין");

  await drawer.getByLabel("טלפון נייד").fill(PHONE);
  await drawer.getByRole("button", { name: "שלחו לי קוד" }).click();
  await expect(drawer.getByText("050-111-2222")).toBeVisible();

  // wrong code is refused and the field is cleared for another try
  await drawer.getByLabel("קוד אימות").fill("000000");
  await expect(drawer.getByRole("alert")).toContainText("הקוד שגוי");
  await expect(drawer.getByLabel("קוד אימות")).toHaveValue("");

  // the right code submits by itself at 6 digits
  await drawer.getByLabel("קוד אימות").fill("123456");
  await expect(drawer.getByText("עוד אישור אחד")).toBeVisible();
  expect(stubs.profileCalls.length).toBe(1);

  // the mandatory confirmation gates the join button
  const join = drawer.getByRole("button", { name: "הצטרפות למועדון" });
  await expect(join).toBeDisabled();
  await expect(drawer.getByLabel(/אני מעל גיל 21/)).not.toBeChecked();
  await drawer.getByLabel(/אני מעל גיל 21/).check();
  await join.click();

  await expect(drawer.getByText(/ברוכים הבאים למועדון בלאגן/)).toBeVisible();
  await expect(drawer.getByText("050-111-2222")).toBeVisible();

  // what was sent: both confirmations, the wording version — and NO phone or personal details
  expect(stubs.joinPayloads).toHaveLength(1);
  expect(stubs.joinPayloads[0]).toEqual({
    age_21_confirmed: true,
    marketing_consent: true,
    wording_version: "v1",
    channels: ["sms", "email"],
    source: "registration",
  });
  expect(stubs.members.has(E164)).toBe(true);

  // the header knows — without any token in the hint
  expect(await readLocalStorage(page, HINT_KEY)).toBe('{"firstName":null}');
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "אזור אישי: היי" }).first()).toBeVisible();

  // reload: still a member, no phone form
  await page.reload();
  await page.locator("div.snap-start").first().waitFor({ state: "attached" });
  const again = await openAccount(page);
  await expect(again.getByText(/ברוכים הבאים למועדון בלאגן/)).toBeVisible();
  await expect(again.getByLabel("טלפון נייד")).toHaveCount(0);

  // signing out forgets everything
  await again.getByRole("button", { name: "התנתקות" }).click();
  await expect(again.getByLabel("טלפון נייד")).toBeVisible();
  expect(await readLocalStorage(page, HINT_KEY)).toBeNull();
  expect(await readLocalStorage(page, SESSION_KEY)).toBeNull();
});

test("an existing member goes straight in: no confirmation, no join call, greeted by name", async ({ page }) => {
  const stubs = await stubMemberRpc(page, { [E164]: { first_name: "דנה" } });
  await gotoReady(page);
  const drawer = await openAccount(page);
  await loginWithCode(page);

  await expect(drawer.getByText("היי דנה, ברוכים הבאים למועדון בלאגן")).toBeVisible();
  expect(stubs.joinPayloads).toEqual([]);
  expect(await readLocalStorage(page, HINT_KEY)).toBe('{"firstName":"דנה"}');
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "אזור אישי: היי דנה" }).first()).toBeVisible();
});

test("declining the confirmation leaves the visitor a guest, with nothing stored", async ({ page }) => {
  const stubs = await stubMemberRpc(page);
  await gotoReady(page);
  const drawer = await openAccount(page);
  await loginWithCode(page);
  await expect(drawer.getByText("עוד אישור אחד")).toBeVisible();

  await drawer.getByRole("button", { name: "לא עכשיו, אמשיך כאורח" }).click();
  await expect(drawer.getByLabel("טלפון נייד")).toBeVisible();
  expect(stubs.joinPayloads).toEqual([]);
  expect(stubs.members.size).toBe(0);
  expect(await readLocalStorage(page, SESSION_KEY)).toBeNull();
  expect(await readLocalStorage(page, HINT_KEY)).toBeNull();
});

test("if the profile cannot be loaded the visitor is NOT shown as a member, and can retry", async ({ page }) => {
  const stubs = await stubMemberRpc(page, { [E164]: { first_name: "דנה" } });
  stubs.failProfile = true;
  await gotoReady(page);
  const drawer = await openAccount(page);
  await loginWithCode(page);

  await expect(drawer.getByRole("alert")).toContainText("משהו השתבש");
  await expect(drawer.getByText(/ברוכים הבאים/)).toHaveCount(0);
  expect(await readLocalStorage(page, HINT_KEY)).toBeNull();

  stubs.failProfile = false;
  await drawer.getByRole("button", { name: "נסו שוב" }).click();
  await expect(drawer.getByText("היי דנה, ברוכים הבאים למועדון בלאגן")).toBeVisible();
});

test("a stored session the database no longer accepts is dropped quietly", async ({ page }) => {
  await stubMemberRpc(page);
  await page.addInitScript(
    ([key, hint]) => {
      localStorage.setItem(key, JSON.stringify({ accessToken: "expired-token", phoneE164: "+972501112222" }));
      localStorage.setItem(hint, '{"firstName":"דנה"}');
    },
    [SESSION_KEY, HINT_KEY] as const
  );
  await gotoReady(page);
  const drawer = await openAccount(page);
  await expect(drawer.getByLabel("טלפון נייד")).toBeVisible();
  await expect.poll(() => readLocalStorage(page, SESSION_KEY)).toBeNull();
  await expect.poll(() => readLocalStorage(page, HINT_KEY)).toBeNull();
});

test("a code that verifies but whose session the database refuses is reported — the form never freezes on a spinner", async ({ page }) => {
  // This is what happens when the mock login is pointed at a REAL Supabase project: its fake token is rejected with 401.
  await stubMemberRpc(page);
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, apikey, content-type", "access-control-allow-methods": "*" };
  await page.route("**/rest/v1/rpc/get_my_customer", (route) =>
    route.request().method() === "OPTIONS"
      ? route.fulfill({ status: 204, headers: cors })
      : route.fulfill({ status: 401, headers: cors, contentType: "application/json", body: JSON.stringify({ message: "JWT invalid" }) })
  );
  await gotoReady(page);
  const drawer = await openAccount(page);
  await loginWithCode(page);

  await expect(drawer.getByRole("alert")).toContainText("לא הצלחנו להתחבר לשירות");
  await expect(drawer.getByLabel("קוד אימות")).toBeEnabled(); // usable again, not stuck busy
  await expect(drawer.getByRole("button", { name: "אישור" })).toBeDisabled(); // (empty code) but not showing a spinner
  expect(await readLocalStorage(page, SESSION_KEY)).toBeNull();
  expect(await readLocalStorage(page, HINT_KEY)).toBeNull();
});
