import type { StubRequestContext } from "../auth/adminStubs";

/**
 * An in-memory stand-in for the owner's customer functions of migration 0013 (admin_customer_stats,
 * admin_list_customers, admin_export_audience), plugged into stubSupabase's `extra` hook. It enforces the rules that
 * matter to the screen the way the database does: owner only (is_admin()), deleted members never listed, an audience
 * contains only members whose LATEST consent covers the channel, every export is logged.
 */
export interface FakeMember {
  id: string;
  phone: string; // E.164
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  joined_at: string;
  last_order_at: string | null;
  orders_count: number;
  /** current marketing consent */
  marketing: boolean;
  channels: string[];
  changed_at: string;
  deleted_at?: string;
}

export interface ExportLogEntry {
  kind: string;
  count: number;
  actor: string;
}

export interface FakeCustomers {
  members: FakeMember[];
  exportsLog: ExportLogEntry[];
  /** every function the screen called: "admin_list_customers" etc. */
  calls: string[];
  /** make every function fail like a missing migration / a refusal */
  failWith: { status: number; body: unknown } | null;
  handle: (context: StubRequestContext) => Promise<boolean>;
}

const iso = (day: number) => `2026-09-${String(day).padStart(2, "0")}T07:00:00Z`;

/**
 * 30 live members (so the list needs a second page) + the special cases the exports must get right.
 * Phones +97252100001x.. are generic consenting members; the named ones below are the interesting ones.
 */
export function seedMembers(): FakeMember[] {
  const generic: FakeMember[] = Array.from({ length: 26 }, (_, i) => {
    const n = String(i + 1).padStart(2, "0");
    return {
      id: `m${n}`, phone: `+97252000${n.padStart(4, "0")}`, first_name: `חבר${n}`, last_name: "בדיקה", email: null,
      joined_at: iso(1 + (i % 19)), last_order_at: i % 3 === 0 ? iso(20) : null, orders_count: i % 3 === 0 ? 2 : 0,
      marketing: true, channels: ["sms", "email"], changed_at: iso(1 + (i % 19)),
    };
  });
  return [
    ...generic,
    { id: "dana", phone: "+972501112222", first_name: "דנה", last_name: "כהן", email: "dana@x.test", joined_at: iso(20), last_order_at: iso(20), orders_count: 5, marketing: true, channels: ["sms", "email"], changed_at: iso(20) },
    { id: "evil", phone: "+972503334444", first_name: '=HYPERLINK("http://evil","x")', last_name: "הנוכל", email: "evil@x.test", joined_at: iso(21), last_order_at: null, orders_count: 0, marketing: true, channels: ["sms"], changed_at: iso(21) },
    { id: "oren", phone: "+972504445555", first_name: "אורן", last_name: "לוי", email: "oren@x.test", joined_at: iso(18), last_order_at: iso(19), orders_count: 1, marketing: false, channels: [], changed_at: iso(19) },
    { id: "michal", phone: "+972505556666", first_name: "מיכל", last_name: "בר", email: "michal@x.test", joined_at: iso(17), last_order_at: null, orders_count: 0, marketing: true, channels: ["email"], changed_at: iso(17) },
    { id: "gone", phone: "+972506667777", first_name: null, last_name: null, email: null, joined_at: iso(10), last_order_at: null, orders_count: 0, marketing: false, channels: [], changed_at: iso(22), deleted_at: iso(22) },
  ];
}

export function createFakeCustomers(members: FakeMember[] = seedMembers()): FakeCustomers {
  const state: FakeCustomers = {
    members,
    exportsLog: [],
    calls: [],
    failWith: null,
    handle: async (ctx) => {
      const name = /^\/rest\/v1\/rpc\/(admin_(?:customer_stats|list_customers|export_audience))$/.exec(ctx.url.pathname)?.[1];
      if (!name) return false;
      state.calls.push(name);
      if (state.failWith) {
        await ctx.json(state.failWith.status, state.failWith.body);
        return true;
      }
      if (!ctx.user?.isAdmin) {
        // is_admin() is owner-only: staff, plain logged-in users and anon are all refused
        await ctx.json(403, { code: "42501", message: "NOT_AUTHORIZED" });
        return true;
      }
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const live = state.members.filter((m) => !m.deleted_at);

      if (name === "admin_customer_stats") {
        const last: Record<string, { at: string; count: number }> = {};
        state.exportsLog.forEach((e, i) => (last[e.kind] = { at: iso(23 + Math.min(i, 5)), count: e.count }));
        await ctx.json(200, {
          members: live.length,
          joined_30d: live.filter((m) => m.joined_at >= iso(1)).length,
          with_orders: live.filter((m) => m.last_order_at).length,
          marketing_sms: live.filter((m) => m.marketing && m.channels.includes("sms")).length,
          marketing_email: live.filter((m) => m.marketing && m.channels.includes("email") && m.email).length,
          withdrawn: live.filter((m) => !m.marketing).length,
          deleted: state.members.filter((m) => m.deleted_at).length,
          last_exports: last,
        });
        return true;
      }

      if (name === "admin_list_customers") {
        const filter = String(body.p_marketing ?? "all");
        if (!["all", "consenting", "sms", "email", "withdrawn"].includes(filter)) {
          await ctx.json(400, { message: "INVALID_FILTER" });
          return true;
        }
        const term = typeof body.p_search === "string" ? body.p_search.trim() : "";
        const digits = term.replace(/\D/g, "").replace(/^0+/, "");
        const filtered = live.filter((m) => {
          if (term) {
            const hit = [m.first_name, m.last_name, m.email].some((f) => f?.toLowerCase().includes(term.toLowerCase())) || (digits.length >= 3 && m.phone.includes(digits));
            if (!hit) return false;
          }
          switch (filter) {
            case "consenting": return m.marketing;
            case "sms": return m.marketing && m.channels.includes("sms");
            case "email": return m.marketing && m.channels.includes("email") && !!m.email;
            case "withdrawn": return !m.marketing;
            default: return true;
          }
        });
        filtered.sort((a, b) => (a.joined_at < b.joined_at ? 1 : a.joined_at > b.joined_at ? -1 : a.id < b.id ? -1 : 1));
        const limit = Math.min(Math.max(Number(body.p_limit ?? 50), 1), 100);
        const offset = Math.max(Number(body.p_offset ?? 0), 0);
        await ctx.json(200, {
          total: filtered.length,
          rows: filtered.slice(offset, offset + limit).map((m) => ({
            id: m.id, phone: m.phone, first_name: m.first_name, last_name: m.last_name, email: m.email, joined_at: m.joined_at,
            last_order_at: m.last_order_at, orders_count: m.orders_count, marketing: m.marketing, marketing_channels: m.channels, marketing_changed_at: m.changed_at,
          })),
        });
        return true;
      }

      // admin_export_audience
      const kind = String(body.p_kind ?? "");
      let rows: Record<string, unknown>[];
      if (kind === "sms") {
        rows = live.filter((m) => m.marketing && m.channels.includes("sms")).map((m) => ({ phone: m.phone, first_name: m.first_name, last_name: m.last_name, consent_at: m.changed_at, wording_version: "v1" }));
      } else if (kind === "email") {
        rows = live.filter((m) => m.marketing && m.channels.includes("email") && m.email).map((m) => ({ email: m.email, first_name: m.first_name, last_name: m.last_name, phone: m.phone, consent_at: m.changed_at, wording_version: "v1" }));
      } else if (kind === "suppression") {
        rows = [
          ...live.filter((m) => !m.marketing).map((m) => ({ phone: m.phone, email: m.email, reason: "withdrawn", at: m.changed_at })),
          ...state.members.filter((m) => m.deleted_at).map((m) => ({ phone: m.phone, email: null, reason: "deleted", at: m.deleted_at })),
        ];
      } else {
        await ctx.json(400, { message: "INVALID_KIND" });
        return true;
      }
      state.exportsLog.push({ kind, count: rows.length, actor: ctx.user.email });
      await ctx.json(200, rows);
      return true;
    },
  };
  return state;
}
