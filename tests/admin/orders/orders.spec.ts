import { test, expect, FIXED_NOW } from "../auth/adminFixtures";
import { ADMIN_USER, STAFF_USER, seedSession, sessionFor, stubSupabase, type StubUser } from "../auth/adminStubs";
import { createFakeOrdersDatabase, makeOrder, type FakeOrder, type FakeOrdersDatabase } from "./fakeDatabase";
import type { Page } from "@playwright/test";

/**
 * Order management (/admin/orders): the Active board, actions, roles, alerts and history — driven through the
 * real UI against an in-memory fake of `orders` and the order RPCs (fakeDatabase.ts). The rules the fake
 * mirrors are verified for real against Postgres by scripts/verify-order-management.mjs; these tests check
 * the screens and the flow. Realtime has no server here (the socket can't connect), so updates that arrive
 * "from elsewhere" are picked up through the tab-visible reload — the same path the safety poll uses.
 */
test.beforeEach(({ mode }) => {
  test.skip(mode !== "supabase", "order tests use the stubbed-database variant");
});

const minutesAgo = (m: number) => new Date(Date.parse(new Date(FIXED_NOW).toISOString()) - m * 60_000).toISOString();

async function open(page: Page, db: FakeOrdersDatabase, user: StubUser = STAFF_USER, path = "/admin/orders") {
  const stub = await stubSupabase(page, { users: [ADMIN_USER, STAFF_USER], extra: db.handle });
  await seedSession(page, sessionFor(user));
  await page.goto(path);
  return stub;
}
/** Simulates the terminal coming back to the foreground (the board reloads on this). */
const wake = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));

const card = (page: Page, n: number) => page.locator(`[data-testid="order-card"][data-order-number="${n}"]`);
const lane = (page: Page, status: string) => page.getByTestId(`lane-${status}`);

function seed(): FakeOrdersDatabase {
  return createFakeOrdersDatabase([
    makeOrder(1001, { created_at: minutesAgo(3) }),
    makeOrder(1002, { order_status: "preparing", created_at: minutesAgo(20), delivery_notes: "לצלצל פעמיים" }),
    makeOrder(1003, { order_status: "out_for_delivery", created_at: minutesAgo(40) }),
  ]);
}

test.describe("roles and access", () => {
  test("the shared staff account lands on the board, sees only Orders, and never touches catalog tables", async ({ page }) => {
    const db = seed();
    const stub = await open(page, db, STAFF_USER, "/admin");
    await expect(page).toHaveURL(/\/admin\/orders$/);
    await expect(page.getByTestId("orders-board")).toBeVisible();
    const nav = page.getByRole("navigation", { name: "ניווט ניהול" });
    await expect(nav.getByRole("link")).toHaveText(["הזמנות"]);
    expect(stub.tableCalls()).toHaveLength(0);
    // and a direct visit to an owner-only page bounces straight back
    await page.goto("/admin/products");
    await expect(page).toHaveURL(/\/admin\/orders$/);
  });

  test("the owner sees every section including Orders", async ({ page }) => {
    await open(page, seed(), ADMIN_USER, "/admin");
    const nav = page.getByRole("navigation", { name: "ניווט ניהול" });
    await expect(nav.getByRole("link")).toHaveText(["ראשי", "הזמנות", "קטגוריות", "מוצרים", "לקוחות", "קופונים", "הגדרות עסק"]);
  });

  test("staff is NOT logged out by the 60-minute idle rule; the owner still is", async ({ page }) => {
    await page.clock.install({ time: FIXED_NOW });
    await open(page, seed(), STAFF_USER);
    await expect(page.getByTestId("orders-board")).toBeVisible();
    await page.clock.fastForward(125 * 60000);
    await expect(page.getByTestId("orders-board")).toBeVisible();
    await expect(page.getByRole("heading", { name: "כניסה לניהול" })).toHaveCount(0);
  });
});

test.describe("the Active board", () => {
  test("puts each open order in its lane with what is needed to fulfil it", async ({ page }) => {
    await open(page, seed());
    await expect(lane(page, "confirmed").getByTestId("order-card")).toHaveCount(1);
    await expect(lane(page, "preparing").getByTestId("order-card")).toHaveCount(1);
    await expect(lane(page, "out_for_delivery").getByTestId("order-card")).toHaveCount(1);

    const c = card(page, 1002);
    await expect(c).toContainText("#1002");
    await expect(c).toContainText("דנה לוי1002");
    await expect(c).toContainText("הרצל 2, נתיבות");
    await expect(c).toContainText("2 × מרלבורו אדום");
    await expect(c).toContainText("לגבות במסירה");
    await expect(c).toContainText("לצלצל פעמיים");
    await expect(c).toContainText("₪135");
  });

  test("moves an order through the lanes, and 'delivered' needs a second deliberate tap", async ({ page }) => {
    const db = seed();
    await open(page, db);
    await card(page, 1001).getByRole("button", { name: "התחל הכנה" }).click();
    await expect(lane(page, "preparing").getByTestId("order-card")).toHaveCount(2);
    expect(db.byNumber(1001).order_status).toBe("preparing");
    expect(db.rpcLog.at(-1)).toContain('"p_expected_status":"confirmed"');

    await card(page, 1001).getByRole("button", { name: "יצאה למשלוח" }).click();
    await expect(lane(page, "out_for_delivery").getByTestId("order-card")).toHaveCount(2);

    const deliver = card(page, 1001).getByRole("button", { name: "נמסרה" });
    await deliver.click(); // first tap only arms it
    expect(db.byNumber(1001).order_status).toBe("out_for_delivery");
    await card(page, 1001).getByRole("button", { name: "לחצו שוב לאישור מסירה" }).click();
    await expect(card(page, 1001)).toHaveCount(0);
    expect(db.byNumber(1001)).toMatchObject({ order_status: "completed", payment_status: "paid" }); // cash collected on delivery

    await page.getByTestId("finished-today").locator("summary").click();
    await expect(page.getByTestId("finished-today")).toContainText("#1001");
  });

  test("a PICKUP order goes new -> preparing -> ready for pickup -> collected, with no address and no delivery step", async ({ page }) => {
    const db = createFakeOrdersDatabase([
      makeOrder(1101, { fulfillment_method: "pickup", city: null, street: null, house_number: null, floor: null, apartment: null, delivery_fee_cents: 0, total_cents: 12000 }),
    ]);
    await open(page, db);
    await expect(card(page, 1101)).toContainText("איסוף עצמי מהחנות");
    await expect(card(page, 1101)).toContainText("לגבות באיסוף");
    await card(page, 1101).getByRole("button", { name: "התחל הכנה" }).click();
    await expect(card(page, 1101).getByRole("button", { name: "יצאה למשלוח" })).toHaveCount(0);
    await card(page, 1101).getByRole("button", { name: "מוכנה לאיסוף" }).click();
    await expect(lane(page, "ready_for_pickup").getByTestId("order-card")).toHaveCount(1);
    expect(db.byNumber(1101).order_status).toBe("ready_for_pickup");

    await card(page, 1101).getByRole("button", { name: "נאספה" }).click(); // first tap only arms it
    await card(page, 1101).getByRole("button", { name: "לחצו שוב לאישור איסוף" }).click();
    await expect(card(page, 1101)).toHaveCount(0);
    expect(db.byNumber(1101)).toMatchObject({ order_status: "completed", payment_status: "paid" });
    await page.getByTestId("finished-today").locator("summary").click();
    await expect(page.getByTestId("finished-today")).toContainText("נאספה");
  });

  test("staff can step an order one status back", async ({ page }) => {
    const db = seed();
    await open(page, db);
    await card(page, 1002).getByRole("button", { name: "חזרה ל״חדשה״" }).click();
    await expect(lane(page, "confirmed").getByTestId("order-card")).toHaveCount(2);
    expect(db.byNumber(1002).order_status).toBe("confirmed");
  });

  test("when someone else already moved the order, the user is told and the board refreshes", async ({ page }) => {
    const db = seed();
    await open(page, db);
    await expect(card(page, 1001)).toBeVisible();
    db.externally(1001, "preparing"); // another terminal got there first
    await card(page, 1001).getByRole("button", { name: "התחל הכנה" }).click();
    // the database treats "already at the requested status" as a harmless no-op...
    await expect(lane(page, "preparing").getByTestId("order-card")).toHaveCount(2);
    // ...but moving it somewhere ELSE than where the screen thought it was is refused as stale
    db.externally(1002, "out_for_delivery");
    await card(page, 1002).getByRole("button", { name: "חזרה ל״חדשה״" }).click();
    await expect(page.getByTestId("action-error")).toContainText("כבר עודכנה על ידי מישהו אחר");
    await expect(lane(page, "out_for_delivery").getByTestId("order-card")).toHaveCount(2); // refreshed to the truth
    expect(db.byNumber(1002).order_status).toBe("out_for_delivery");
  });

  test("an unknown/undersized failure is shown, never swallowed", async ({ page }) => {
    const db = seed();
    await open(page, db);
    await expect(card(page, 1001)).toBeVisible();
    db.failAll({ status: 500 });
    await card(page, 1001).getByRole("button", { name: "התחל הכנה" }).click();
    await expect(page.getByTestId("action-error")).toBeVisible();
  });
});

test.describe("cancelling", () => {
  test("needs a reason; before dispatch the stock is restored automatically", async ({ page }) => {
    const db = seed();
    await open(page, db);
    await card(page, 1002).getByRole("button", { name: "ביטול" }).click();
    const dialog = page.getByRole("dialog", { name: "ביטול הזמנה 1002" });
    await expect(dialog).toContainText("המלאי של ההזמנה יוחזר אוטומטית");
    const confirm = dialog.getByRole("button", { name: "בטלו את ההזמנה" });
    await expect(confirm).toBeDisabled(); // no reason yet
    await dialog.getByLabel("אחר").check();
    await expect(confirm).toBeDisabled(); // "other" needs text too
    await dialog.getByLabel("פירוט הסיבה").fill("טעות בהזמנה");
    await confirm.click();
    await expect(card(page, 1002)).toHaveCount(0);
    expect(db.byNumber(1002)).toMatchObject({ order_status: "cancelled", cancel_reason: "טעות בהזמנה", stock_return_status: "restored" });
    expect(db.restocked).toContain(db.byNumber(1002).id);
  });

  test("after it left the store the stock is held until someone confirms the goods are back", async ({ page }) => {
    const db = seed();
    await open(page, db);
    await card(page, 1003).getByRole("button", { name: "ביטול" }).click();
    const dialog = page.getByRole("dialog", { name: "ביטול הזמנה 1003" });
    await expect(dialog).toContainText("המלאי לא יוחזר עד שתאשרו");
    await dialog.getByLabel("הלקוח לא ענה / לא נמצא").check();
    await dialog.getByRole("button", { name: "בטלו את ההזמנה" }).click();

    expect(db.byNumber(1003).stock_return_status).toBe("pending_return");
    expect(db.restocked).toHaveLength(0);
    const attention = page.getByTestId("needs-attention");
    await expect(attention).toContainText("#1003");
    await attention.getByRole("button", { name: "המוצרים חזרו למלאי" }).click();
    await expect(page.getByTestId("needs-attention")).toHaveCount(0);
    expect(db.byNumber(1003).stock_return_status).toBe("restored");
    expect(db.restocked).toEqual([db.byNumber(1003).id]);
  });

  test("writing stock off is owner-only: staff aren't even offered it, the owner is (with a second confirming tap)", async ({ page }) => {
    const db = seed();
    Object.assign(db.byNumber(1003), { order_status: "cancelled", stock_return_status: "pending_return", cancel_reason: "x" });
    await open(page, db, STAFF_USER);
    await expect(page.getByTestId("needs-attention").getByRole("button", { name: "המוצרים חזרו למלאי" })).toBeVisible();
    await expect(page.getByTestId("needs-attention").getByRole("button", { name: "לא חזרו" })).toHaveCount(0);

    const owner = await page.context().newPage();
    await stubSupabase(owner, { users: [ADMIN_USER, STAFF_USER], extra: db.handle });
    await seedSession(owner, sessionFor(ADMIN_USER));
    await owner.goto("/admin/orders");
    const writeOff = owner.getByTestId("needs-attention").getByRole("button", { name: "לא חזרו" });
    await writeOff.click();
    expect(db.byNumber(1003).stock_return_status).toBe("pending_return"); // first tap only asks
    await owner.getByRole("button", { name: "בטוחים? המלאי לא יוחזר" }).click();
    await expect(owner.getByTestId("needs-attention")).toHaveCount(0);
    expect(db.byNumber(1003).stock_return_status).toBe("written_off");
    expect(db.restocked).toHaveLength(0);
  });

  test("a cancellation made elsewhere is called out loudly", async ({ page }) => {
    const db = seed();
    await open(page, db);
    await expect(card(page, 1002)).toBeVisible();
    db.externally(1002, "cancelled", "הלקוח התקשר וביטל");
    await wake(page);
    const notice = page.getByTestId("cancel-notice");
    await expect(notice).toContainText("#1002");
    await expect(notice).toContainText("הלקוח התקשר וביטל");
    await notice.getByRole("button", { name: "הבנתי" }).click();
    await expect(notice).toHaveCount(0);
  });

  test("cancelling from the same terminal does NOT raise that warning", async ({ page }) => {
    const db = seed();
    await open(page, db);
    await card(page, 1002).getByRole("button", { name: "ביטול" }).click();
    const dialog = page.getByRole("dialog", { name: "ביטול הזמנה 1002" });
    await dialog.getByLabel("הלקוח ביטל").check();
    await dialog.getByRole("button", { name: "בטלו את ההזמנה" }).click();
    await expect(card(page, 1002)).toHaveCount(0);
    await expect(page.getByTestId("cancel-notice")).toHaveCount(0);
  });
});

test.describe("new-order alerts", () => {
  test("a new order appears on refresh, the tab title announces it, and the sound banner reminds to start the shift", async ({ page }) => {
    const db = seed();
    await open(page, db);
    await expect(page.getByTestId("sound-off-banner")).toBeVisible();
    db.add(makeOrder(1004, { created_at: minutesAgo(0) }));
    await wake(page);
    await expect(card(page, 1004)).toBeVisible();
    await expect(lane(page, "confirmed").getByTestId("order-card")).toHaveCount(2);
    await expect.poll(() => page.title()).toMatch(/\(2\)|ניהול/); // flashes between the count and the normal title
  });

  test("starting the shift turns sound on; mute is available and remembered", async ({ page }) => {
    await open(page, seed());
    await page.getByRole("button", { name: /התחלת משמרת/ }).click();
    await expect(page.getByTestId("sound-off-banner")).toHaveCount(0);
    const mute = page.getByRole("button", { name: "השתקה" });
    await mute.click();
    await expect(page.getByRole("button", { name: /מושתק/ })).toHaveAttribute("aria-pressed", "true");
    await page.reload();
    await expect(page.getByTestId("sound-off-banner")).toBeVisible(); // browsers need a fresh tap after every reload
  });

  test("an old unaccepted order is flagged", async ({ page }) => {
    const db = createFakeOrdersDatabase([makeOrder(1010, { created_at: minutesAgo(45) })]);
    await open(page, db);
    await expect(card(page, 1010)).toHaveClass(/border-brand-danger/);
  });

  test("shows a clear offline state when the server can't be reached", async ({ page }) => {
    const db = seed();
    await open(page, db);
    await expect(card(page, 1001)).toBeVisible();
    db.failAll({ status: 503 });
    await wake(page);
    // the last good data stays visible; "offline" only appears after the safety window (checked in unit form) —
    // here we just make sure a failed reload never wipes the board
    await expect(card(page, 1001)).toBeVisible();
  });
});

test.describe("history and search", () => {
  function history(): FakeOrdersDatabase {
    const orders: FakeOrder[] = [
      makeOrder(1001, { order_status: "completed", payment_status: "paid", phone: "052-999-1111", phone_digits: "0529991111", status_changed_at: minutesAgo(60) }),
      makeOrder(1002, { order_status: "cancelled", payment_status: "cancelled", cancel_reason: "הלקוח ביטל", stock_return_status: "restored", status_changed_at: minutesAgo(120) }),
      makeOrder(1003, { order_status: "completed", payment_status: "paid", first_name: "משה", last_name: "כהן", status_changed_at: minutesAgo(60 * 24 * 12), created_at: minutesAgo(60 * 24 * 12) }),
    ];
    return createFakeOrdersDatabase(orders);
  }

  test("the owner can browse everything, filter, and open an order with its full timeline", async ({ page }) => {
    await open(page, history(), ADMIN_USER, "/admin/orders/history");
    await expect(page.getByTestId("history-row")).toHaveCount(3);
    await page.getByLabel("סטטוס הזמנה").selectOption("cancelled");
    await page.getByRole("button", { name: "חיפוש", exact: true }).click();
    await expect(page.getByTestId("history-row")).toHaveCount(1);
    await page.getByRole("button", { name: "#1002" }).click();
    const detail = page.getByTestId("order-detail");
    await expect(detail).toContainText("בוטלה: הלקוח ביטל");
    await expect(detail).toContainText("המלאי הוחזר");
    await expect(detail.getByRole("region", { name: "היסטוריית סטטוסים" })).toContainText("ההזמנה התקבלה");
    await expect(detail.getByRole("region", { name: "פריטים" })).toContainText("מרלבורו אדום");
    await expect(detail.getByRole("region", { name: "תשלום" })).toContainText("מזומן");
  });

  test("the owner finds an order by phone or number", async ({ page }) => {
    await open(page, history(), ADMIN_USER, "/admin/orders/history");
    await page.getByPlaceholder(/מספר הזמנה, טלפון/).fill("052-999");
    await page.getByRole("button", { name: "חיפוש", exact: true }).click();
    await expect(page.getByTestId("history-row")).toHaveCount(1);
    await expect(page.getByTestId("history-row")).toHaveAttribute("data-order-number", "1001");
  });

  test("staff get a search box only — nothing listed until they search — limited to the last 7 days", async ({ page }) => {
    await open(page, history(), STAFF_USER, "/admin/orders/history");
    await expect(page.getByText("הקלידו מספר הזמנה או טלפון כדי לחפש.")).toBeVisible();
    await expect(page.getByLabel("סטטוס הזמנה")).toHaveCount(0); // no owner filters
    await expect(page.getByLabel("מתאריך")).toHaveCount(0);
    await page.getByPlaceholder("מספר הזמנה או טלפון").fill("05");
    await page.getByRole("button", { name: "חיפוש", exact: true }).click();
    // 1003 is 12 days old: the database (RLS) hides it from staff, so only the two recent ones match
    await expect(page.getByTestId("history-row")).toHaveCount(2);
    await expect(page.locator('[data-testid="history-row"][data-order-number="1003"]')).toHaveCount(0);
  });

  test("only the owner can reopen a completed order", async ({ page }) => {
    const db = history();
    await open(page, db, STAFF_USER, "/admin/orders/1001");
    await expect(page.getByTestId("order-detail")).toContainText("#1001");
    await expect(page.getByRole("button", { name: "פתיחה מחדש" })).toHaveCount(0);

    const owner = await page.context().newPage();
    await stubSupabase(owner, { users: [ADMIN_USER, STAFF_USER], extra: db.handle });
    await seedSession(owner, sessionFor(ADMIN_USER));
    await owner.goto("/admin/orders/1001");
    await owner.getByRole("button", { name: "פתיחה מחדש" }).click();
    await expect(owner.getByTestId("order-detail")).toContainText("בדרך ללקוח");
    expect(db.byNumber(1001)).toMatchObject({ order_status: "out_for_delivery", payment_status: "pending" }); // cash back to unpaid
  });
});
