import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  // "realtest" = password login of one real test member against the real database, for the dev server only. It must
  // never be baked into a build that could be deployed.
  if (env.VITE_CUSTOMER_AUTH === "realtest" && command !== "serve") {
    throw new Error('VITE_CUSTOMER_AUTH=realtest is for the dev server only (npm run dev:club:real) — refusing to build.');
  }
  return {
    plugins: [react()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    define: {
      // Compile-time switch for the customer (club) login. A real constant — not an import.meta.env lookup — so a
      // build with it "off" contains none of the account code, and the test-only mock adapter can never ship.
      // Today the only non-"off" value is "mock" (e2e tests); a real adapter adds its own value later.
      __CUSTOMER_AUTH__: JSON.stringify(env.VITE_CUSTOMER_AUTH === "mock" || env.VITE_CUSTOMER_AUTH === "realtest" ? env.VITE_CUSTOMER_AUTH : "off"),
    },
  };
});
