import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
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
      __CUSTOMER_AUTH__: JSON.stringify(env.VITE_CUSTOMER_AUTH === "mock" ? "mock" : "off"),
    },
  };
});
