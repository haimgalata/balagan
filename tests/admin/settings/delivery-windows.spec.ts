import { test, expect } from "../../catalog/fixtures";
import { ADMIN_USER, seedSession, sessionFor, stubSupabase } from "../auth/adminStubs";
import { createFakeDatabase, type FakeDatabase } from "./fakeDatabase";
import type { Page } from "@playwright/test";

/**
 * The delivery-windows editor in /admin/settings (migration 0017), driven through the real UI against the in-memory fake
 * of the settings tables (fakeDatabase.ts, `windows: true`). The database's own rules (cut-off before departure,
 * positive capacity, 1–24 hours) are mirrored by the fake and verified on Postgres by scripts/verify-order-management.mjs.
 */
test.beforeEach(({ mode }) => {
  test.skip(mode !== "supabase", "settings tests use the stubbed-database variant");
});

async function openSettings(page: Page, db: FakeDatabase): Promise<void> {
  await stubSupabase(page, { extra: db.handle });
  await seedSession(page, sessionFor(ADMIN_USER));
  await page.goto("/admin/settings");
  await expect(page.getByRole("heading", { name: "הגדרות עסק", level: 1 })).toBeVisible();
}

const windowsGroup = (page: Page) => page.getByRole("group", { name: "חלונות משלוח" });
const rowsOf = (page: Page) => windowsGroup(page).getByTestId("window-row");

test.describe("delivery windows editor", () => {
  test("a database without migration 0017 asks for it instead of showing the editor", async ({ page }) => {
    await openSettings(page, createFakeDatabase());
    await expect(windowsGroup(page)).toContainText("0017_delivery.sql");
    await expect(windowsGroup(page).getByRole("button", { name: "הוספת חלון" })).toHaveCount(0);
  });

  test("starts empty; adding a window saves it with a cut-off and an optional capacity", async ({ page }) => {
    const db = createFakeDatabase({ windows: true });
    await openSettings(page, db);
    await expect(windowsGroup(page)).toContainText("עדיין לא הוגדרו חלונות");
    await expect(windowsGroup(page).getByLabel(/כמה שעות מראש/)).toHaveValue("4");

    await windowsGroup(page).getByRole("button", { name: "הוספת חלון" }).click();
    await windowsGroup(page).getByLabel("חלון 1 — שעת יציאה").fill("18:00");
    await windowsGroup(page).getByLabel("חלון 1 — סגירה להזמנה").fill("17:00");
    await windowsGroup(page).getByRole("button", { name: "שמירה" }).click();
    await expect(page.getByRole("status")).toContainText("חלונות המשלוח נשמרו");

    expect(db.windows).toHaveLength(1);
    expect(db.windows[0]).toMatchObject({ departure_time: "18:00:00", order_cutoff_time: "17:00:00", capacity: null, is_active: true });
    await expect(rowsOf(page)).toHaveCount(1);
    await expect(windowsGroup(page).getByLabel("חלון 1 — שעת יציאה")).toHaveValue("18:00");

    // saving again must UPDATE that window, not add a second one
    await windowsGroup(page).getByLabel("חלון 1 — קיבולת").fill("8");
    await windowsGroup(page).getByRole("button", { name: "שמירה" }).click();
    await expect(page.getByRole("status")).toContainText("חלונות המשלוח נשמרו");
    expect(db.windows).toHaveLength(1);
    expect(db.windows[0].capacity).toBe(8);
  });

  test("a window can be paused, and removed; the hours-ahead setting is saved with them", async ({ page }) => {
    const db = createFakeDatabase({ windows: true });
    db.windows.push(
      { id: "w1", departure_time: "13:00:00", order_cutoff_time: "12:00:00", capacity: null, is_active: true },
      { id: "w2", departure_time: "18:00:00", order_cutoff_time: "17:00:00", capacity: 10, is_active: true }
    );
    await openSettings(page, db);
    await expect(rowsOf(page)).toHaveCount(2);

    await rowsOf(page).nth(0).getByRole("checkbox", { name: "פעיל" }).uncheck();
    await rowsOf(page).nth(1).getByRole("button", { name: "מחיקה" }).click();
    await windowsGroup(page).getByLabel(/כמה שעות מראש/).fill("6");
    await windowsGroup(page).getByRole("button", { name: "שמירה" }).click();
    await expect(page.getByRole("status")).toContainText("חלונות המשלוח נשמרו");

    expect(db.windows.map((w) => [w.id, w.is_active])).toEqual([["w1", false]]);
    expect(db.settings.delivery_advance_hours).toBe(6);
    // the public settings no longer list the paused window
    expect(db.rpcOutput().delivery_windows).toEqual([]);
  });

  test("bad values are refused before anything is saved", async ({ page }) => {
    const db = createFakeDatabase({ windows: true });
    await openSettings(page, db);
    await windowsGroup(page).getByRole("button", { name: "הוספת חלון" }).click();
    await windowsGroup(page).getByLabel("חלון 1 — שעת יציאה").fill("18:00");
    await windowsGroup(page).getByLabel("חלון 1 — סגירה להזמנה").fill("19:00");
    await windowsGroup(page).getByRole("button", { name: "שמירה" }).click();
    await expect(windowsGroup(page).getByRole("alert")).toContainText("אחרי שעת היציאה");

    await windowsGroup(page).getByLabel("חלון 1 — סגירה להזמנה").fill("17:00");
    await windowsGroup(page).getByLabel("חלון 1 — קיבולת").fill("0");
    await windowsGroup(page).getByRole("button", { name: "שמירה" }).click();
    await expect(windowsGroup(page).getByRole("alert")).toContainText("קיבולת");

    await windowsGroup(page).getByLabel("חלון 1 — קיבולת").fill("");
    await windowsGroup(page).getByLabel(/כמה שעות מראש/).fill("30");
    await windowsGroup(page).getByRole("button", { name: "שמירה" }).click();
    await expect(windowsGroup(page).getByRole("alert")).toContainText("שעות מראש");
    expect(db.windows).toHaveLength(0);
  });
});
