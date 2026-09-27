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
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
