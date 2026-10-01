#!/usr/bin/env node
/**
 * `npm run dev:club` — starts everything needed to try the club login in a browser by hand:
 *   1. the local fake backend (scripts/dev-club-stub.mjs) on :5199 — in memory, never your real Supabase project;
 *   2. the app (Vite) on http://localhost:5195, built WITH the test-only mock login and pointed at that fake backend.
 *
 * The environment is set explicitly here, so it also overrides anything in your .env.local (which may point at the real
 * project — the mock login's fake token would be rejected by it). Stop with Ctrl+C (both processes end).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STUB_PORT = process.env.STUB_PORT ?? "5199";
const APP_PORT = process.env.APP_PORT ?? "5195";

const env = {
  ...process.env,
  STUB_PORT,
  VITE_CATALOG_SOURCE: "supabase",
  VITE_SUPABASE_URL: `http://127.0.0.1:${STUB_PORT}`,
  VITE_SUPABASE_ANON_KEY: "dev-stub-key",
  VITE_CUSTOMER_AUTH: "mock",
};

const children = [
  spawn(process.execPath, [join(ROOT, "scripts", "dev-club-stub.mjs")], { cwd: ROOT, env, stdio: "inherit" }),
  spawn(process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--port", APP_PORT, "--strictPort"], { cwd: ROOT, env, stdio: "inherit" }),
];

console.log(`
  Club login — manual test
  ------------------------
  App:            http://localhost:${APP_PORT}
  Existing member 050-111-2222   (דנה כהן: saved addresses + past orders)
  Any other valid mobile 05X-XXXXXXX = a NEW phone (you get the mandatory confirmation, then become a member)
  One-time code:  123456
  Pages:          / (header "אזור אישי"), /checkout (add something to the cart first), /account
`);

const stop = () => children.forEach((c) => { try { c.kill(); } catch { /* already gone */ } });
process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });
children.forEach((c) => c.on("exit", () => { stop(); process.exit(0); }));
