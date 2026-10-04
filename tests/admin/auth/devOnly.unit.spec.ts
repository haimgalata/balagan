import { test, expect } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Development-only behaviour must not be able to reach production (docs/PRODUCTION_CHECKLIST.md): the real-database test
 * login (`realtest`) is refused by the build and by a dev server nobody asked for it, and `npm run check:prod` fails on any
 * dev flag in the environment or any dev marker in a build.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const VITE = join(ROOT, "node_modules", "vite", "bin", "vite.js");
const CHECK = join(ROOT, "scripts", "check-production-ready.mjs");

/** A clean environment: no dev flags inherited from the machine this runs on. */
const cleanEnv = (extra: Record<string, string> = {}) => {
  const env = { ...process.env, ...extra } as Record<string, string | undefined>;
  for (const name of ["VITE_CUSTOMER_AUTH", "VITE_TEST_MEMBER_EMAIL", "BALAGAN_DEV_REAL"]) if (!(name in extra)) delete env[name];
  return env as NodeJS.ProcessEnv;
};

const run = (file: string, args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [file, ...args], { cwd: ROOT, env, encoding: "utf8" });

test("a build with the realtest login is refused — with or without the dev opt-in", () => {
  for (const extra of [{ VITE_CUSTOMER_AUTH: "realtest" }, { VITE_CUSTOMER_AUTH: "realtest", BALAGAN_DEV_REAL: "1" }]) {
    const out = mkdtempSync(join(tmpdir(), "balagan-refuse-"));
    try {
      const r = run(VITE, ["build", "--outDir", out, "--emptyOutDir"], cleanEnv({ VITE_CATALOG_SOURCE: "supabase", VITE_SUPABASE_URL: "https://stub.supabase.test", VITE_SUPABASE_ANON_KEY: "stub", ...extra }));
      expect(r.status, JSON.stringify(extra)).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain("realtest");
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
});

test("the dev server honours realtest only when `npm run dev:club:real` opted in", () => {
  const probe = `import("vite").then((v) => v.resolveConfig({ configFile: ${JSON.stringify(join(ROOT, "vite.config.ts"))}, root: ${JSON.stringify(ROOT)} }, "serve", "development")).then(() => process.exit(0), (e) => { console.error(String(e.message)); process.exit(3); })`;
  const resolveWith = (extra: Record<string, string>) => spawnSync(process.execPath, ["-e", probe], { cwd: ROOT, env: cleanEnv(extra), encoding: "utf8" });
  const stray = resolveWith({ VITE_CUSTOMER_AUTH: "realtest" });
  expect(stray.status, "a stray VITE_CUSTOMER_AUTH=realtest must not switch it on").toBe(3);
  expect(stray.stderr).toContain("BALAGAN_DEV_REAL");
  expect(resolveWith({ VITE_CUSTOMER_AUTH: "realtest", BALAGAN_DEV_REAL: "1" }).status, "the launcher's opt-in works").toBe(0);
  expect(resolveWith({}).status, "no flag at all is fine").toBe(0);
});

test("check:prod passes a clean environment with a clean build", () => {
  const dist = mkdtempSync(join(tmpdir(), "balagan-dist-"));
  try {
    mkdirSync(join(dist, "assets"));
    writeFileSync(join(dist, "assets", "index-abc.js"), 'console.log("hello customers");');
    const r = run(CHECK, ["--dist", dist], cleanEnv());
    expect(r.status, r.stdout).toBe(0);
    expect(r.stdout).toContain("No development-only login found");
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
});

test("check:prod fails on a dev marker in the build", () => {
  for (const marker of ["BALAGAN_DEV_ONLY_REALTEST", "mock-customer-token.", "zz-member-probe", "VITE_TEST_MEMBER_EMAIL"]) {
    const dist = mkdtempSync(join(tmpdir(), "balagan-dist-"));
    try {
      mkdirSync(join(dist, "assets"));
      writeFileSync(join(dist, "assets", "index-abc.js"), `var x="${marker}";`);
      const r = run(CHECK, ["--dist", dist], cleanEnv());
      expect(r.status, marker).toBe(1);
      expect(r.stdout).toContain(marker.startsWith("BALAGAN_DEV_ONLY_") ? "BALAGAN_DEV_ONLY_" : marker); // (reported by its prefix)
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
  }
});

test("check:prod fails when a dev flag is set in the environment, and when there is no build to check", () => {
  for (const name of ["VITE_CUSTOMER_AUTH", "VITE_TEST_MEMBER_EMAIL", "BALAGAN_DEV_REAL"]) {
    const r = run(CHECK, ["--no-dist"], cleanEnv({ [name]: "x" }));
    expect(r.status, name).toBe(1);
    expect(r.stdout).toContain(name);
  }
  expect(run(CHECK, ["--no-dist"], cleanEnv()).status, "clean environment, environment-only check").toBe(0);
  const missing = run(CHECK, ["--dist", join(tmpdir(), "balagan-no-such-dist")], cleanEnv());
  expect(missing.status).toBe(1);
  expect(missing.stdout).toContain("npm run build");
});

test("the real build contains no dev marker (what check:prod looks at)", () => {
  test.setTimeout(240_000);
  const out = mkdtempSync(join(tmpdir(), "balagan-prodbuild-"));
  try {
    execFileSync(process.execPath, [VITE, "build", "--outDir", out, "--emptyOutDir"], {
      cwd: ROOT, stdio: "pipe",
      env: cleanEnv({ VITE_CATALOG_SOURCE: "supabase", VITE_SUPABASE_URL: "https://stub.supabase.test", VITE_SUPABASE_ANON_KEY: "stub-anon-key" }),
    });
    const r = run(CHECK, ["--dist", out], cleanEnv());
    expect(r.status, r.stdout).toBe(0);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
