import { useState, type FormEvent } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import type { SignedOutNotice } from "@/admin/adminConfig";
import type { SignInFailure, SignInResult } from "@/admin/useAdminSession";

/** One generic message for wrong email OR wrong password — never reveals whether an email exists. */
const FAILURE_MESSAGES: Record<Exclude<SignInFailure, "not-authorized">, string> = {
  "invalid-credentials": "האימייל או הסיסמה שגויים.",
  network: "אין חיבור לשרת. בדקו את החיבור ונסו שוב.",
  "too-many-attempts": "יותר מדי ניסיונות התחברות. נסו שוב בעוד מספר דקות.",
  unknown: "ההתחברות נכשלה. נסו שוב.",
};

const NOTICE_MESSAGES: Record<SignedOutNotice, string> = {
  "not-authorized": "החשבון הזה אינו מורשה לניהול.",
  idle: "נותקתם אוטומטית לאחר זמן ללא פעילות. התחברו שוב כדי להמשיך.",
};

const inputClasses =
  "w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-base text-brand-text placeholder:text-brand-text-muted outline-none transition-colors focus-visible:border-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold";

interface AdminLoginProps {
  notice: SignedOutNotice | null;
  onSignIn: (email: string, password: string) => Promise<SignInResult>;
}

/**
 * Email + password login. Deliberately minimal: no sign-up (the single admin is created in the Supabase
 * dashboard) and no "forgot password" (reset it there too). `autoComplete` values let password managers work.
 */
export function AdminLogin({ notice, onSignIn }: AdminLoginProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await onSignIn(email, password);
    if (!result.ok) {
      setBusy(false);
      // "not-authorized" is announced by the notice above the form (the session state carries it)
      if (result.reason !== "not-authorized") setError(FAILURE_MESSAGES[result.reason]);
      setPassword("");
    }
    // on success the parent replaces this screen with the dashboard
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-brand-bg px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-brand-border bg-brand-bg-elevated p-6 shadow-2xl sm:p-8">
        <div className="mb-6 text-center">
          <span className="font-display text-3xl text-brand-gold">בלגן</span>
          <h1 className="mt-2 text-lg font-semibold text-brand-text">כניסה לניהול</h1>
        </div>

        {notice && (
          <p role="status" className="mb-4 rounded-md border border-brand-border bg-brand-bg px-3 py-2 text-sm text-brand-text-muted">
            {NOTICE_MESSAGES[notice]}
          </p>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="admin-email" className="text-sm font-medium text-brand-text">
              אימייל
            </label>
            <input
              id="admin-email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              required
              dir="ltr"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className={inputClasses}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="admin-password" className="text-sm font-medium text-brand-text">
              סיסמה
            </label>
            <div className="relative">
              <input
                id="admin-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                required
                dir="ltr"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={`${inputClasses} pe-11`}
              />
              <button
                type="button"
                onClick={() => setShowPassword((shown) => !shown)}
                aria-label={showPassword ? "הסתר סיסמה" : "הצג סיסמה"}
                aria-pressed={showPassword}
                className="absolute inset-y-0 end-0 flex items-center px-3 text-brand-text-muted outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-gold"
              >
                {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>

          {error && (
            <p role="alert" className="rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
              {error}
            </p>
          )}

          <Button type="submit" size="lg" disabled={busy} className="w-full">
            {busy ? (
              <>
                <Loader2 size={18} className="animate-spin" aria-hidden="true" />
                מתחבר…
              </>
            ) : (
              "התחברות"
            )}
          </Button>
        </form>
      </div>
    </main>
  );
}
