import { test, expect, gotoReady } from "../step3/fixtures";

/**
 * The admin area is private: reached only by typing /admin. Nothing the customer can see or open may point to
 * it, and the customer site must not touch the login service at all.
 */
test.beforeEach(({ mode }) => {
  test.skip(mode === "live" || mode === "baseline", "checked on the static and stubbed-database variants");
});

test("nothing on the customer site links to the admin", async ({ page }) => {
  const authRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/auth\/v1\//.test(request.url())) authRequests.push(request.url());
  });

  await gotoReady(page);
  // open the panels that live off-canvas so their markup is rendered too
  await page.getByRole("button", { name: /אזור אישי|התחברות/ }).first().click();
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");

  const html = await page.content();
  expect(html).not.toMatch(/href=["'][^"']*admin/i);

  const hrefs = await page.$$eval("a[href]", (anchors) => anchors.map((anchor) => anchor.getAttribute("href") ?? ""));
  expect(hrefs.filter((href) => /admin/i.test(href))).toEqual([]);
  await expect(page.getByRole("link", { name: /admin|ניהול/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /admin|כניסה לניהול/i })).toHaveCount(0);

  expect(authRequests, "the customer site must never call the login service").toEqual([]);
});

test("the customer site loads no admin code", async ({ page }) => {
  const scripts: string[] = [];
  page.on("response", (response) => {
    if (response.request().resourceType() === "script") scripts.push(response.url());
  });
  await gotoReady(page);
  // (the dev server serves modules one by one: the tiny address check adminRoute.ts is the only admin file the customer gets —
  //  the production-bundle guarantee is tested in bundle.unit.spec.ts)
  const adminScripts = scripts.filter((url) => /admin/i.test(url) && !url.includes("/adminRoute.ts"));
  expect(adminScripts).toEqual([]);
  expect(scripts.filter((url) => /supabase-js|@supabase/i.test(url))).toEqual([]);
});
