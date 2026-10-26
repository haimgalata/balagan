import { test, expect, FIXED_NOW } from "../auth/adminFixtures";
import { ADMIN_USER, COURIER_USER, STAFF_USER, seedSession, sessionFor, stubSupabase, type StubUser } from "../auth/adminStubs";
import { FAKE_COURIER_PHONE, createFakeOrdersDatabase, makeOrder, type FakeOrdersDatabase, type FakeRun } from "./fakeDatabase";
import type { Page } from "@playwright/test";

/**
 * Delivery windows, runs and the courier (migration 0017): the board's extra lane and runs panel, the courier's own
 * screen, and the two working together — driven through the real UI against an in-memory fake (fakeDatabase.ts). The
 * rules the fake mirrors (one run per window, claim race, customer details only after claiming, ID check, stock held
 * for a failed delivery) are verified for real against Postgres by scripts/verify-order-management.mjs.
 */
test.beforeEach(({ mode }) => {
  test.skip(mode !== "supabase", "delivery tests use the stubbed-database variant");
});

const COURIER_TWO: StubUser = { email: "courier2@example.test", password: "courier-password-2", id: "00000000-0000-0000-0000-00000000000e", isAdmin: false, role: "courier" };
const USERS = [ADMIN_USER, STAFF_USER, COURIER_USER, COURIER_TWO];

async function open(page: Page, db: FakeOrdersDatabase, user: StubUser, path: string) {
  const stub = await stubSupabase(page, { users: USERS, extra: db.handle });
  await seedSession(page, sessionFor(user));
  await page.goto(path);
  return stub;
}
/**
 * Another person on another device: its OWN browser context, so its saved login does not overwrite the first page's
 * (they would share one localStorage otherwise). Same pinned clock as every admin test.
 */
async function persona(page: Page, db: FakeOrdersDatabase, user: StubUser, path: string): Promise<Page> {
  const browser = page.context().browser();
  if (!browser) throw new Error("no browser");
  const context = await browser.newContext({ locale: "he-IL", timezoneId: "Asia/Jerusalem" });
  await context.clock.setFixedTime(new Date(FIXED_NOW));
  const other = await context.newPage();
  await open(other, db, user, path);
  return other;
}
const wake = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

const card = (page: Page, n: number) => page.locator(`[data-testid="order-card"][data-order-number="${n}"]`);
const lane = (page: Page, status: string) => page.getByTestId(`lane-${status}`);
const stopOf = (page: Page, n: number) => page.locator(`[data-testid="courier-stop"][data-order-number="${n}"]`);

/** Two orders in the 18:00 window, being prepared. */
function seed() {
  const windowed = { delivery_window_id: "w-18", delivery_departure_time: "18:00:00", order_status: "preparing" };
  return createFakeOrdersDatabase(
    [
      makeOrder(1201, { ...windowed, street: "הרצל", house_number: "12", payment_method: "card", payment_status: "paid" }),
      makeOrder(1202, { ...windowed, street: "אילת", house_number: "3", payment_method: "card", payment_status: "paid", intercom_code: "4321" }),
    ],
    { windows: true }
  );
}

test.describe("the board with delivery windows", () => {
  test("a ready order waits for a courier in its own lane, with the departure time and no 'left' button", async ({ page }) => {
    const db = seed();
    await open(page, db, STAFF_USER, "/admin/orders");
    await expect(lane(page, "ready_for_dispatch")).toBeVisible(); // exists because windows are defined
    await expect(card(page, 1201).getByRole("button", { name: "מוכנה למשלוח" })).toBeVisible();
    await expect(card(page, 1201).getByRole("button", { name: "יצאה למשלוח" })).toHaveCount(0);

    await card(page, 1201).getByRole("button", { name: "מוכנה למשלוח" }).click();
    await expect(lane(page, "ready_for_dispatch").getByTestId("order-card")).toHaveCount(1);
    await card(page, 1202).getByRole("button", { name: "מוכנה למשלוח" }).click();
    await expect(lane(page, "ready_for_dispatch").getByTestId("order-card")).toHaveCount(2);

    const ready = card(page, 1201);
    await expect(ready.getByTestId("order-departure")).toHaveText("יציאה ב-18:00");
    await expect(ready.getByRole("button", { name: "יצאה למשלוח" })).toHaveCount(0); // only the courier's run sends it out
    await expect(ready.getByRole("button", { name: "חזרה להכנה" })).toBeVisible();

    // both joined ONE run, waiting for a courier
    expect(db.runs).toHaveLength(1);
    const runs = page.getByTestId("runs-panel");
    await expect(runs).toContainText("ריצת 18:00 · 2 הזמנות");
    await expect(runs.getByTestId("run-row")).toHaveAttribute("data-run-status", "open");
    await expect(runs).toContainText("ממתינה לשליח");
  });

  test("taking an order back out of the run empties and removes the run", async ({ page }) => {
    const db = seed();
    await open(page, db, STAFF_USER, "/admin/orders");
    await card(page, 1201).getByRole("button", { name: "מוכנה למשלוח" }).click();
    await expect(page.getByTestId("runs-panel")).toContainText("ריצת 18:00 · 1 הזמנה");
    await card(page, 1201).getByRole("button", { name: "חזרה להכנה" }).click();
    await expect(page.getByTestId("runs-panel")).toHaveCount(0);
    expect(db.runs).toHaveLength(0);
  });

  test("without any window defined the extra lane and the runs panel do not exist", async ({ page }) => {
    const db = createFakeOrdersDatabase([makeOrder(1301, { order_status: "preparing" })]);
    await open(page, db, STAFF_USER, "/admin/orders");
    await expect(card(page, 1301).getByRole("button", { name: "יצאה למשלוח" })).toBeVisible(); // legacy lifecycle
    await expect(lane(page, "ready_for_dispatch")).toHaveCount(0);
    await expect(page.getByTestId("runs-panel")).toHaveCount(0);
  });
});

test.describe("the courier", () => {
  test("a courier-only account sees only its own screen and is sent there from anywhere else", async ({ page }) => {
    const db = seed();
    await open(page, db, COURIER_USER, "/admin/orders");
    await expect(page).toHaveURL(/\/admin\/courier$/);
    await expect(page.getByTestId("courier-page")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "ניווט ניהול" }).getByRole("link")).toHaveText(["שליח"]);
    await page.goto("/admin/products");
    await expect(page).toHaveURL(/\/admin\/courier$/);
  });

  test("staff and the owner are not offered the courier screen", async ({ page }) => {
    const db = seed();
    await open(page, db, STAFF_USER, "/admin/courier");
    await expect(page).toHaveURL(/\/admin\/orders$/);
    await expect(page.getByRole("navigation", { name: "ניווט ניהול" }).getByRole("link")).toHaveText(["הזמנות"]);
  });

  test("open runs show no customer details; taking one reveals the stops, sorted by street; a second courier is refused", async ({ page }) => {
    const db = seed();
    await open(page, db, STAFF_USER, "/admin/orders");
    await card(page, 1201).getByRole("button", { name: "מוכנה למשלוח" }).click();
    await card(page, 1202).getByRole("button", { name: "מוכנה למשלוח" }).click();
    await expect(page.getByTestId("runs-panel")).toContainText("2 הזמנות");

    const c1 = await persona(page, db, COURIER_USER, "/admin/courier");
    const c2 = await persona(page, db, COURIER_TWO, "/admin/courier");
    const openRun = c1.getByTestId("open-run");
    await expect(openRun).toContainText("ריצת 18:00 · 2 הזמנות");
    await expect(openRun).toContainText("הרצל");
    await expect(c1.getByTestId("courier-page")).not.toContainText("050-123-4567"); // no phone, no name before claiming
    await expect(c1.getByTestId("courier-page")).not.toContainText("דנה");

    await openRun.getByRole("button", { name: "אני לוקח" }).click();
    const mine = c1.getByTestId("my-run");
    await expect(mine).toHaveAttribute("data-run-status", "claimed");
    const stops = mine.getByTestId("courier-stop");
    await expect(stops).toHaveCount(2);
    await expect(stops.nth(0)).toContainText("אילת 3"); // sorted by street
    await expect(stops.nth(1)).toContainText("הרצל 12");
    await expect(stops.nth(0)).toContainText("קוד אינטרקום 4321");
    await expect(stops.nth(0).getByRole("link", { name: /חיוג/ })).toHaveAttribute("href", "tel:0501234567");
    await expect(stops.nth(0).getByRole("link", { name: "ניווט ב-Waze" })).toHaveAttribute("href", /^https:\/\/waze\.com\/ul\?q=.*navigate=yes$/);
    await expect(c1.getByTestId("open-run")).toHaveCount(0);

    // the other courier tapped on the same run a moment later
    await wake(c2);
    await expect(c2.getByTestId("open-run")).toHaveCount(0); // already gone from his list
    await expect(c2.getByTestId("my-run")).toHaveCount(0);
    await c2.context().close();
    await c1.context().close();
  });

  test("the whole run: take it, leave, hand over one (after an ID check), fail one with a reason — the board follows", async ({ page }) => {
    const db = seed();
    await open(page, db, STAFF_USER, "/admin/orders");
    await card(page, 1201).getByRole("button", { name: "מוכנה למשלוח" }).click();
    await card(page, 1202).getByRole("button", { name: "מוכנה למשלוח" }).click();
    await expect(page.getByTestId("runs-panel")).toContainText("2 הזמנות");

    const c = await persona(page, db, COURIER_USER, "/admin/courier");
    await c.getByTestId("open-run").getByRole("button", { name: "אני לוקח" }).click();
    await expect(c.getByTestId("my-run")).toBeVisible();

    // the board now shows who took it, with a button to ring him
    await wake(page);
    const row = page.getByTestId("runs-panel").getByTestId("run-row");
    await expect(row).toHaveAttribute("data-run-status", "claimed");
    await expect(row.getByTestId("run-courier")).toHaveText("דני השליח");
    await expect(row.getByRole("link", { name: "חיוג לדני השליח" })).toHaveAttribute("href", `tel:${FAKE_COURIER_PHONE}`);

    await c.getByRole("button", { name: "יצאתי" }).click();
    await expect(c.getByTestId("my-run")).toHaveAttribute("data-run-status", "departed");
    await expect(c.getByRole("button", { name: "יצאתי" })).toHaveCount(0);
    expect(db.byNumber(1201).order_status).toBe("out_for_delivery");
    expect(db.byNumber(1202).order_status).toBe("out_for_delivery");

    // hand over 1202 (אילת, first stop) — needs the ID confirmation
    await stopOf(c, 1202).getByRole("button", { name: "נמסר", exact: true }).click();
    const confirm = stopOf(c, 1202).getByRole("button", { name: "אישור מסירה" });
    await expect(confirm).toBeDisabled();
    await stopOf(c, 1202).getByRole("checkbox", { name: /בדקתי תעודה מזהה/ }).check();
    await confirm.click();
    await expect(stopOf(c, 1202)).toHaveAttribute("data-status", "completed");
    expect(db.byNumber(1202).order_status).toBe("completed");

    // fail 1201 — a reason is always sent
    await stopOf(c, 1201).getByRole("button", { name: "לא נמסר", exact: true }).click();
    await stopOf(c, 1201).getByLabel("סיבה").selectOption("לא הוצגה תעודה מזהה");
    await stopOf(c, 1201).getByRole("button", { name: "אישור — לא נמסר" }).click();
    await expect(stopOf(c, 1201)).toHaveAttribute("data-status", "delivery_failed");
    expect(db.byNumber(1201)).toMatchObject({ order_status: "delivery_failed", delivery_failed_reason: "לא הוצגה תעודה מזהה", stock_return_status: "pending_return" });
    await expect(c.getByTestId("my-run")).toContainText("נמסרו 1");

    // the board: the failed order needs attention until the goods are confirmed back
    await wake(page);
    const attention = page.getByTestId("needs-attention");
    await expect(attention).toContainText("#1201");
    await expect(attention).toContainText("לא הוצגה תעודה מזהה");
    await attention.getByRole("button", { name: "המוצרים חזרו למלאי" }).click();
    await expect(page.getByTestId("needs-attention")).toHaveCount(0);
    expect(db.byNumber(1201).stock_return_status).toBe("restored");
    expect(db.byNumber(1201).order_status).toBe("delivery_failed"); // stays as the record of what happened
    await c.context().close();
  });

  test("a failed delivery needs a reason (the 'other' reason must be spelled out)", async ({ page }) => {
    const db = seed();
    await open(page, db, STAFF_USER, "/admin/orders");
    await card(page, 1201).getByRole("button", { name: "מוכנה למשלוח" }).click();
    const c = await persona(page, db, COURIER_USER, "/admin/courier");
    await c.getByRole("button", { name: "אני לוקח" }).click();
    await c.getByRole("button", { name: "יצאתי" }).click();
    await stopOf(c, 1201).getByRole("button", { name: "לא נמסר", exact: true }).click();
    await stopOf(c, 1201).getByLabel("סיבה").selectOption("אחר");
    await expect(stopOf(c, 1201).getByRole("button", { name: "אישור — לא נמסר" })).toBeDisabled();
    await stopOf(c, 1201).getByLabel("פירוט הסיבה").fill("אף אחד לא פתח");
    await stopOf(c, 1201).getByRole("button", { name: "אישור — לא נמסר" }).click();
    await expect(stopOf(c, 1201)).toHaveAttribute("data-status", "delivery_failed");
    expect(db.byNumber(1201).delivery_failed_reason).toBe("אף אחד לא פתח");
    await c.context().close();
  });

  test("the owner can let go of a courier who did not show up (two taps); the run is open again for others", async ({ page }) => {
    const db = seed();
    await open(page, db, STAFF_USER, "/admin/orders");
    await card(page, 1201).getByRole("button", { name: "מוכנה למשלוח" }).click();
    const c = await persona(page, db, COURIER_USER, "/admin/courier");
    await c.getByRole("button", { name: "אני לוקח" }).click();
    await wake(page);
    const row = page.getByTestId("run-row");
    await expect(row).toHaveAttribute("data-run-status", "claimed");

    await row.getByRole("button", { name: "שחרור השליח" }).click(); // first tap only asks
    expect(db.runs[0].status).toBe("claimed");
    await row.getByRole("button", { name: "לחצו שוב לשחרור השליח" }).click();
    await expect(row).toHaveAttribute("data-run-status", "open");
    expect(db.runs[0]).toMatchObject({ status: "open", courier_id: null });

    await wake(c);
    await expect(c.getByTestId("my-run")).toHaveCount(0);
    await expect(c.getByTestId("open-run")).toBeVisible();
    await c.context().close();
  });

  test("a run that was taken but has not left once it is due is flagged for the owner (never released automatically)", async ({ page }) => {
    const lateRun: FakeRun = {
      id: "r-late", run_date: "2026-09-20", status: "claimed", courier_id: COURIER_USER.id, courier_name: "דני השליח", courier_phone: FAKE_COURIER_PHONE,
      claimed_at: "2026-09-20T05:00:00.000Z", departed_at: null, departure_time: "09:00:00", // due 09:00; the test clock says 10:00
    };
    const db = createFakeOrdersDatabase(
      [makeOrder(1401, { order_status: "ready_for_dispatch", delivery_window_id: "w-09", delivery_departure_time: "09:00:00", delivery_run_id: "r-late" })],
      { windows: true, runs: [lateRun] }
    );
    await open(page, db, STAFF_USER, "/admin/orders");
    await expect(page.getByTestId("run-attention")).toContainText("דני השליח לקח את ריצת 09:00 אבל עוד לא יצא");
    expect(db.runs[0].status).toBe("claimed");
  });

  test("a run nobody has taken shortly before it is due is flagged", async ({ page }) => {
    const openRun: FakeRun = {
      id: "r-open", run_date: "2026-09-20", status: "open", courier_id: null, courier_name: null, courier_phone: null, claimed_at: null, departed_at: null,
      departure_time: "10:15:00", // 15 minutes from the test clock
    };
    const db = createFakeOrdersDatabase(
      [makeOrder(1402, { order_status: "ready_for_dispatch", delivery_window_id: "w-10", delivery_departure_time: "10:15:00", delivery_run_id: "r-open" })],
      { windows: true, runs: [openRun] }
    );
    await open(page, db, STAFF_USER, "/admin/orders");
    await expect(page.getByTestId("run-attention")).toContainText("אף שליח לא לקח את ריצת 10:15");
  });
});
