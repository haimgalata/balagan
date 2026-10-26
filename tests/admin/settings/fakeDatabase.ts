import type { StubRequestContext } from "../auth/adminStubs";

/**
 * An in-memory stand-in for the two Business Settings tables and their public RPC (see
 * supabase/migrations/0008_business_settings.sql), used by the settings admin tests. Mirrors the rules
 * validated separately (PGlite replay + scripts/security-test.mjs): the `business_hours_times_when_open`
 * check constraint, the `business_settings` singleton (id = 1) and its non-negative amount checks, and
 * admin-only access (RLS stand-in — only an admin sees any rows).
 */
export type ScheduleType = "store" | "orders";
export interface FakeHourRow {
  schedule_type: ScheduleType;
  day_of_week: number;
  is_open: boolean;
  open_time: string | null;
  close_time: string | null;
}
export interface FakeSettingsRow {
  id: number;
  min_order_cents: number;
  delivery_fee_cents: number;
  orders_paused: boolean;
  /** migration 0017 — only present when the fake is created with `windows: true` */
  delivery_advance_hours?: number;
}
export interface FakeWindowRow {
  id: string;
  departure_time: string;
  order_cutoff_time: string;
  capacity: number | null;
  is_active: boolean;
}

/** PostgREST-shaped error response. */
const pgError = (code: string, message: string, status: number, details: string | null = null) => ({ status, body: { code, message, details, hint: null } });

const PLACEHOLDER_WEEK: [boolean, string | null, string | null][] = [
  [true, "09:00", "23:00"], [true, "09:00", "23:00"], [true, "09:00", "23:00"],
  [true, "09:00", "23:00"], [true, "09:00", "23:00"], [true, "09:00", "16:00"],
  [false, null, null],
];

export function createFakeDatabase(options: { windows?: boolean } = {}) {
  /** delivery windows (migration 0017); `windows: false` behaves like a database that has not applied it */
  const windows: FakeWindowRow[] = [];
  let nextWindowId = 1;
  const withSeconds = (t: unknown) => (typeof t === "string" && /^\d{2}:\d{2}$/.test(t) ? `${t}:00` : t);
  // ---- seed (mirrors 0008's own seed values) ----------------------------------------------
  const hours: FakeHourRow[] = [];
  for (const schedule_type of ["store", "orders"] as const) {
    PLACEHOLDER_WEEK.forEach(([is_open, open_time, close_time], day_of_week) => hours.push({ schedule_type, day_of_week, is_open, open_time, close_time }));
  }
  const settings: FakeSettingsRow = { id: 1, min_order_cents: 5000, delivery_fee_cents: 1500, orders_paused: false, ...(options.windows ? { delivery_advance_hours: 4 } : {}) };
  const log: string[] = [];
  /** Make the next data request fail: an HTTP error, or a dropped connection. */
  let failNext: { status: number; body?: unknown } | "network" | null = null;
  /** Make EVERY data request fail until cleared (a one-shot failure can be absorbed by React StrictMode's double load in dev, or by this screen's two parallel requests). */
  let failAll: { status: number; body?: unknown } | null = null;

  function rpcOutput() {
    const byType = (t: ScheduleType) =>
      hours.filter((h) => h.schedule_type === t)
        .sort((a, b) => a.day_of_week - b.day_of_week)
        .map((h) => ({ day_of_week: h.day_of_week, is_open: h.is_open, open_time: h.open_time, close_time: h.close_time }));
    return {
      store_hours: byType("store"), order_hours: byType("orders"), min_order_cents: settings.min_order_cents, delivery_fee_cents: settings.delivery_fee_cents, orders_paused: settings.orders_paused,
      ...(options.windows ? { delivery_advance_hours: settings.delivery_advance_hours, delivery_windows: windows.filter((w) => w.is_active).map((w) => ({ id: w.id, departure_time: w.departure_time, order_cutoff_time: w.order_cutoff_time })) } : {}),
    };
  }

  // ---- generic PostgREST subset (same shape as the other steps' fake databases) -----------
  function applyFilters<T extends object>(rows: T[], url: URL): T[] {
    let out = rows;
    for (const [key, value] of url.searchParams) {
      if (["select", "order", "limit", "offset"].includes(key)) continue;
      const eq = /^eq\.(.*)$/.exec(value);
      if (eq) out = out.filter((row) => String((row as Record<string, unknown>)[key]) === eq[1]);
    }
    return out;
  }
  function applyOrder<T extends object>(rows: T[], url: URL): T[] {
    const order = url.searchParams.get("order");
    if (!order) return rows;
    const [column] = order.split(".");
    return [...rows].sort((a, b) => Number((a as Record<string, unknown>)[column]) - Number((b as Record<string, unknown>)[column]));
  }
  function project<T extends object>(rows: T[], url: URL): Partial<T>[] {
    const select = url.searchParams.get("select");
    if (!select || select === "*") return rows;
    const columns = select.split(",");
    return rows.map((row) => Object.fromEntries(columns.map((c) => [c, (row as Record<string, unknown>)[c]])) as Partial<T>);
  }

  async function handle(ctx: StubRequestContext): Promise<boolean> {
    const { url, method, body, user, json } = ctx;
    const table = /^\/rest\/v1\/(business_hours|business_settings|delivery_windows)$/.exec(url.pathname)?.[1] as "business_hours" | "business_settings" | "delivery_windows" | undefined;
    const rpc = /^\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (!table && !rpc) return false;

    if (rpc === "get_business_settings") { await json(200, rpcOutput()); return true; }
    if (rpc === "is_admin" || rpc === "get_my_role" || rpc === "get_my_access") return false; // the base stub answers it
    if (rpc) return false;

    if (failAll) { await json(failAll.status, failAll.body ?? { message: "boom" }); return true; }
    if (failNext) {
      const failure = failNext; failNext = null;
      if (failure === "network") { await ctx.route.abort("connectionrefused"); return true; }
      await json(failure.status, failure.body ?? { message: "boom" });
      return true;
    }

    const send = (r: { status: number; body: unknown }) => json(r.status, r.body);
    const isAdmin = user?.isAdmin === true;
    if (table === "delivery_windows" && !options.windows) {
      await send(pgError("PGRST205", "Could not find the table 'public.delivery_windows' in the schema cache", 404));
      return true;
    }
    const preferReturn = /return=representation/.test(ctx.headers["prefer"] ?? "");
    const wantsObject = /vnd\.pgrst\.object/.test(ctx.headers["accept"] ?? "");
    const asBody = (rows: unknown[]) => (wantsObject ? rows[0] ?? null : rows);
    if (!user) { await send(pgError("42501", `permission denied for table ${table}`, 401)); return true; }

    const rowsOf = (): object[] => (table === "business_hours" ? hours : table === "delivery_windows" ? windows : [settings]);
    if (method === "GET" || method === "HEAD") {
      const visible = isAdmin ? applyFilters(rowsOf(), url) : [];
      const rows = project(applyOrder(visible, url), url);
      await json(200, method === "HEAD" ? null : asBody(rows));
      return true;
    }
    if (!isAdmin) { await send(pgError("42501", `new row violates row-level security policy for table "${table}"`, 403)); return true; }

    if (table === "delivery_windows") {
      const invalid = (row: Partial<FakeWindowRow>) =>
        (row.order_cutoff_time !== undefined && row.departure_time !== undefined && String(row.order_cutoff_time) > String(row.departure_time)) ||
        (row.capacity !== undefined && row.capacity !== null && Number(row.capacity) <= 0);
      if (method === "POST") {
        const row = { ...(body as Record<string, unknown>) } as Partial<FakeWindowRow>;
        row.departure_time = withSeconds(row.departure_time) as string;
        row.order_cutoff_time = withSeconds(row.order_cutoff_time) as string;
        if (invalid(row)) { await send(pgError("23514", 'new row for relation "delivery_windows" violates check constraint "delivery_windows_cutoff_before_departure"', 400)); return true; }
        windows.push({ id: `win-${nextWindowId++}`, capacity: null, is_active: true, ...row } as FakeWindowRow);
        log.push(`insert delivery_windows: ${JSON.stringify(row)}`);
        await json(201, null);
        return true;
      }
      if (method === "PATCH") {
        const patch = { ...(body as Record<string, unknown>) } as Partial<FakeWindowRow>;
        if (patch.departure_time !== undefined) patch.departure_time = withSeconds(patch.departure_time) as string;
        if (patch.order_cutoff_time !== undefined) patch.order_cutoff_time = withSeconds(patch.order_cutoff_time) as string;
        for (const target of applyFilters(windows, url)) {
          if (invalid({ ...target, ...patch })) { await send(pgError("23514", 'new row for relation "delivery_windows" violates check constraint "delivery_windows_cutoff_before_departure"', 400)); return true; }
          Object.assign(target, patch);
        }
        log.push(`update delivery_windows: ${JSON.stringify(patch)}`);
        await json(204, null);
        return true;
      }
      if (method === "DELETE") {
        for (const target of applyFilters(windows, url)) windows.splice(windows.indexOf(target), 1);
        log.push("delete delivery_windows");
        await json(204, null);
        return true;
      }
    }

    if (method === "PATCH") {
      const targets = applyFilters(rowsOf(), url) as (FakeHourRow | FakeSettingsRow)[];
      const patch = (body ?? {}) as Record<string, unknown>;
      for (const target of targets) {
        const next = { ...target, ...patch } as FakeHourRow & FakeSettingsRow;
        if (table === "business_hours" && next.is_open && (!next.open_time || !next.close_time || next.open_time >= next.close_time)) {
          await send(pgError("23514", 'new row violates check constraint "business_hours_times_when_open"', 400));
          return true;
        }
        if (table === "business_settings" && (Number(next.min_order_cents) < 0 || Number(next.delivery_fee_cents) < 0)) {
          await send(pgError("23514", 'new row violates check constraint "business_settings_min_order_cents_check"', 400));
          return true;
        }
        Object.assign(target, patch);
      }
      log.push(`update ${table}: ${JSON.stringify(patch)}`);
      await json(preferReturn ? 200 : 204, preferReturn ? asBody(targets) : null);
      return true;
    }
    if (method === "POST" && table === "business_settings") {
      // the singleton check (id = 1) — nothing in the admin UI does this, only a probe would
      await send(pgError("23514", 'new row violates check constraint "business_settings_id_check"', 400));
      return true;
    }
    return false;
  }

  return {
    hours,
    windows,
    settings,
    log,
    handle,
    rpcOutput,
    failNext(failure: NonNullable<typeof failNext>) {
      failNext = failure;
    },
    failAll(failure: typeof failAll) {
      failAll = failure;
    },
    hourRow: (scheduleType: ScheduleType, dayOfWeek: number) => hours.find((h) => h.schedule_type === scheduleType && h.day_of_week === dayOfWeek)!,
  };
}

export type FakeDatabase = ReturnType<typeof createFakeDatabase>;
