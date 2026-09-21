import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ADMIN_STORAGE_KEY } from "@/admin/adminConfig";

/**
 * The admin's Supabase client. Uses ONLY the public anon / publishable key — the service_role key must never
 * appear anywhere in this project. Everything the admin may read or write is enforced by the database
 * (Row Level Security + `is_admin()`, see supabase/migrations), not by this client or by hiding the route.
 *
 * This file is imported only from the lazily loaded admin code, so `@supabase/supabase-js` is never part of
 * the customer bundle.
 */
export interface AdminConfig {
  url: string;
  anonKey: string;
}

/** The Supabase connection from the Vite env, or null when it isn't configured. */
export function getAdminConfig(): AdminConfig | null {
  const url = (import.meta.env.VITE_SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
  const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
  return url !== "" && anonKey !== "" ? { url, anonKey } : null;
}

let client: SupabaseClient | null = null;

export function getAdminClient(config: AdminConfig): SupabaseClient {
  if (!client) {
    client = createClient(config.url, config.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
        storageKey: ADMIN_STORAGE_KEY,
      },
    });
  }
  return client;
}
