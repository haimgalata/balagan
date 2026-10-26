import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { AdminLogin } from "@/admin/AdminLogin";
import { AdminShell } from "@/admin/AdminShell";
import { useAdminSession } from "@/admin/useAdminSession";

function CenteredCard({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-bg px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-brand-border bg-brand-bg-elevated p-6 text-center text-brand-text sm:p-8">
        {children}
      </div>
    </main>
  );
}

/**
 * Root of the private admin area (`/admin`). Loaded lazily by `src/main.tsx` only when the address is under
 * `/admin`, so none of this — including the Supabase client — is ever downloaded on the customer site.
 * Nothing on the customer site links here.
 *
 * What is shown depends on the session state; what is ALLOWED is decided by the database (see
 * `useAdminSession` and supabase/migrations), never by this screen.
 */
export default function AdminApp() {
  const { state, client, signIn, signOut, retry } = useAdminSession();

  // Keep the admin out of search engines and give the tab a proper title.
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex,nofollow,noarchive";
    document.head.appendChild(meta);
    const previousTitle = document.title;
    document.title = "ניהול · בלאגן";
    return () => {
      meta.remove();
      document.title = previousTitle;
    };
  }, []);

  switch (state.status) {
    case "loading":
      return (
        <CenteredCard>
          <div role="status" className="flex flex-col items-center gap-3 text-brand-text-muted">
            <Loader2 size={28} className="animate-spin text-brand-gold" aria-hidden="true" />
            <span className="text-sm">טוען…</span>
          </div>
        </CenteredCard>
      );

    case "unconfigured":
      return (
        <CenteredCard>
          <h1 className="mb-2 text-lg font-semibold">החיבור למסד הנתונים לא הוגדר</h1>
          <p className="text-sm text-brand-text-muted" dir="ltr">
            Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example).
          </p>
        </CenteredCard>
      );

    case "error":
      return (
        <CenteredCard>
          <h1 className="mb-2 text-lg font-semibold">לא ניתן לאמת את ההרשאה</h1>
          <p className="mb-4 text-sm text-brand-text-muted">בדקו את החיבור לאינטרנט ונסו שוב.</p>
          <div className="flex flex-col gap-2">
            <Button onClick={retry}>נסו שוב</Button>
            <Button variant="ghost" onClick={() => void signOut()}>
              התנתקות
            </Button>
          </div>
        </CenteredCard>
      );

    case "signedOut":
      return <AdminLogin notice={state.notice} onSignIn={signIn} />;

    case "admin":
      return client ? <AdminShell email={state.email} role={state.role} courier={state.courier} client={client} onSignOut={() => void signOut()} /> : null;
  }
}
