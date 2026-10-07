/**
 * How online orders are received and paid for right now, derived from the public business settings
 * (`get_business_settings()`, migration 0015). One place, so the cart drawer, the info bar and checkout can never
 * disagree about the delivery fee, the minimum order or which payment methods are offered.
 *
 * The site offers ONE way of receiving an order at a time — pickup from the store OR delivery — chosen by the owner in
 * /admin/settings. (The database would accept both being on; the storefront then offers pickup. A customer-side
 * choice between the two is a later step.) Display only: create_order() decides what an order really costs.
 */
import type { RpcBusinessSettings } from "@/storefront/lib/businessSettingsApi";

export type FulfillmentMethod = "delivery" | "pickup";

/**
 * Whether card payment is wired to a payment provider in THIS build. Until it is, card stays visibly "coming soon"
 * whatever the owner's `card_enabled` switch says (the switch alone would only create orders that can never be paid).
 */
export const CARD_PAYMENTS_READY = false;

export interface OrderingRules {
  fulfillment: FulfillmentMethod;
  /** 0 for pickup. */
  deliveryFeeCents: number;
  /** 0 for pickup — the minimum exists because of the delivery cost. */
  minOrderCents: number;
  cashEnabled: boolean;
  /** The owner's switch AND a build that can actually take card payments. */
  cardEnabled: boolean;
  /** Where to pick an order up (owner-typed, may be missing). */
  storeAddress: string | null;
}

/** Older cached settings (before 0015) have none of the new fields: they mean today's delivery + cash behaviour. */
export function getOrderingRules(settings: RpcBusinessSettings): OrderingRules {
  const fulfillment: FulfillmentMethod = settings.pickup_enabled === true ? "pickup" : "delivery";
  const pickup = fulfillment === "pickup";
  return {
    fulfillment,
    deliveryFeeCents: pickup ? 0 : settings.delivery_fee_cents,
    minOrderCents: pickup ? 0 : settings.min_order_cents,
    cashEnabled: settings.cash_enabled !== false,
    cardEnabled: CARD_PAYMENTS_READY && settings.card_enabled === true,
    storeAddress: settings.store_address_text?.trim() || null,
  };
}
