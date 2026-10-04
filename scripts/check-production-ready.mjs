#!/usr/bin/env node
/**
 * `npm run check:prod` — run after `npm run build`, before deploying. Fails (exit 1) if anything that exists only for
 * development could reach production:
 *   - an env var that switches a dev login on is set (in the environment, or in .env / .env.production*);
 *   - the built `dist/` contains a dev-only marker (the real-database test login, the mock login, the dev stub).
 * It also prints what still has to be done by hand — the full list is docs/PRODUCTION_CHECKLIST.md.
 *
 *   node scripts/check-production-ready.mjs [--dist <dir>] [--no-dist]
 * `.env.local` is git-ignored and never reaches a host, so it only produces a warning (it does feed `vite build` on THIS
 * machine, which is why a dev flag in it is worth knowing about).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const distArg = args.indexOf("--dist");
const DIST = distArg >= 0 ? resolve(args[distArg + 1]) : join(ROOT, "dist");
const CHECK_DIST = !args.includes("--no-dist");

/** Env vars that exist only for development logins. */
const DEV_ENV = ["VITE_CUSTOMER_AUTH", "VITE_TEST_MEMBER_EMAIL", "BALAGAN_DEV_REAL"];
/** Strings that must never appear in a deployable build. */
const DEV_MARKERS = ["BALAGAN_DEV_ONLY_", "mock-customer-token.", "VITE_TEST_MEMBER_EMAIL", "zz-member-probe", "zz-user-probe", "dev-club-stub"];

const problems = [];
const warnings = [];

for (const name of DEV_ENV) {
  if ((process.env[name] ?? "").trim() !== "") problems.push(`environment variable ${name} is set — it switches a development login on. Unset it for the build.`);
}

function setKeys(file) {
  const keys = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[2].replace(/^["']|["']$/g, "") !== "") keys.push(m[1]);
  }
  return keys;
}
for (const name of readdirSync(ROOT).filter((n) => n === ".env" || n.startsWith(".env."))) {
  if (name === ".env.example") continue;
  const hits = setKeys(join(ROOT, name)).filter((k) => DEV_ENV.includes(k));
  if (hits.length === 0) continue;
  const text = `${name} sets ${hits.join(", ")}`;
  if (name === ".env.local") warnings.push(`${text} (git-ignored, local only — but \`vite build\` on this machine reads it; comment it out for a production build)`);
  else problems.push(`${text} — dev-only variables must not be in a file that can reach a host.`);
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(js|mjs|css|html|map)$/.test(entry)) yield full;
  }
}
if (CHECK_DIST) {
  if (!existsSync(DIST)) {
    problems.push(`no build found at ${DIST} — run \`npm run build\` first (or pass --no-dist to check only the environment).`);
  } else {
    for (const file of walk(DIST)) {
      const code = readFileSync(file, "utf8");
      for (const marker of DEV_MARKERS) {
        if (code.includes(marker)) problems.push(`the build contains the dev-only marker "${marker}" (${file.slice(DIST.length + 1)})`);
      }
    }
  }
}

for (const w of warnings) console.log(`  WARN  ${w}`);
for (const p of problems) console.log(`  FAIL  ${p}`);
console.log(`
  Still by hand before going live (docs/PRODUCTION_CHECKLIST.md): a real SMS/OTP login adapter and the customer-permissions
  audit, Supabase public sign-ups state, the test accounts, rotated admin/staff passwords, no secrets in env files.`);
if (problems.length > 0) {
  console.log("\nNOT production-ready.");
  process.exit(1);
}
console.log("\nNo development-only login found in the environment or the build.");
