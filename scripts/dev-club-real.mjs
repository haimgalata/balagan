#!/usr/bin/env node
/**
 * `npm run dev:club:real` — the app on http://localhost:5196 against your REAL Supabase project (URL + anon key from
 * .env.local), with the DEV-ONLY test-member login (password of ONE dedicated test account; no SMS, no sign-ups).
 *
 * Needs in .env.local (or the environment): VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_TEST_MEMBER_EMAIL.
 * The password is typed in the login screen — never put it in a file. Everything you do here writes REAL rows.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_PORT = process.env.APP_PORT ?? "5196";

const fromFile = {};
try {
  for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split(/\r?\n/)) {
    const m = /^\s*(VITE_\w+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) fromFile[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { /* no .env.local */ }
const get = (k) => (process.env[k] ?? fromFile[k] ?? "").trim();

const url = get("VITE_SUPABASE_URL");
const key = get("VITE_SUPABASE_ANON_KEY");
const email = get("VITE_TEST_MEMBER_EMAIL");
if (!/^https:\/\/.+\.supabase\.co/.test(url) || key === "" || email === "") {
  console.error("Missing/invalid VITE_SUPABASE_URL (a real https://….supabase.co project), VITE_SUPABASE_ANON_KEY or VITE_TEST_MEMBER_EMAIL (.env.local).");
  process.exit(1);
}

const env = { ...process.env, VITE_CATALOG_SOURCE: "supabase", VITE_CUSTOMER_AUTH: "realtest", VITE_TEST_MEMBER_EMAIL: email };

console.log(`
  Club login — REAL DATABASE test
  -------------------------------
  App:      http://localhost:${APP_PORT}     Project: ${new URL(url).host}
  Account:  ${email} (the only account this login accepts; owner/staff are refused)
  Login:    type the account's phone number, then its PASSWORD in the "code" box.
  WARNING:  join / orders / addresses / consent written here are REAL rows (a cash order deducts real stock).
`);

const child = spawn(process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--host", "0.0.0.0", "--port", APP_PORT, "--strictPort"], { cwd: ROOT, env, stdio: "inherit" });
const stop = () => { try { child.kill(); } catch { /* gone */ } };
process.on("SIGINT", () => { stop(); process.exit(0); });
process.on("SIGTERM", () => { stop(); process.exit(0); });
child.on("exit", (code) => process.exit(code ?? 0));
