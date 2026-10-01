/**
 * The contract between "who is this customer" (the login step, whose provider is deliberately not chosen yet)
 * and everything that happens AFTER login (profile, joining the club, checkout, the account area).
 *
 * Everything after login depends only on `CustomerSession`: a bearer token whose `auth.uid()` the database
 * recognizes and whose verified phone is in `auth.users.phone`. The database never trusts a phone number sent by
 * the client, so swapping the login adapter (mock -> a real SMS/OTP provider) changes nothing downstream.
 */

export interface CustomerSession {
  /** Bearer token for PostgREST. */
  accessToken: string;
  /** The verified number, E.164 (`+9725…`). For display/UX only — the database reads its own copy. */
  phoneE164: string;
}

export type CustomerAuthErrorCode =
  | "INVALID_PHONE" //        not a valid Israeli mobile number
  | "INVALID_CODE" //         wrong or expired code
  | "TOO_MANY_REQUESTS" //    rate limited
  | "NETWORK" //              could not reach the login service
  | "NOT_CONFIGURED"; //      no login adapter is available in this build

export class CustomerAuthError extends Error {
  code: CustomerAuthErrorCode;
  constructor(code: CustomerAuthErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface CustomerAuth {
  readonly kind: "mock";
  /** Starts a login for this number (sends the SMS code). */
  sendCode(phoneE164: string): Promise<void>;
  /** Completes it. Resolves with the new session, or throws `CustomerAuthError("INVALID_CODE")`. */
  verifyCode(phoneE164: string, code: string): Promise<CustomerSession>;
  /** The stored session if there is a valid one (restoring/refreshing it if needed), else null. */
  getSession(): Promise<CustomerSession | null>;
  signOut(): Promise<void>;
}

/** What `get_my_customer()` returns for a club member. */
export interface CustomerProfile {
  id: string;
  phone: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  joinedAt: string;
  termsVersion: string | null;
  termsAcceptedAt: string | null;
  age21ConfirmedAt: string | null;
  marketing: boolean;
  marketingChannels: string[];
}

/** The single mandatory registration confirmation (21+ AND written-marketing consent) — see clubConsent.ts. */
export interface JoinClubInput {
  age21Confirmed: boolean;
  marketingConsent: boolean;
  wordingVersion: string;
  channels?: ("sms" | "email")[];
  source?: "registration" | "account" | "checkout";
}

/** One of a member's saved delivery addresses (the database keeps at most 5; the most recently used comes first). */
export interface SavedAddress {
  id: string;
  street: string;
  houseNumber: string;
  entrance: string;
  floor: string;
  apartment: string;
  intercomCode: string;
  notes: string;
}

export interface MyOrderItem {
  /** null when the product has since been deleted from the catalog (the order keeps its own snapshot). */
  productId: string | null;
  name: string;
  brand: string | null;
  option: "unit" | "package";
  optionLabel: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

/** One of the member's past orders, as get_my_orders() returns it (a column whitelist — no internal fields). */
export interface MyOrder {
  id: string;
  orderNumber: number;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  createdAt: string;
  subtotalCents: number;
  deliveryFeeCents: number;
  totalCents: number;
  street: string;
  houseNumber: string;
  entrance: string;
  floor: string;
  apartment: string;
  items: MyOrderItem[];
}

/** A saved address as the member edits it (every optional field is "" when empty). */
export interface AddressInput {
  street: string;
  houseNumber: string;
  entrance: string;
  floor: string;
  apartment: string;
  intercomCode: string;
  notes: string;
}

export interface ProfileInput {
  firstName: string;
  lastName: string;
  email: string;
}
