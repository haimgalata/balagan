import { roleOf, type StubRequestContext } from "../auth/adminStubs";

/**
 * An in-memory stand-in for the owner's courier-pay functions of migration 0018, used by the payroll screen's browser tests.
 * It mirrors what scripts/verify-order-management.mjs checks for real on Postgres: owner-only, the frozen amount per delivery,
 * a failed delivery with no amount waiting for the owner, a per-courier rate over the default, payouts per month.
 */
export interface FakeDelivery {
  order_id: string;
  order_number: number;
  outcome: "delivered" | "failed";
  reason: string | null;
  pay_cents: number | null;
  fee_cents: number;
  happened_at: string;
  run_date: string;
  departure_time: string;
  address: string;
}
export interface FakeCourier {
  courier_id: string;
  name: string;
  phone: string | null;
  email: string;
  active: boolean;
  rate_override_cents: number | null;
  deliveries: FakeDelivery[];
  payouts: { id: number; amount_cents: number; note: string | null; created_at: string }[];
}

const pgError = (code: string, message: string, status = 400) => ({ status, body: { code, message, details: null, hint: null } });

export const FAKE_MONTH = "2026-09-01";

export function makeDelivery(number: number, over: Partial<FakeDelivery> = {}): FakeDelivery {
  return {
    order_id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    order_number: number,
    outcome: "delivered",
    reason: null,
    pay_cents: 1200,
    fee_cents: 2000,
    happened_at: "2026-09-12T15:30:00.000Z",
    run_date: "2026-09-12",
    departure_time: "18:00:00",
    address: `הרצל ${number % 50}`,
    ...over,
  };
}

export function createFakeCouriers(couriers: FakeCourier[], defaultRateCents = 1200) {
  let rate = defaultRateCents;
  let nextPayoutId = 1;
  const log: string[] = [];

  const rateOf = (c: FakeCourier) => c.rate_override_cents ?? rate;
  const view = (c: FakeCourier) => ({
    courier_id: c.courier_id,
    name: c.name,
    phone: c.phone,
    email: c.email,
    active: c.active,
    rate_override_cents: c.rate_override_cents,
    rate_cents: rateOf(c),
    delivered: c.deliveries.filter((d) => d.outcome === "delivered").length,
    failed: c.deliveries.filter((d) => d.outcome === "failed").length,
    pending: c.deliveries.filter((d) => d.outcome === "failed" && d.pay_cents === null).length,
    runs: new Set(c.deliveries.map((d) => `${d.run_date}-${d.departure_time}`)).size,
    days: new Set(c.deliveries.map((d) => d.run_date)).size,
    pay_cents: c.deliveries.reduce((sum, d) => sum + (d.pay_cents ?? 0), 0),
    paid_cents: c.payouts.reduce((sum, p) => sum + p.amount_cents, 0),
    rows: c.deliveries,
    payouts: c.payouts,
  });

  async function handle(ctx: StubRequestContext): Promise<boolean> {
    const { url, method, body, user, json } = ctx;
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname)?.[1];
    const settings = url.pathname === "/rest/v1/business_settings";
    if (!settings && !(rpc && rpc.startsWith("admin_") && /courier/.test(rpc))) return false;
    if (!user || roleOf(user) !== "owner") {
      await json(403, pgError("42501", rpc ? "NOT_AUTHORIZED" : "permission denied", 403).body);
      return true;
    }
    const args = (body ?? {}) as Record<string, unknown>;

    if (settings) {
      if (method === "PATCH") {
        rate = Number((body as Record<string, unknown>).courier_pay_cents);
        log.push(`default rate ${rate}`);
        await json(204, null);
        return true;
      }
      return false;
    }

    const find = (id: unknown) => couriers.find((c) => c.courier_id === id);
    const reply = (r: { status: number; body: unknown }) => json(r.status, r.body);
    switch (rpc) {
      case "admin_courier_payroll":
        log.push(`payroll ${String(args.p_month)}`);
        await json(200, { month: String(args.p_month), default_rate_cents: rate, couriers: couriers.map(view) });
        return true;
      case "admin_set_courier_pay": {
        const cents = args.p_pay_cents;
        const delivery = couriers.flatMap((c) => c.deliveries).find((d) => d.order_id === args.p_order_id);
        if (typeof cents !== "number" || cents < 0) await reply(pgError("P0001", "INVALID_AMOUNT"));
        else if (!delivery) await reply(pgError("P0001", "NO_PAY_RECORD"));
        else {
          delivery.pay_cents = cents;
          log.push(`pay ${delivery.order_number} ${cents}`);
          await json(200, { order_id: delivery.order_id, pay_cents: cents });
        }
        return true;
      }
      case "admin_set_courier_rate": {
        const c = find(args.p_user_id);
        if (!c) await reply(pgError("P0001", "NOT_A_COURIER"));
        else if (typeof args.p_cents === "number" && args.p_cents < 0) await reply(pgError("P0001", "INVALID_AMOUNT"));
        else {
          c.rate_override_cents = typeof args.p_cents === "number" ? args.p_cents : null;
          log.push(`rate ${c.name} ${String(args.p_cents)}`);
          await json(200, { user_id: c.courier_id, rate_cents: rateOf(c) });
        }
        return true;
      }
      case "admin_record_courier_payout": {
        const c = find(args.p_courier_id);
        if (!c || typeof args.p_amount_cents !== "number" || args.p_amount_cents <= 0) await reply(pgError("P0001", "INVALID_AMOUNT"));
        else {
          const id = nextPayoutId++;
          c.payouts.push({ id, amount_cents: args.p_amount_cents, note: (args.p_note as string | null) ?? null, created_at: "2026-09-30T09:00:00.000Z" });
          log.push(`payout ${c.name} ${args.p_amount_cents}`);
          await json(200, { id });
        }
        return true;
      }
      case "admin_delete_courier_payout": {
        for (const c of couriers) c.payouts = c.payouts.filter((p) => p.id !== args.p_id);
        log.push(`delete payout ${String(args.p_id)}`);
        await json(200, { id: args.p_id, deleted: true });
        return true;
      }
    }
    return false;
  }

  return {
    couriers,
    log,
    handle,
    get defaultRate() {
      return rate;
    },
  };
}

export type FakeCouriersDatabase = ReturnType<typeof createFakeCouriers>;
