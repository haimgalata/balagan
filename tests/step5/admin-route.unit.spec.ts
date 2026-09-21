import { test, expect } from "@playwright/test";
import { ADMIN_ROOT, isAdminPathname, normalizeAdminPath } from "../../src/admin/adminRoute";

test.describe("isAdminPathname", () => {
  test("matches /admin and anything below it, case-insensitively", () => {
    for (const path of ["/admin", "/admin/", "/admin/products", "/admin/products/149/edit", "/ADMIN", "/Admin/Categories"]) {
      expect(isAdminPathname(path), path).toBe(true);
    }
  });

  test("does not match look-alikes or customer paths", () => {
    for (const path of ["/", "/administrator", "/adminx", "/admins", "/a/admin", "/products/admin", "/index.html", "/#admin", ""]) {
      expect(isAdminPathname(path), JSON.stringify(path)).toBe(false);
    }
  });
});

test.describe("normalizeAdminPath", () => {
  test("strips trailing slashes and lower-cases", () => {
    expect(ADMIN_ROOT).toBe("/admin");
    expect(normalizeAdminPath("/admin/")).toBe("/admin");
    expect(normalizeAdminPath("/ADMIN/Products//")).toBe("/admin/products");
    expect(normalizeAdminPath("/admin")).toBe("/admin");
    expect(normalizeAdminPath("")).toBe("/admin");
  });
});
