import { test, expect } from "@playwright/test";
import { GUEST_DETAILS_KEY, clearGuestDetails, parseGuestDetails, readGuestDetails, saveGuestDetails } from "../../src/checkout/lib/guestMemory";

const memoryStorage = () => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
};

const details = {
  firstName: " ישראל ", lastName: "ישראלי", phone: "050-123-4567", email: "", street: "הרצל", houseNumber: "12",
  entrance: "", floor: "2", apartment: "5", intercomCode: "", notes: "להתקשר",
};

test("save then read round-trips the delivery details, trimmed", () => {
  const storage = memoryStorage();
  saveGuestDetails(details, storage);
  expect(readGuestDetails(storage)).toMatchObject({ firstName: "ישראל", street: "הרצל", floor: "2", notes: "להתקשר" });
});

test("only the known delivery fields are ever stored — never confirmations, payment or anything extra", () => {
  const storage = memoryStorage();
  saveGuestDetails({ ...details, ageConfirmed: true, termsAccepted: true, paymentMethod: "cash", city: "נתיבות" } as never, storage);
  expect(Object.keys(JSON.parse(storage.getItem(GUEST_DETAILS_KEY)!)).sort()).toEqual(
    ["apartment", "email", "entrance", "firstName", "floor", "houseNumber", "intercomCode", "lastName", "notes", "phone", "street"]
  );
});

test("reading trusts nothing from storage", () => {
  expect(parseGuestDetails(null)).toBeNull();
  expect(parseGuestDetails("not json")).toBeNull();
  expect(parseGuestDetails("[]")).toBeNull();
  expect(parseGuestDetails("{}")).toBeNull(); // all empty = nothing remembered
  expect(parseGuestDetails('{"firstName":5,"street":{"x":1}}')).toBeNull();
  const parsed = parseGuestDetails(JSON.stringify({ firstName: "א".repeat(900), ageConfirmed: true, evil: "x" }))!;
  expect(parsed.firstName).toHaveLength(300);
  expect("ageConfirmed" in parsed || "evil" in parsed).toBe(false);
});

test("clear removes it, and a broken storage never throws", () => {
  const storage = memoryStorage();
  saveGuestDetails(details, storage);
  clearGuestDetails(storage);
  expect(readGuestDetails(storage)).toBeNull();
  const broken = {
    getItem: () => { throw new Error("denied"); },
    setItem: () => { throw new Error("denied"); },
    removeItem: () => { throw new Error("denied"); },
  };
  expect(() => saveGuestDetails(details, broken)).not.toThrow();
  expect(() => clearGuestDetails(broken)).not.toThrow();
  expect(readGuestDetails(broken)).toBeNull();
});
