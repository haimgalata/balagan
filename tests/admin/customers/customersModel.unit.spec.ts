import { test, expect } from "@playwright/test";
import {
  buildAudienceCsv, csvCell, csvColumns, exportFileName, formatIsraelDate, formatPhoneLocal, marketingLabel, memberName,
  parseAudience, parseCustomerList, parseStats, toLocalDigits,
} from "../../../src/admin/customers/customersModel";
import { describeError } from "../../../src/admin/customers/customersErrors";
import { CUSTOMERS_PATH } from "../../../src/admin/customers/customersRoute";

test("the route sits under /admin", () => {
  expect(CUSTOMERS_PATH).toBe("/admin/customers");
});

test("a CSV cell is always quoted, quotes are doubled, and spreadsheet formulas are defused", () => {
  expect(csvCell("דנה")).toBe('"דנה"');
  expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  expect(csvCell(null)).toBe('""');
  // a customer typed this as their name: opening the file must never run it
  for (const evil of ['=HYPERLINK("http://evil","x")', "+1+1", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"]) {
    expect(csvCell(evil), evil).toMatch(/^"'/);
  }
  // ...but a phone number and a plain number are what they look like
  expect(csvCell("+972501234567")).toBe('"+972501234567"');
  expect(csvCell("-5")).toBe('"-5"');
  expect(csvCell("0501234567")).toBe('"0501234567"');
});

test("the audience CSV: BOM, CRLF, English headers, local phone column, one row per person", () => {
  const csv = buildAudienceCsv("sms", [
    { phone: "+972501234567", first_name: "דנה", last_name: "כהן", consent_at: "2026-09-20T07:00:00Z", wording_version: "v1" },
    { phone: "+972521000002", first_name: "=EVIL()", last_name: null, consent_at: "2026-09-21T07:00:00Z", wording_version: "v1" },
  ]);
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  const lines = csv.slice(1).split("\r\n");
  expect(lines[0]).toBe('"phone","phone_local","first_name","last_name","consent_at","wording_version"');
  expect(lines[1]).toBe('"+972501234567","0501234567","דנה","כהן","2026-09-20T07:00:00Z","v1"');
  expect(lines[2]).toContain(`"'=EVIL()"`);
  expect(lines[3]).toBe(""); // trailing CRLF
  expect(lines).toHaveLength(4);
});

test("each audience has its own columns; the e-mail list leads with the address, the do-not-contact list carries the reason", () => {
  expect(csvColumns("email")[0]).toBe("email");
  expect(csvColumns("suppression")).toEqual(["phone", "phone_local", "email", "reason", "at"]);
  const sup = buildAudienceCsv("suppression", [{ phone: "+972521000005", email: null, reason: "deleted", at: "2026-09-22T00:00:00Z" }]);
  expect(sup).toContain('"+972521000005","0521000005","","deleted","2026-09-22T00:00:00Z"');
  expect(buildAudienceCsv("sms", []).split("\r\n")).toHaveLength(2); // header + trailing newline only
});

test("file names say what is inside and the Israel date", () => {
  expect(exportFileName("sms", new Date("2026-09-20T21:30:00Z"))).toBe("balagan-marketing-sms-2026-09-21.csv"); // already the 21st in Israel
  expect(exportFileName("suppression", new Date("2026-09-20T10:00:00Z"))).toBe("balagan-do-not-contact-2026-09-20.csv");
});

test("display helpers", () => {
  expect(formatPhoneLocal("+972501234567")).toBe("050-123-4567");
  expect(formatPhoneLocal("+97289945190")).toBe("+97289945190");
  expect(toLocalDigits("+972501234567")).toBe("0501234567");
  expect(formatIsraelDate("2026-09-19T21:30:00Z")).toBe("20.9.2026");
  expect(formatIsraelDate(null)).toBe("");
  expect(memberName({ firstName: "דנה", lastName: "כהן" })).toBe("דנה כהן");
  expect(memberName({ firstName: null, lastName: null })).toBe("");
  expect(marketingLabel({ marketing: true, marketingChannels: ["sms", "email"] })).toBe("SMS + אימייל");
  expect(marketingLabel({ marketing: true, marketingChannels: ["email"] })).toBe("אימייל");
  expect(marketingLabel({ marketing: false, marketingChannels: [] })).toBe("הסיר/ה הסכמה");
});

test("parsing trusts nothing the database (or a broken proxy) returns", () => {
  expect(parseStats(null)).toBeNull();
  expect(parseStats([])).toBeNull();
  expect(parseStats({ members: "x", last_exports: { sms: { at: 5 } } })).toMatchObject({ members: 0, lastExports: {} });
  expect(parseStats({ members: 4, joined_30d: 1, last_exports: { sms: { at: "2026-09-20T00:00:00Z", count: 3 } } })).toMatchObject({
    members: 4, joined30d: 1, lastExports: { sms: { at: "2026-09-20T00:00:00Z", count: 3 } },
  });
  expect(parseCustomerList({ total: 1 })).toBeNull();
  const list = parseCustomerList({ total: 2, rows: [{ id: "a", phone: "+972501234567", orders_count: 2, marketing: true, marketing_channels: ["sms", 5] }, { id: 7 }, "junk"] })!;
  expect(list.rows).toHaveLength(1);
  expect(list.rows[0]).toMatchObject({ id: "a", ordersCount: 2, marketingChannels: ["sms"], firstName: null });
  expect(parseAudience({})).toBeNull();
  expect(parseAudience([{ a: 1, b: null, c: "x" }, 5])).toEqual([{ a: "1", b: null, c: "x" }]);
});

test("errors: not the owner / a missing migration / the network are told apart, in Hebrew", () => {
  expect(describeError({ code: "42501", message: "NOT_AUTHORIZED" }).kind).toBe("permission");
  expect(describeError({ code: "PGRST202", message: "Could not find the function public.admin_list_customers" }).kind).toBe("setup-needed");
  expect(describeError({ code: "PGRST202", message: "x" }).message).toContain("0013_customer_admin.sql");
  expect(describeError({ code: "", message: "Failed to fetch" }).kind).toBe("network");
  expect(describeError({ code: "XX000", message: "boom" }).kind).toBe("unknown");
});
