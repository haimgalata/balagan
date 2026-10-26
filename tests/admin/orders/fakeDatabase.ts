import { FIXED_NOW_MS, roleOf, type StubRequestContext } from "../auth/adminStubs";

/**
 * An in-memory stand-in for `orders` (+ items, status events) and the order RPCs of migration 0010, used by
 * the order-management browser tests. It mirrors the rules that are verified for real against Postgres in
 * scripts/verify-order-management.mjs: the transition map, STALE_STATUS, mandatory cancel reason, restock only
 * before dispatch (after dispatch: pending_return until resolve_stock_return), cash -> paid on completion,
 * owner-only reopen, and the staff visibility window (open orders + unresolved stock + last 7 days).
 */
export interface FakeItem {
  id: number;
  product_id: string | null;
  product_name_snapshot: string;
  product_brand_snapshot: string | null;
  option: "unit" | "package";
  option_label_snapshot: string;
  unit_price_cents: number;
  quantity: number;
  base_units: number;
  line_total_cents: number;
}
export interface FakeEvent {
  id: number;
  kind: "created" | "status" | "payment" | "stock_return";
  from_value: string | null;
  to_value: string;
  reason: string | null;
  actor_label: string;
  actor_role: string | null;
  created_at: string;
}
export interface FakeOrder {
  id: string;
  order_number: number;
  payment_method: "cash" | "card";
  /** migration 0015; absent = delivery */
  fulfillment_method?: "delivery" | "pickup";
  order_status: string;
  payment_status: string;
  first_name: string;
  last_name: string;
  phone: string;
  phone_digits: string;
  email: string | null;
  city: string | null;
  street: string | null;
  house_number: string | null;
  entrance: string | null;
  floor: string | null;
  apartment: string | null;
  intercom_code: string | null;
  delivery_notes: string | null;
  subtotal_cents: number;
  delivery_fee_cents: number;
  discount_cents: number;
  total_cents: number;
  created_at: string;
  confirmed_at: string | null;
  status_changed_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  stock_return_status: string;
  // migration 0017
  delivery_window_id?: string | null;
  delivery_departure_time?: string | null;
  delivery_run_id?: string | null;
  delivery_failed_reason?: string | null;
  order_items: FakeItem[];
  order_status_events: FakeEvent[];
}

/** A delivery run (migration 0017). The courier's name / phone are copied on claim, like the real table. */
export interface FakeRun {
  id: string;
  run_date: string;
  status: "open" | "claimed" | "departed" | "finished";
  courier_id: string | null;
  courier_name: string | null;
  courier_phone: string | null;
  claimed_at: string | null;
  departed_at: string | null;
  departure_time: string;
}

const pgError = (code: string, message: string, status: number) => ({ status, body: { code, message, details: null, hint: null } });
const minutesAgo = (m: number) => new Date(FIXED_NOW_MS - m * 60_000).toISOString();

let nextItemId = 1;
let nextEventId = 1;

export function makeOrder(number: number, overrides: Partial<FakeOrder> = {}): FakeOrder {
  const created = overrides.created_at ?? minutesAgo(3);
  const base: FakeOrder = {
    id: `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    order_number: number,
    payment_method: "cash",
    order_status: "confirmed",
    payment_status: "pending",
    first_name: "דנה",
    last_name: `לוי${number}`,
    phone: "050-123-4567",
    phone_digits: "0501234567",
    email: null,
    city: "נתיבות",
    street: "הרצל",
    house_number: String(number % 50),
    entrance: null,
    floor: "2",
    apartment: "5",
    intercom_code: null,
    delivery_notes: null,
    subtotal_cents: 12000,
    delivery_fee_cents: 1500,
    discount_cents: 0,
    total_cents: 13500,
    created_at: created,
    confirmed_at: created,
    status_changed_at: created,
    completed_at: null,
    cancelled_at: null,
    cancel_reason: null,
    stock_return_status: "none",
    order_items: [
      { id: nextItemId++, product_id: "901", product_name_snapshot: "מרלבורו אדום", product_brand_snapshot: "Marlboro", option: "unit", option_label_snapshot: "יחידה", unit_price_cents: 6000, quantity: 2, base_units: 2, line_total_cents: 12000 },
    ],
    order_status_events: [],
  };
  const order = { ...base, ...overrides };
  if (order.order_status_events.length === 0) {
    order.order_status_events = [{ id: nextEventId++, kind: "created", from_value: null, to_value: "confirmed", reason: null, actor_label: "customer", actor_role: null, created_at: created }];
  }
  return order;
}

export interface FakeOrdersOptions {
  /** the owner has defined delivery windows (get_business_settings() lists them) */
  windows?: boolean;
  /** extra runs that already exist (e.g. one nobody has taken) */
  runs?: FakeRun[];
}

export const FAKE_COURIER_NAME = "דני השליח";
export const FAKE_COURIER_PHONE = "0501234567";

export function createFakeOrdersDatabase(initial: FakeOrder[] = [], options: FakeOrdersOptions = {}) {
  const orders: FakeOrder[] = [...initial];
  const runs: FakeRun[] = [...(options.runs ?? [])];
  let nextRunId = 1;
  const rpcLog: string[] = [];
  /** ids whose stock was given back (restock happened) */
  const restocked: string[] = [];
  let failAll: { status: number; body?: unknown } | null = null;

  const ACTIVE = ["confirmed", "preparing", "ready_for_dispatch", "out_for_delivery", "ready_for_pickup"];
  const staffCanSee = (o: FakeOrder) =>
    ACTIVE.includes(o.order_status) || o.stock_return_status === "pending_return" || new Date(o.status_changed_at).getTime() >= FIXED_NOW_MS - 7 * 86_400_000;

  function record(o: FakeOrder, kind: FakeEvent["kind"], from: string | null, to: string, actor: { label: string; role: string | null }, reason: string | null = null) {
    o.order_status_events.push({ id: nextEventId++, kind, from_value: from, to_value: to, reason, actor_label: actor.label, actor_role: actor.role, created_at: new Date(FIXED_NOW_MS).toISOString() });
  }

  // ---- PostgREST subset -------------------------------------------------------------------------------
  function matchesTerm(o: FakeOrder, term: string): boolean {
    const m = /^([a-z_]+)\.(eq|ilike)\.(.*)$/.exec(term);
    if (!m) return true;
    const [, column, op, raw] = m;
    const value = String((o as unknown as Record<string, unknown>)[column] ?? "");
    if (op === "eq") return value === raw;
    return value.toLowerCase().includes(raw.replace(/\*/g, "").toLowerCase());
  }
  function applyFilters(rows: FakeOrder[], url: URL): FakeOrder[] {
    let out = rows;
    for (const [key, value] of url.searchParams) {
      if (["select", "order", "limit", "offset"].includes(key)) continue;
      if (key === "or") {
        const terms = value.replace(/^\(|\)$/g, "").split(",");
        out = out.filter((o) => terms.some((t) => matchesTerm(o, t)));
        continue;
      }
      const get = (o: FakeOrder) => String((o as unknown as Record<string, unknown>)[key]);
      const eq = /^eq\.(.*)$/.exec(value);
      const inn = /^in\.\((.*)\)$/.exec(value);
      const gte = /^gte\.(.*)$/.exec(value);
      const lt = /^lt\.(.*)$/.exec(value);
      if (eq) out = out.filter((o) => get(o) === eq[1]);
      else if (inn) out = out.filter((o) => inn[1].split(",").includes(get(o)));
      else if (gte) out = out.filter((o) => get(o) >= gte[1]);
      else if (lt) out = out.filter((o) => get(o) < lt[1]);
    }
    return out;
  }
  function applyOrder(rows: FakeOrder[], url: URL): FakeOrder[] {
    const spec = url.searchParams.get("order");
    if (!spec) return rows;
    const keys = spec.split(",").map((s) => s.split("."));
    return [...rows].sort((a, b) => {
      for (const [col, dir] of keys) {
        const av = String((a as unknown as Record<string, unknown>)[col]);
        const bv = String((b as unknown as Record<string, unknown>)[col]);
        const numeric = col === "order_number";
        const cmp = numeric ? Number(av) - Number(bv) : av < bv ? -1 : av > bv ? 1 : 0;
        if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
      }
      return 0;
    });
  }
  function shape(rows: FakeOrder[], url: URL): unknown[] {
    const select = url.searchParams.get("select") ?? "*";
    const withItems = select.includes("order_items(");
    const withEvents = select.includes("order_status_events(");
    return rows.map((o) => {
      const { order_items, order_status_events, ...rest } = o;
      return { ...rest, ...(withItems ? { order_items } : {}), ...(withEvents ? { order_status_events } : {}) };
    });
  }

  // ---- RPCs --------------------------------------------------------------------------------------------
  function transition(orderId: string, expected: string, to: string, reason: string | null, actor: { label: string; role: string }) {
    const o = orders.find((x) => x.id === orderId);
    if (!o) return pgError("P0001", "ORDER_NOT_FOUND", 400);
    if (o.order_status === to) return { status: 200, body: { order_id: o.id, order_status: to, changed: false } };
    if (o.order_status !== expected) return pgError("P0001", `STALE_STATUS: ${o.order_status}`, 400);
    const from = o.order_status;
    const delivery = o.fulfillment_method !== "pickup";
    const last = delivery ? "out_for_delivery" : "ready_for_pickup"; // same rule as migrations 0015 / 0017
    const windowed = !!o.delivery_window_id;
    const ok =
      (from === "confirmed" && ["preparing", "cancelled"].includes(to)) ||
      (from === "preparing" &&
        (["confirmed", "cancelled"].includes(to) ||
          (!delivery && to === "ready_for_pickup") ||
          (delivery && to === "ready_for_dispatch") ||
          (delivery && to === "out_for_delivery" && !windowed))) ||
      (from === "ready_for_dispatch" && delivery && ["out_for_delivery", "preparing", "cancelled"].includes(to)) ||
      (from === last && ["completed", "preparing", "cancelled"].includes(to)) ||
      (from === "completed" && to === last && actor.role === "owner");
    if (!ok) return pgError("P0001", `INVALID_TRANSITION: ${from} -> ${to}`, 400);
    if (o.delivery_run_id && ((from === "ready_for_dispatch" && to === "out_for_delivery") || (from === "out_for_delivery" && to === "completed"))) {
      return pgError("P0001", "USE_DELIVERY_RUN", 400);
    }
    const trimmed = (reason ?? "").trim();
    if (to === "cancelled") {
      if (trimmed === "") return pgError("P0001", "REASON_REQUIRED", 400);
      if (from === "out_for_delivery") {
        o.stock_return_status = "pending_return";
        record(o, "stock_return", "none", "pending_return", actor);
      } else {
        restocked.push(o.id);
        o.stock_return_status = "restored";
        record(o, "stock_return", "none", "restored", actor);
      }
      o.cancel_reason = trimmed;
      o.cancelled_at = new Date(FIXED_NOW_MS).toISOString();
      if (o.payment_status === "pending") { o.payment_status = "cancelled"; record(o, "payment", "pending", "cancelled", actor); }
    }
    if (to === "completed") {
      o.completed_at = new Date(FIXED_NOW_MS).toISOString();
      if (o.payment_method === "cash" && o.payment_status === "pending") { o.payment_status = "paid"; record(o, "payment", "pending", "paid", actor); }
    }
    if (from === "completed") {
      o.completed_at = null;
      if (o.payment_method === "cash" && o.payment_status === "paid") { o.payment_status = "pending"; record(o, "payment", "paid", "pending", actor); }
    }
    o.order_status = to;
    o.status_changed_at = new Date(FIXED_NOW_MS).toISOString();
    record(o, "status", from, to, actor, to === "cancelled" ? trimmed : null);
    if (to === "ready_for_dispatch") attach(o);
    else if (o.delivery_run_id && ["confirmed", "preparing", "cancelled"].includes(to)) {
      const run = runs.find((r) => r.id === o.delivery_run_id);
      o.delivery_run_id = null;
      if (run) refreshRun(run);
    }
    return { status: 200, body: { order_id: o.id, order_status: to, payment_status: o.payment_status, stock_return_status: o.stock_return_status, changed: true } };
  }

  // ---- delivery runs (migration 0017) --------------------------------------------------------------------
  const today = new Date(FIXED_NOW_MS).toISOString().slice(0, 10);
  function attach(o: FakeOrder) {
    if (!o.delivery_window_id || !o.delivery_departure_time) return;
    let run = runs.find((r) => r.departure_time === o.delivery_departure_time && ["open", "claimed"].includes(r.status));
    if (!run) {
      run = { id: `run-${nextRunId++}`, run_date: today, status: "open", courier_id: null, courier_name: null, courier_phone: null, claimed_at: null, departed_at: null, departure_time: o.delivery_departure_time };
      runs.push(run);
    }
    o.delivery_run_id = run.id;
  }
  const inRun = (r: FakeRun, statuses: string[]) => orders.filter((o) => o.delivery_run_id === r.id && statuses.includes(o.order_status));
  function refreshRun(r: FakeRun) {
    if (r.status === "finished" || inRun(r, ["ready_for_dispatch", "out_for_delivery"]).length > 0) return;
    if (r.status === "open") runs.splice(runs.indexOf(r), 1);
    else r.status = "finished";
  }
  const houseNumber = (o: FakeOrder) => Number((o.house_number ?? "").replace(/\D/g, "")) || Number.MAX_SAFE_INTEGER;
  function courierRpc(rpc: string, args: Record<string, unknown>, user: { id: string; email: string }, role: string | null, actor: { label: string; role: string }) {
    const isCourier = role === "courier";
    const backOffice = role === "owner" || role === "staff";
    const nowIso = new Date(FIXED_NOW_MS).toISOString();
    if (rpc === "courier_list_open_runs" || rpc === "courier_my_runs") {
      if (!isCourier) return pgError("42501", "NOT_AUTHORIZED", 403);
      if (rpc === "courier_list_open_runs") {
        return { status: 200, body: runs.filter((r) => r.status === "open").map((r) => ({
          id: r.id, run_date: r.run_date, departure_time: r.departure_time,
          order_count: inRun(r, ["ready_for_dispatch"]).length,
          streets: [...new Set(inRun(r, ["ready_for_dispatch"]).map((o) => o.street))],
        })) };
      }
      return { status: 200, body: runs.filter((r) => r.courier_id === user.id && (["claimed", "departed"].includes(r.status) || (r.status === "finished" && r.run_date === today))).map((r) => ({
        id: r.id, status: r.status, run_date: r.run_date, departure_time: r.departure_time, claimed_at: r.claimed_at, departed_at: r.departed_at,
        stops: inRun(r, ["ready_for_dispatch", "out_for_delivery", "completed", "delivery_failed"])
          .sort((a, b) => (a.street ?? "").localeCompare(b.street ?? "") || houseNumber(a) - houseNumber(b))
          .map((o) => ({
            order_id: o.id, order_number: o.order_number, order_status: o.order_status, first_name: o.first_name, last_name: o.last_name, phone: o.phone,
            city: o.city, street: o.street, house_number: o.house_number, entrance: o.entrance, floor: o.floor, apartment: o.apartment,
            intercom_code: o.intercom_code, notes: o.delivery_notes, payment_method: o.payment_method, payment_status: o.payment_status,
            total_cents: o.total_cents, failed_reason: o.delivery_failed_reason ?? null,
          })),
      })) };
    }
    if (rpc === "claim_delivery_run" || rpc === "release_delivery_run" || rpc === "depart_delivery_run") {
      if (!isCourier && !(backOffice && rpc !== "claim_delivery_run")) return pgError("42501", "NOT_AUTHORIZED", 403);
      const run = runs.find((r) => r.id === args.p_run_id);
      if (!run) return pgError("P0001", "RUN_NOT_FOUND", 400);
      if (rpc === "claim_delivery_run") {
        if (run.courier_id === user.id && run.status !== "open") return { status: 200, body: { run_id: run.id, status: run.status, changed: false } };
        if (run.status !== "open") return pgError("P0001", "ALREADY_CLAIMED", 400);
        Object.assign(run, { status: "claimed", courier_id: user.id, courier_name: FAKE_COURIER_NAME, courier_phone: FAKE_COURIER_PHONE, claimed_at: nowIso });
        return { status: 200, body: { run_id: run.id, status: "claimed", changed: true } };
      }
      if (rpc === "release_delivery_run") {
        if (run.status === "open") return { status: 200, body: { run_id: run.id, status: "open", changed: false } };
        if (run.status !== "claimed") return pgError("P0001", "RUN_ALREADY_DEPARTED", 400);
        if (run.courier_id !== user.id && !backOffice) return pgError("42501", "NOT_AUTHORIZED", 403);
        Object.assign(run, { status: "open", courier_id: null, courier_name: null, courier_phone: null, claimed_at: null });
        return { status: 200, body: { run_id: run.id, status: "open", changed: true } };
      }
      if (run.status === "departed") return { status: 200, body: { run_id: run.id, status: "departed", changed: false } };
      if (run.status !== "claimed") return pgError("P0001", "RUN_NOT_CLAIMED", 400);
      if (run.courier_id !== user.id && !backOffice) return pgError("42501", "NOT_AUTHORIZED", 403);
      const ready = inRun(run, ["ready_for_dispatch"]);
      if (ready.length === 0) return pgError("P0001", "RUN_EMPTY", 400);
      for (const o of ready) { o.order_status = "out_for_delivery"; o.status_changed_at = nowIso; record(o, "status", "ready_for_dispatch", "out_for_delivery", actor); }
      Object.assign(run, { status: "departed", departed_at: nowIso });
      return { status: 200, body: { run_id: run.id, status: "departed", changed: true, orders: ready.length } };
    }
    // complete_delivery_stop / fail_delivery_stop
    if (!isCourier && !backOffice) return pgError("42501", "NOT_AUTHORIZED", 403);
    const o = orders.find((x) => x.id === args.p_order_id);
    if (!o || !o.delivery_run_id) return pgError("P0001", "ORDER_NOT_FOUND", 400);
    const run = runs.find((r) => r.id === o.delivery_run_id);
    if (run && run.courier_id !== user.id && !backOffice) return pgError("42501", "NOT_AUTHORIZED", 403);
    if (rpc === "complete_delivery_stop") {
      if (o.order_status === "completed") return { status: 200, body: { order_id: o.id, order_status: "completed", changed: false } };
      if (o.order_status !== "out_for_delivery") return pgError("P0001", `STALE_STATUS: ${o.order_status}`, 400);
      if (args.p_id_checked !== true) return pgError("P0001", "ID_CHECK_REQUIRED", 400);
      o.order_status = "completed"; o.completed_at = nowIso; o.status_changed_at = nowIso;
      if (o.payment_method === "cash" && o.payment_status === "pending") o.payment_status = "paid";
      record(o, "status", "out_for_delivery", "completed", actor);
    } else {
      const reason = String(args.p_reason ?? "").trim();
      if (o.order_status === "delivery_failed") return { status: 200, body: { order_id: o.id, order_status: "delivery_failed", changed: false } };
      if (o.order_status !== "out_for_delivery") return pgError("P0001", `STALE_STATUS: ${o.order_status}`, 400);
      if (reason === "") return pgError("P0001", "REASON_REQUIRED", 400);
      Object.assign(o, { order_status: "delivery_failed", delivery_failed_reason: reason, stock_return_status: "pending_return", status_changed_at: nowIso });
      record(o, "status", "out_for_delivery", "delivery_failed", actor, reason);
    }
    if (run) refreshRun(run);
    return { status: 200, body: { order_id: o.id, order_status: o.order_status, changed: true } };
  }

  function resolve(orderId: string, outcome: string, actor: { label: string; role: string }) {
    const o = orders.find((x) => x.id === orderId);
    if (!o) return pgError("P0001", "ORDER_NOT_FOUND", 400);
    if (outcome === "written_off" && actor.role !== "owner") return pgError("42501", "NOT_AUTHORIZED", 403);
    const target = outcome === "returned" ? "restored" : "written_off";
    if (o.stock_return_status === target) return { status: 200, body: { changed: false } };
    if (!["cancelled", "delivery_failed"].includes(o.order_status) || o.stock_return_status !== "pending_return") return pgError("P0001", `STALE_STATUS: ${o.stock_return_status}`, 400);
    if (outcome === "returned") restocked.push(o.id);
    record(o, "stock_return", "pending_return", target, actor);
    o.stock_return_status = target;
    return { status: 200, body: { changed: true } };
  }

  async function handle(ctx: StubRequestContext): Promise<boolean> {
    const { url, method, body, user, json } = ctx;
    const table = /^\/rest\/v1\/orders$/.test(url.pathname);
    const runsTable = /^\/rest\/v1\/delivery_runs$/.test(url.pathname);
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname)?.[1];
    const COURIER_RPCS = ["courier_list_open_runs", "courier_my_runs", "claim_delivery_run", "release_delivery_run", "depart_delivery_run", "complete_delivery_stop", "fail_delivery_stop"];
    if (rpc === "get_business_settings" && options.windows) {
      await json(200, { pickup_enabled: false, delivery_enabled: true, delivery_windows: [{ id: "w1", departure_time: "18:00:00", order_cutoff_time: "17:00:00" }] });
      return true;
    }
    if (!table && !runsTable && rpc !== "transition_order" && rpc !== "resolve_stock_return" && !(rpc && COURIER_RPCS.includes(rpc))) return false;

    if (failAll) { await json(failAll.status, failAll.body ?? { message: "boom" }); return true; }
    if (!user) { await json(401, { code: "42501", message: "permission denied", details: null, hint: null }); return true; }
    const role = roleOf(user);
    const actor = { label: user.email, role: role ?? "none" };
    const send = (r: { status: number; body: unknown }) => json(r.status, r.body);

    if (rpc && COURIER_RPCS.includes(rpc)) {
      if (!role) { await send(pgError("42501", "NOT_AUTHORIZED", 403)); return true; }
      const args = (body ?? {}) as Record<string, unknown>;
      rpcLog.push(`${rpc} ${JSON.stringify(args)} by ${user.email}`);
      await send(courierRpc(rpc, args, user, role, actor as { label: string; role: string }));
      return true;
    }

    if (runsTable) {
      if (role !== "owner" && role !== "staff") { await json(200, []); return true; }
      const statuses = /^in\.\((.*)\)$/.exec(url.searchParams.get("status") ?? "")?.[1]?.split(",");
      await json(200, runs.filter((r) => !statuses || statuses.includes(r.status)).map((r) => {
        const { departure_time, ...rest } = r;
        return { ...rest, delivery_windows: { departure_time } };
      }));
      return true;
    }

    if (rpc) {
      // back office only: a courier moves orders through his own run, never through transition_order
      if (!role || role === "courier") { await send(pgError("42501", "NOT_AUTHORIZED", 403)); return true; }
      const args = (body ?? {}) as Record<string, string | null>;
      rpcLog.push(`${rpc} ${JSON.stringify(args)} by ${user.email}`);
      await send(rpc === "transition_order"
        ? transition(args.p_order_id as string, args.p_expected_status as string, args.p_to_status as string, args.p_reason ?? null, actor as { label: string; role: string })
        : resolve(args.p_order_id as string, args.p_outcome as string, actor as { label: string; role: string }));
      return true;
    }

    if (method !== "GET" && method !== "HEAD") { await send(pgError("42501", 'permission denied for table orders', 403)); return true; }

    const visible = role === "owner" ? orders : role === "staff" ? orders.filter(staffCanSee) : [];
    const filtered = applyOrder(applyFilters(visible, url), url);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const limit = url.searchParams.get("limit");
    const page = limit ? filtered.slice(offset, offset + Number(limit)) : filtered;
    const wantsCount = /count=exact/.test(ctx.headers["prefer"] ?? "");
    const wantsObject = /vnd\.pgrst\.object/.test(ctx.headers["accept"] ?? "");
    const rows = shape(page, url);
    await ctx.route.fulfill({
      status: 200,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-expose-headers": "content-range",
        ...(wantsCount ? { "content-range": `${rows.length ? offset : "*"}-${offset + Math.max(rows.length - 1, 0)}/${filtered.length}` } : {}),
      },
      contentType: "application/json",
      body: JSON.stringify(wantsObject ? rows[0] ?? null : rows),
    });
    return true;
  }

  return {
    orders,
    runs,
    rpcLog,
    restocked,
    handle,
    byNumber: (n: number) => orders.find((o) => o.order_number === n)!,
    add: (o: FakeOrder) => orders.push(o),
    /** someone ELSE changes an order (another terminal) — bypasses the caller's screen entirely */
    externally: (n: number, to: string, reason = "בוטל על ידי עמית") =>
      transition(orders.find((o) => o.order_number === n)!.id, orders.find((o) => o.order_number === n)!.order_status, to, reason, { label: "other@example.test", role: "staff" }),
    failAll(f: typeof failAll) {
      failAll = f;
    },
  };
}

export type FakeOrdersDatabase = ReturnType<typeof createFakeOrdersDatabase>;
