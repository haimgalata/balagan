import type { StubRequestContext } from "../auth/adminStubs";

/**
 * An in-memory stand-in for the owner's coupon tables of migration 0014 (coupons, coupon_redemptions, coupon_events) and
 * the club-offer sentence in business_settings, plugged into stubSupabase's `extra` hook. It enforces what matters to the
 * screen the way the database does: owner only (RLS), a unique normalized code, the code locked forever and the discount
 * locked once used, no delete, and every change leaving a trail in coupon_events with who did it.
 */
export interface FakeCoupon {
  id: string;
  code: string;
  title: string;
  internal_note: string | null;
  discount_type: "percent" | "fixed" | "free_delivery";
  discount_value: number | null;
  max_discount_cents: number | null;
  min_subtotal_cents: number;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  max_total_redemptions: number | null;
  max_per_member: number | null;
  first_order_only: boolean;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FakeRedemption {
  id: string;
  coupon_id: string;
  order_id: string;
  phone_e164: string;
  discount_cents: number;
  status: "reserved" | "redeemed" | "released";
  reserved_at: string;
  redeemed_at: string | null;
  released_at: string | null;
  released_reason: string | null;
  orders: { order_number: number; order_status: string; street: string; house_number: string; apartment: string | null; total_cents: number };
}

export interface FakeEvent {
  id: number;
  coupon_id: string;
  kind: string;
  changes: Record<string, { from: unknown; to: unknown }> | null;
  actor_label: string;
  created_at: string;
}

export interface FakeCoupons {
  coupons: FakeCoupon[];
  redemptions: FakeRedemption[];
  events: FakeEvent[];
  clubOfferText: string | null;
  /** request bodies the screen sent, in order */
  inserts: Record<string, unknown>[];
  updates: { id: string; body: Record<string, unknown> }[];
  offerPatches: Record<string, unknown>[];
  /** every HTTP method the screen used against the coupons table */
  methods: Set<string>;
  failWith: { status: number; body: unknown } | null;
  handle: (context: StubRequestContext) => Promise<boolean>;
}

const CODE_FORMAT = /^[A-Z0-9_-]{3,24}$/;
const day = (d: number, h = 7) => `2026-09-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00Z`;

const coupon = (patch: Partial<FakeCoupon> & Pick<FakeCoupon, "id" | "code" | "title">): FakeCoupon => ({
  internal_note: null, discount_type: "percent", discount_value: 20, max_discount_cents: null, min_subtotal_cents: 0, starts_at: null, ends_at: null,
  is_active: true, max_total_redemptions: null, max_per_member: 1, first_order_only: false, archived_at: null, created_at: day(10), updated_at: day(10), ...patch,
});

export function seedCoupons(): FakeCoupon[] {
  return [
    coupon({ id: "c-club20", code: "CLUB20", title: "הנחת מועדון", discount_value: 20, max_discount_cents: 3000, min_subtotal_cents: 10000, max_total_redemptions: 100, max_per_member: 1, created_at: day(15) }),
    coupon({ id: "c-ship", code: "FREESHIP", title: "משלוח חינם", discount_type: "free_delivery", discount_value: null, max_total_redemptions: null, max_per_member: 3, created_at: day(14) }),
    coupon({ id: "c-old", code: "SUMMER10", title: "קיץ", discount_value: 10, ends_at: day(1), created_at: day(2) }),
    coupon({ id: "c-off", code: "PAUSED5", title: "מושהה", discount_type: "fixed", discount_value: 500, is_active: false, created_at: day(12) }),
    coupon({ id: "c-full", code: "FIRST100", title: "מוצה", max_total_redemptions: 2, created_at: day(13) }),
    coupon({ id: "c-arch", code: "ARCHIVED1", title: "ישן בארכיון", is_active: false, archived_at: day(5), created_at: day(3) }),
    coupon({ id: "c-soon", code: "NEXTWEEK", title: "בשבוע הבא", starts_at: "2026-09-27T21:00:00Z", created_at: day(16) }),
  ];
}

const order = (n: number, street: string, apt: string | null) => ({ order_number: n, order_status: "completed", street, house_number: "5", apartment: apt, total_cents: 12000 });

export function seedRedemptions(): FakeRedemption[] {
  const r = (id: string, coupon_id: string, phone: string, status: FakeRedemption["status"], orders: FakeRedemption["orders"], extra: Partial<FakeRedemption> = {}): FakeRedemption => ({
    id, coupon_id, order_id: `o-${id}`, phone_e164: phone, discount_cents: 2400, status, reserved_at: day(16), redeemed_at: status === "reserved" ? null : day(16),
    released_at: null, released_reason: null, orders, ...extra,
  });
  return [
    r("r1", "c-club20", "+972501111111", "redeemed", order(1201, "הרצל", "3")),
    r("r2", "c-club20", "+972502222222", "redeemed", order(1202, "הרצל", "3")), // same door, another phone
    r("r3", "c-club20", "+972503333333", "released", order(1203, "בן גוריון", null), { released_at: day(17), released_reason: "order_cancelled_after_dispatch" }),
    r("r4", "c-full", "+972504444444", "redeemed", order(1204, "ויצמן", "1")),
    r("r5", "c-full", "+972505555555", "reserved", order(1205, "ויצמן", "2")),
  ];
}

export function createFakeCoupons(): FakeCoupons {
  const state: FakeCoupons = {
    coupons: seedCoupons(),
    redemptions: seedRedemptions(),
    events: [{ id: 1, coupon_id: "c-club20", kind: "created", changes: null, actor_label: "owner@example.test", created_at: day(15) }],
    clubOfferText: null,
    inserts: [],
    updates: [],
    offerPatches: [],
    methods: new Set(),
    failWith: null,
    handle: async (ctx) => {
      const table = /^\/rest\/v1\/(coupons|coupon_redemptions|coupon_events|business_settings)$/.exec(ctx.url.pathname)?.[1];
      if (!table) return false;
      if (state.failWith) {
        await ctx.json(state.failWith.status, state.failWith.body);
        return true;
      }
      // RLS stand-in: only the owner reads or writes any of this
      if (!ctx.user?.isAdmin) {
        await ctx.json(ctx.user ? 200 : 401, ctx.user ? [] : { code: "42501", message: `permission denied for table ${table}` });
        return true;
      }
      const wantsObject = /vnd\.pgrst\.object/.test(ctx.headers["accept"] ?? "");
      const send = (status: number, rows: unknown[]) => ctx.json(status, wantsObject ? (rows[0] ?? null) : rows);
      const eq = (name: string) => /^eq\.(.*)$/.exec(ctx.url.searchParams.get(name) ?? "")?.[1];
      const body = (ctx.body ?? {}) as Record<string, unknown>;

      if (table === "business_settings") {
        if (ctx.method === "PATCH") {
          state.offerPatches.push(body);
          if (typeof body.club_offer_text === "string" && body.club_offer_text.length > 120) {
            await ctx.json(400, { code: "23514", message: 'new row violates check constraint "business_settings_club_offer_text_ok"' });
            return true;
          }
          state.clubOfferText = (body.club_offer_text as string | null) ?? null;
        }
        await send(200, [{ club_offer_text: state.clubOfferText }]);
        return true;
      }

      if (table === "coupon_redemptions") {
        if (ctx.method !== "GET") {
          await ctx.json(403, { code: "42501", message: "permission denied for table coupon_redemptions" });
          return true;
        }
        const id = eq("coupon_id");
        await send(200, state.redemptions.filter((r) => !id || r.coupon_id === id));
        return true;
      }

      if (table === "coupon_events") {
        if (ctx.method !== "GET") {
          await ctx.json(403, { code: "42501", message: "permission denied for table coupon_events" });
          return true;
        }
        const id = eq("coupon_id");
        await send(200, state.events.filter((e) => !id || e.coupon_id === id).sort((a, b) => b.id - a.id));
        return true;
      }

      // ---- coupons
      state.methods.add(ctx.method);
      if (ctx.method === "DELETE") {
        await ctx.json(403, { code: "42501", message: "permission denied for table coupons" }); // no DELETE grant: archive instead
        return true;
      }
      const record = (coupon_id: string, kind: string, changes: FakeEvent["changes"]) =>
        state.events.push({ id: state.events.length + 1, coupon_id, kind, changes, actor_label: ctx.user!.email, created_at: "2026-09-20T07:00:00Z" });

      if (ctx.method === "GET") {
        const rows = [...state.coupons].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
        await send(200, rows);
        return true;
      }

      if (ctx.method === "POST") {
        state.inserts.push(body);
        const code = String(body.code ?? "");
        if (!CODE_FORMAT.test(code) || (body.discount_type === "percent" && !(Number(body.discount_value) >= 1 && Number(body.discount_value) <= 100))) {
          await ctx.json(400, { code: "23514", message: 'new row violates check constraint "coupons_code_format"' });
          return true;
        }
        if (state.coupons.some((c) => c.code === code)) {
          await ctx.json(409, { code: "23505", message: 'duplicate key value violates unique constraint "coupons_code_key"' });
          return true;
        }
        const created = coupon({ id: `c-new-${state.coupons.length}`, code, title: String(body.title), created_at: "2026-09-20T07:00:00Z", updated_at: "2026-09-20T07:00:00Z", ...(body as Partial<FakeCoupon>) });
        state.coupons.push(created);
        record(created.id, "created", null);
        await send(201, [created]);
        return true;
      }

      if (ctx.method === "PATCH") {
        const id = eq("id");
        const target = state.coupons.find((c) => c.id === id);
        if (!target) {
          await send(200, []);
          return true;
        }
        state.updates.push({ id: target.id, body });
        const used = state.redemptions.some((r) => r.coupon_id === target.id);
        if ("code" in body && body.code !== target.code) {
          await ctx.json(400, { code: "P0001", message: "CODE_LOCKED" });
          return true;
        }
        if (used && (("discount_type" in body && body.discount_type !== target.discount_type) || ("discount_value" in body && body.discount_value !== target.discount_value))) {
          await ctx.json(400, { code: "P0001", message: "COUPON_LOCKED" });
          return true;
        }
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const [k, v] of Object.entries(body)) {
          const before = (target as unknown as Record<string, unknown>)[k];
          if (JSON.stringify(before) !== JSON.stringify(v)) changes[k] = { from: before, to: v };
        }
        Object.assign(target, body, { updated_at: "2026-09-20T07:30:00Z" });
        const keys = Object.keys(changes);
        if (keys.length > 0) {
          const kind = changes.archived_at ? (target.archived_at ? "archived" : "restored") : keys.length === 1 && changes.is_active ? (target.is_active ? "enabled" : "disabled") : "updated";
          record(target.id, kind, kind === "updated" ? changes : null);
        }
        await send(200, [target]);
        return true;
      }

      await ctx.json(400, { message: "unsupported in stub" });
      return true;
    },
  };
  return state;
}
