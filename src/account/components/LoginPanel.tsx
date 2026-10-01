import { useEffect, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { formatLocalPhone } from "@/storefront/lib/phone";
import { useCustomerSession } from "@/account/CustomerSessionContext";
import { CustomerAuthError } from "@/account/types";

const inputClasses =
  "w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-base text-brand-text placeholder:text-brand-text-muted outline-none transition-colors focus-visible:border-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold";

const RESEND_SECONDS = 30;
const CODE_LENGTH = 6;

function describeAuthError(error: unknown): string {
  const code = error instanceof CustomerAuthError ? error.code : "NETWORK";
  switch (code) {
    case "INVALID_PHONE":
      return "נא להזין מספר טלפון נייד תקין (05X-XXXXXXX).";
    case "INVALID_CODE":
      return "הקוד שגוי או שפג תוקפו. אפשר לבקש קוד חדש.";
    case "TOO_MANY_REQUESTS":
      return "נשלחו יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.";
    default:
      return "לא הצלחנו להתחבר לשירות. בדקו את החיבור ונסו שוב.";
  }
}

/**
 * Phone -> one-time code. Used in the account drawer and (next phase) at the top of checkout, so it only talks to
 * the session context and says nothing about where it is shown. `onContinueAsGuest` adds the always-available
 * "no thanks" door (checkout passes it; the drawer doesn't need it, closing the drawer is the same thing).
 */
export function LoginPanel({ onContinueAsGuest }: { onContinueAsGuest?: () => void }) {
  const { sendCode, verifyCode } = useCustomerSession();
  const [phone, setPhone] = useState("");
  const [e164, setE164] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const codeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  useEffect(() => {
    if (e164) codeInputRef.current?.focus();
  }, [e164]);

  const submitPhone = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setE164(await sendCode(phone));
      setCode("");
      setCooldown(RESEND_SECONDS);
    } catch (caught) {
      setError(describeAuthError(caught));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (value: string) => {
    if (busy || !e164) return;
    setBusy(true);
    setError(null);
    try {
      await verifyCode(e164, value);
      // success: the session context switches the panel to the next screen
    } catch (caught) {
      setError(describeAuthError(caught));
      setCode("");
      setBusy(false);
      codeInputRef.current?.focus();
    }
  };

  const onCodeChange = (raw: string) => {
    const digits = raw.replace(/\D/g, "").slice(0, CODE_LENGTH);
    setCode(digits);
    if (digits.length === CODE_LENGTH) void submitCode(digits);
  };

  const resend = async () => {
    if (!e164 || cooldown > 0 || busy) return;
    setError(null);
    try {
      await sendCode(e164);
      setCooldown(RESEND_SECONDS);
    } catch (caught) {
      setError(describeAuthError(caught));
    }
  };

  if (e164) {
    return (
      <form
        className="flex flex-col gap-4 px-6 py-8"
        onSubmit={(event) => {
          event.preventDefault();
          void submitCode(code);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <p className="text-base font-semibold text-brand-text">הקלידו את הקוד שקיבלתם</p>
          <p className="text-sm text-brand-text-muted">
            שלחנו הודעת SMS עם קוד בן {CODE_LENGTH} ספרות למספר <span dir="ltr">{formatLocalPhone(e164)}</span>.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="account-code" className="text-sm font-medium text-brand-text">
            קוד אימות
          </label>
          <input
            id="account-code"
            ref={codeInputRef}
            value={code}
            onChange={(event) => onCodeChange(event.target.value)}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={CODE_LENGTH}
            dir="ltr"
            aria-invalid={error ? true : undefined}
            className={`${inputClasses} text-center text-xl tracking-[0.5em]`}
            disabled={busy}
          />
          {error && (
            <p role="alert" className="text-xs text-brand-danger">
              {error}
            </p>
          )}
        </div>
        <Button type="submit" size="lg" disabled={busy || code.length !== CODE_LENGTH}>
          {busy ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : "אישור"}
        </Button>
        <div className="flex items-center justify-between text-sm">
          <button
            type="button"
            onClick={() => {
              setE164(null);
              setCode("");
              setError(null);
            }}
            className="text-brand-gold underline underline-offset-2"
          >
            שינוי מספר
          </button>
          <button
            type="button"
            onClick={resend}
            disabled={cooldown > 0}
            className="text-brand-gold underline underline-offset-2 disabled:text-brand-text-muted disabled:no-underline"
          >
            {cooldown > 0 ? `שליחה חוזרת בעוד ${cooldown} שנ׳` : "שליחת קוד חדש"}
          </button>
        </div>
      </form>
    );
  }

  return (
    <form className="flex flex-col gap-4 px-6 py-8" onSubmit={submitPhone} noValidate>
      <div className="flex flex-col gap-1.5">
        <p className="text-base font-semibold text-brand-text">התחברות / הצטרפות למועדון בלאגן</p>
        <p className="text-sm text-brand-text-muted">
          מספיק מספר טלפון נייד: נשלח אליו קוד ב-SMS, בלי סיסמה ובלי טופס. אפשר גם להזמין בלי להירשם.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="account-phone" className="text-sm font-medium text-brand-text">
          טלפון נייד
        </label>
        <input
          id="account-phone"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          dir="ltr"
          placeholder="050-000-0000"
          aria-invalid={error ? true : undefined}
          className={inputClasses}
          disabled={busy}
        />
        {error && (
          <p role="alert" className="text-xs text-brand-danger">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" size="lg" disabled={busy || phone.trim() === ""}>
        {busy ? <Loader2 size={18} className="animate-spin" aria-hidden="true" /> : "שלחו לי קוד"}
      </Button>
      {onContinueAsGuest && (
        <Button type="button" variant="ghost" onClick={onContinueAsGuest}>
          המשך כאורח
        </Button>
      )}
    </form>
  );
}
