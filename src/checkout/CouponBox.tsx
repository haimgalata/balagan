import { useState, type FormEvent } from "react";
import { Loader2, Lock, Ticket, X } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { useCustomerSession } from "@/account/CustomerSessionContext";
import { containsHebrew } from "@/storefront/lib/couponCode";
import { formatPrice } from "@/storefront/lib/pricing";
import type { CouponController } from "@/checkout/couponTypes";

const DEFAULT_OFFER = "קופונים הם הטבה לחברי מועדון בלאגן.";

const inputClasses =
  "w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-base text-brand-text placeholder:text-brand-text-muted outline-none transition-colors focus-visible:border-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:opacity-60";

interface CouponBoxProps {
  coupon: CouponController;
  /** The owner's public one-liner about club offers (business settings), shown to people who can't use a coupon yet. */
  offerText: string | null;
  /** Opens the same sign-in / join drawer the identity card uses. */
  onJoin: () => void;
}

/**
 * The coupon area of the order summary. Everyone sees it (it is a reason to join the club), but only a signed-in ACTIVE
 * member gets a working input — and even then nothing is granted here: the database decides when the order is created.
 * Lives only in builds with a club login (see club.tsx).
 */
export function CouponBox({ coupon, offerText, onJoin }: CouponBoxProps) {
  const { state } = useCustomerSession();
  const [code, setCode] = useState("");

  if (state.status === "loading" || state.status === "unavailable") return null;

  if (state.status !== "member") {
    return (
      <div className="mb-3 flex flex-col gap-2 rounded-xl border border-dashed border-brand-border bg-brand-bg p-3" data-testid="coupon-locked">
        <div className="flex items-center gap-2 text-sm font-medium text-brand-text">
          <Lock size={16} className="text-brand-gold" aria-hidden="true" />
          קוד קופון
        </div>
        <input disabled aria-label="קוד קופון (למועדון בלבד)" placeholder="קוד קופון" className={inputClasses} />
        <p className="text-xs text-brand-text-muted">{offerText ?? DEFAULT_OFFER}</p>
        <Button type="button" variant="outline" size="sm" onClick={onJoin}>
          {state.status === "needs-join" ? "סיום הצטרפות לשימוש בקופון" : "כניסה למועדון לשימוש בקופון"}
        </Button>
      </div>
    );
  }

  if (coupon.applied) {
    const { applied } = coupon;
    return (
      <div className="mb-3 flex flex-col gap-1" data-testid="coupon-applied">
        <div className="flex items-center justify-between gap-2 rounded-xl border border-brand-gold/50 bg-brand-bg px-3 py-2 text-sm">
          <span className="flex min-w-0 items-center gap-2 text-brand-text">
            <Ticket size={16} className="shrink-0 text-brand-gold" aria-hidden="true" />
            <span className="truncate">
              קופון <span dir="ltr" className="font-semibold">{applied.code}</span> · {applied.title}
            </span>
          </span>
          <button
            type="button"
            onClick={() => {
              setCode("");
              coupon.remove();
            }}
            aria-label="הסרת הקופון"
            className="shrink-0 rounded p-1 text-brand-text-muted outline-none transition-colors hover:text-brand-danger focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-gold"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <p className="text-xs text-brand-text-muted">
          {applied.discountType === "free_delivery" ? "משלוח חינם" : `חיסכון של ₪${formatPrice(applied.discountCents)}`}
        </p>
      </div>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!coupon.busy) void coupon.apply(code);
  };

  return (
    <form onSubmit={submit} className="mb-3 flex flex-col gap-1.5" data-testid="coupon-form">
      <label htmlFor="coupon-code" className="text-sm font-medium text-brand-text">
        יש לכם קוד קופון?
      </label>
      <div className="flex gap-2">
        <input
          id="coupon-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          dir="ltr"
          autoComplete="off"
          autoCapitalize="characters"
          placeholder="CLUB20"
          disabled={coupon.busy}
          aria-invalid={coupon.message ? true : undefined}
          className={inputClasses}
        />
        <Button type="submit" variant="outline" disabled={coupon.busy || code.trim() === ""}>
          {coupon.busy ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : "החלה"}
        </Button>
      </div>
      {coupon.message && (
        <p role="alert" className="text-xs text-brand-danger">
          {coupon.message}
        </p>
      )}
      {containsHebrew(code) && <p className="text-xs text-brand-text-muted">קודי קופון נכתבים באותיות באנגלית ובספרות — בדקו את שפת המקלדת.</p>}
    </form>
  );
}
