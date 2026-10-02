/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Supabase project URL, e.g. https://xxxx.supabase.co (public value). */
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase anon / publishable key (public by design — never put the service_role key here). */
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /**
   * Where the storefront reads its catalog from. Defaults to "supabase" when the two
   * variables above are set and "static" (the bundled src/storefront/data files) otherwise.
   * Set to "static" to instantly roll back to the built-in catalog.
   */
  readonly VITE_CATALOG_SOURCE?: "supabase" | "static";
  /** realtest login only (`npm run dev:club:real`): the one dedicated test member's e-mail. Never a password. */
  readonly VITE_TEST_MEMBER_EMAIL?: string;
}

/**
 * Which customer (club) login the build includes — injected by vite.config.ts from VITE_CUSTOMER_AUTH.
 * "off" (the default, and what production uses until a real SMS/OTP adapter is chosen) leaves the account
 * drawer as the inert "coming soon" panel and ships none of the account code. "mock" is for e2e tests only.
 */
declare const __CUSTOMER_AUTH__: "off" | "mock" | "realtest";

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
