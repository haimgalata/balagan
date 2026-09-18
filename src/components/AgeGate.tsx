import { useEffect, useState } from "react";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { Button } from "@/components/ui/Button";

const AGE_VERIFIED_KEY = "balagan_age_verified";
const DENY_REDIRECT_URL = "https://www.google.com";

/**
 * Mandatory 21+ age verification gate.
 *
 * Cannot be dismissed by clicking outside, pressing Escape, or an X
 * button — none of those handlers exist on purpose. The only way
 * forward is an explicit "yes" click, which is persisted to
 * localStorage so returning visitors are not asked again. "לא" shows a
 * one-line message before redirecting instead of leaving instantly —
 * still no way to stay on/dismiss the gate, just a softer exit.
 */
export function AgeGate() {
  const [isVerified, setIsVerified] = useLocalStorage<boolean>(AGE_VERIFIED_KEY, false);
  const [isDenied, setIsDenied] = useState(false);

  // Lock page scroll while the gate is showing.
  useEffect(() => {
    if (isVerified) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isVerified]);

  useEffect(() => {
    if (!isDenied) return;
    const timeout = window.setTimeout(() => {
      window.location.href = DENY_REDIRECT_URL;
    }, 2000);
    return () => window.clearTimeout(timeout);
  }, [isDenied]);

  if (isVerified) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="age-gate-title"
      aria-describedby="age-gate-description"
    >
      <div className="w-full max-w-sm rounded-2xl border border-brand-border bg-brand-bg-elevated p-6 text-center shadow-2xl sm:max-w-md sm:p-8">
        <img
          src="/images/new_pic.png"
          alt="בלגן - מרכז הסיגריות והטבק"
          className="mx-auto mb-6 h-20 w-auto rounded-lg sm:h-24"
        />

        {isDenied ? (
          <p id="age-gate-description" className="text-lg font-semibold text-brand-text">
            האתר מיועד לבני 21 ומעלה בלבד.
          </p>
        ) : (
          <>
            <h1 id="age-gate-title" className="mb-2 font-display text-2xl text-brand-gold sm:text-3xl">
              ברוכים הבאים
            </h1>
            <p id="age-gate-description" className="mb-1 text-brand-text">
              הכניסה לאתר מיועדת לבני 21 ומעלה
            </p>
            <p className="mb-6 text-lg font-semibold text-brand-text">האם אתה מעל גיל 21?</p>

            <div className="flex flex-col gap-3">
              <Button variant="primary" size="lg" className="w-full" onClick={() => setIsVerified(true)}>
                כן, אני מעל גיל 21
              </Button>
              <Button variant="secondary" size="lg" className="w-full" onClick={() => setIsDenied(true)}>
                לא
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
