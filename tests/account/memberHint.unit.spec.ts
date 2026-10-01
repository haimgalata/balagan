import { test, expect } from "@playwright/test";
import { parseMemberHint } from "../../src/account/memberHint";

test("parseMemberHint trusts nothing it reads from storage", () => {
  expect(parseMemberHint(null)).toBeNull();
  expect(parseMemberHint("")).toBeNull();
  expect(parseMemberHint("not json")).toBeNull();
  expect(parseMemberHint("[]")).toBeNull();
  expect(parseMemberHint('"דנה"')).toBeNull();
  expect(parseMemberHint('{"firstName":5}')).toBeNull();
});

test("a hint with no name is still a member hint", () => {
  expect(parseMemberHint("{}")).toEqual({ firstName: null });
  expect(parseMemberHint('{"firstName":null}')).toEqual({ firstName: null });
  expect(parseMemberHint('{"firstName":"   "}')).toEqual({ firstName: null });
});

test("names are trimmed and capped, and nothing else survives", () => {
  expect(parseMemberHint('{"firstName":"  דנה "}')).toEqual({ firstName: "דנה" });
  expect(parseMemberHint('{"firstName":"' + "א".repeat(80) + '","token":"secret","phone":"050"}')).toEqual({ firstName: "א".repeat(30) });
});
