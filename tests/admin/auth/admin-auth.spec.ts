import { test, expect, FIXED_NOW } from "./adminFixtures";
import { ADMIN_STORAGE_KEY, ADMIN_USER, PLAIN_USER, seedSession, sessionFor, stubSupabase } from "./adminStubs";
import type { Page } from "@playwright/test";

/**
 * The private admin area (/admin): login, the is_admin() guard, sessions, logout, idle logout.
 * Runs against the app variant built for a fake Supabase host; the fake answers Auth, is_admin() and the
 * admin-only tables inside the browser, so no real credentials are involved. What is truly PROTECTED is
 * enforced by the database (see scripts/security-test.mjs) — these tests check the screens and the flow.
 */
test.beforeEach(({ mode }) => {
  test.skip(mode !== "supabase", "admin tests use the stubbed-database variant");
});

const login = async (page: Page, email: string, password: string) => {
  await page.getByLabel("אימייל").fill(email);
  await page.getByLabel("סיסמה", { exact: true }).fill(password);
  await page.getByRole("button", { name: "התחברות" }).click();
};
const storedSession = (page: Page) => page.evaluate((key) => localStorage.getItem(key), ADMIN_STORAGE_KEY);

test.describe("the login screen", () => {
  test("/admin shows the login form, is noindex, and asks the database nothing before login", async ({ page }) => {
    const stub = await stubSupabase(page);
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "כניסה לניהול" })).toBeVisible();
    await expect(page.getByLabel("אימייל")).toBeVisible();
    await expect(page.getByLabel("סיסמה", { exact: true })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page).toHaveTitle("ניהול · בלאגן");
    // no sign-up, no password reset, no admin data on screen
    await expect(page.getByText(/הרשמה|שכחתי|Sign up/i)).toHaveCount(0);
    expect(stub.tableCalls()).toHaveLength(0);
    expect(stub.to("/rest/v1/rpc/is_admin")).toHaveLength(0);
    // the storefront never mounted here
    await expect(page.locator("div.snap-start")).toHaveCount(0);
  });

  test("password manager friendly fields, and the password can be revealed", async ({ page }) => {
    await stubSupabase(page);
    await page.goto("/admin");
    await expect(page.getByLabel("אימייל")).toHaveAttribute("autocomplete", "username");
    const password = page.getByLabel("סיסמה", { exact: true });
    await expect(password).toHaveAttribute("autocomplete", "current-password");
    await expect(password).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "הצג סיסמה" }).click();
    await expect(password).toHaveAttribute("type", "text");
    await page.getByRole("button", { name: "הסתר סיסמה" }).click();
    await expect(password).toHaveAttribute("type", "password");
  });
});

test.describe("logging in", () => {
  test("the admin gets the dashboard, with numbers read from the admin-only tables", async ({ page }) => {
    const stub = await stubSupabase(page);
    await page.goto("/admin");
    await login(page, ADMIN_USER.email, ADMIN_USER.password);

    await expect(page.getByRole("heading", { name: "סקירה" })).toBeVisible();
    await expect(page.getByTestId("admin-email").or(page.getByText(ADMIN_USER.email))).toBeVisible();
    await expect(page.locator("dd")).toHaveText(["2", "32", "141"]);
    await expect(page.getByRole("button", { name: "התנתקות" })).toBeVisible();
    // Categories and Products are both real pages now — nothing left showing "soon"
    await expect(page.getByRole("link", { name: "קטגוריות" })).toBeVisible();
    await expect(page.getByRole("link", { name: "מוצרים" })).toBeVisible();
    await expect(page.getByText("בקרוב")).toHaveCount(0);

    // the guard asked the database, and every data request carried the admin's own token (never the anon key)
    expect(stub.to("/rest/v1/rpc/is_admin")).toHaveLength(1);
    expect(stub.tableCalls().length).toBeGreaterThanOrEqual(3);
    for (const call of stub.tableCalls()) expect(call.sub).toBe(ADMIN_USER.id);
    expect(await storedSession(page)).not.toBeNull();
  });

  test("wrong password and unknown email give the SAME generic message (no user enumeration)", async ({ page }) => {
    await stubSupabase(page);
    await page.goto("/admin");

    await login(page, ADMIN_USER.email, "not-the-password");
    const alert = page.getByRole("alert");
    await expect(alert).toHaveText("האימייל או הסיסמה שגויים.");
    const wrongPassword = await alert.innerText();

    await login(page, "nobody@example.test", "whatever-123");
    await expect(alert).toHaveText("האימייל או הסיסמה שגויים.");
    expect(await alert.innerText()).toBe(wrongPassword);

    await expect(page.getByRole("heading", { name: "סקירה" })).toHaveCount(0);
    expect(await storedSession(page)).toBeNull();
  });

  test("a valid account that is NOT an admin is refused and signed out immediately", async ({ page }) => {
    const stub = await stubSupabase(page);
    await page.goto("/admin");
    await login(page, PLAIN_USER.email, PLAIN_USER.password);

    await expect(page.getByText("החשבון הזה אינו מורשה לניהול.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "כניסה לניהול" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "סקירה" })).toHaveCount(0);
    expect(stub.to("/auth/v1/logout").length).toBeGreaterThanOrEqual(1); // the session was revoked
    expect(await storedSession(page)).toBeNull(); // nothing left in the browser
    expect(stub.tableCalls()).toHaveLength(0); // never even asked for admin data
  });

  test("connection problems and rate limits get their own messages", async ({ page }) => {
    await stubSupabase(page, { loginFailure: "network" });
    await page.goto("/admin");
    await login(page, ADMIN_USER.email, ADMIN_USER.password);
    await expect(page.getByRole("alert")).toHaveText("אין חיבור לשרת. בדקו את החיבור ונסו שוב.");

    await page.unroute(/stub\.supabase\.test/);
    await stubSupabase(page, { loginFailure: 429 });
    await login(page, ADMIN_USER.email, ADMIN_USER.password);
    await expect(page.getByRole("alert")).toHaveText("יותר מדי ניסיונות התחברות. נסו שוב בעוד מספר דקות.");
  });

  test("the form is locked while logging in (no double submit)", async ({ page }) => {
    const stub = await stubSupabase(page, { loginDelayMs: 1200 });
    await page.goto("/admin");
    await login(page, ADMIN_USER.email, ADMIN_USER.password);
    await expect(page.getByRole("button", { name: "מתחבר…" })).toBeDisabled();
    await expect(page.getByRole("heading", { name: "סקירה" })).toBeVisible();
    expect(stub.to("/auth/v1/token")).toHaveLength(1);
  });
});

test.describe("sessions", () => {
  test("a session survives a reload, and is re-verified with is_admin() each time", async ({ page }) => {
    const stub = await stubSupabase(page);
    await page.goto("/admin");
    await login(page, ADMIN_USER.email, ADMIN_USER.password);
    await expect(page.getByRole("heading", { name: "סקירה" })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("heading", { name: "סקירה" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "כניסה לניהול" })).toHaveCount(0);
    expect(stub.to("/rest/v1/rpc/is_admin").length).toBeGreaterThanOrEqual(2); // the login, and again on the reload (dev StrictMode may verify twice)
  });

  test("a saved session whose owner is no longer an admin is refused and cleared", async ({ page }) => {
    await seedSession(page, sessionFor(PLAIN_USER));
    const stub = await stubSupabase(page);
    await page.goto("/admin");
    await expect(page.getByText("החשבון הזה אינו מורשה לניהול.")).toBeVisible();
    expect(await storedSession(page)).toBeNull();
    expect(stub.tableCalls()).toHaveLength(0);
  });

  test("an expired session that cannot be renewed shows the login form", async ({ page }) => {
    await seedSession(page, sessionFor(ADMIN_USER, Math.floor(FIXED_NOW / 1000) - 7200));
    await stubSupabase(page, { refreshFails: true });
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "כניסה לניהול" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "סקירה" })).toHaveCount(0);
  });

  test("when the connection is down at load, the session is kept and the user can retry or sign out", async ({ page }) => {
    await seedSession(page, sessionFor(ADMIN_USER));
    await page.route(/stub\.supabase\.test/, (route) => route.abort("connectionrefused"));
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "לא ניתן לאמת את ההרשאה" })).toBeVisible();
    expect(await storedSession(page)).not.toBeNull(); // still signed in, just unverified
    await page.unroute(/stub\.supabase\.test/);
    await stubSupabase(page);
    await page.getByRole("button", { name: "נסו שוב" }).click();
    await expect(page.getByRole("heading", { name: "סקירה" })).toBeVisible();
  });

  test("signing out ends the session on the server and in the browser", async ({ page }) => {
    const stub = await stubSupabase(page);
    await page.goto("/admin");
    await login(page, ADMIN_USER.email, ADMIN_USER.password);
    await expect(page.getByRole("heading", { name: "סקירה" })).toBeVisible();

    await page.getByRole("button", { name: "התנתקות" }).click();
    await expect(page.getByRole("heading", { name: "כניסה לניהול" })).toBeVisible();
    expect(stub.to("/auth/v1/logout")).toHaveLength(1);
    expect(await storedSession(page)).toBeNull();

    await page.reload(); // still signed out after a reload
    await expect(page.getByRole("heading", { name: "כניסה לניהול" })).toBeVisible();
  });
});

test.describe("idle logout (60 minutes)", () => {
  test("signs out after an hour with no activity, and any click resets the timer", async ({ page }) => {
    await page.clock.install({ time: FIXED_NOW });
    const stub = await stubSupabase(page);
    await page.goto("/admin");
    await login(page, ADMIN_USER.email, ADMIN_USER.password);
    await expect(page.getByRole("heading", { name: "סקירה" })).toBeVisible();

    // 50 minutes idle, then activity: still signed in
    await page.clock.fastForward(50 * 60000);
    await page.getByRole("heading", { name: "סקירה" }).click();
    await page.clock.fastForward(50 * 60000); // 50 more minutes since the click — under the limit
    await expect(page.getByRole("heading", { name: "סקירה" })).toBeVisible();

    // now a full hour with nothing
    await page.clock.fastForward(61 * 60000);
    await expect(page.getByRole("heading", { name: "כניסה לניהול" })).toBeVisible();
    await expect(page.getByText("נותקתם אוטומטית לאחר זמן ללא פעילות")).toBeVisible();
    expect(stub.to("/auth/v1/logout").length).toBeGreaterThanOrEqual(1);
    expect(await storedSession(page)).toBeNull();
  });
});

test.describe("the admin address space", () => {
  test("/admin/ (trailing slash) and /ADMIN reach the admin; unknown pages inside it show 'not found'", async ({ page }) => {
    await stubSupabase(page);
    await page.goto("/admin/");
    await expect(page.getByRole("heading", { name: "כניסה לניהול" })).toBeVisible();
    await page.goto("/ADMIN");
    await expect(page.getByRole("heading", { name: "כניסה לניהול" })).toBeVisible();

    await page.goto("/admin/nothing-here");
    await login(page, ADMIN_USER.email, ADMIN_USER.password);
    await expect(page.getByText("העמוד לא נמצא.")).toBeVisible();
    await page.getByRole("button", { name: "חזרה לראשי" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("heading", { name: "סקירה" })).toBeVisible();
  });
});
