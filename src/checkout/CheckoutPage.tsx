import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ArrowRight, Loader2 } from "lucide-react";
import { useCart } from "@/storefront/context/CartContext";
import { useCatalog } from "@/storefront/context/CatalogContext";
import { useBusinessSettings } from "@/storefront/context/BusinessSettingsContext";
import { getCatalogConfig } from "@/storefront/lib/catalogApi";
import { Button } from "@/shared/ui/Button";
import { formatPrice } from "@/storefront/lib/pricing";
import { formatLocalPhone } from "@/storefront/lib/phone";
import { OrderSummary } from "@/checkout/OrderSummary";
import { DetailsForm, type CustomerDetails, type DetailsPrefill } from "@/checkout/DetailsForm";
import { ClubCouponBox, ClubIdentity, useClub, useClubAddresses, useClubCoupon } from "@/checkout/club";
import { clearGuestDetails, readGuestDetails, saveGuestDetails } from "@/checkout/lib/guestMemory";
import { CURRENT_TERMS_VERSION } from "@/checkout/lib/terms";
import { useCheckoutValidation } from "@/checkout/useCheckoutValidation";
import {
  createOrder,
  describeOrderError,
  OrderCreationError,
  type CreateOrderResult,
  type OrderItemPayload,
} from "@/checkout/lib/ordersApi";
import { clearIdempotencyKey, getOrCreateIdempotencyKey } from "@/checkout/lib/idempotency";

const STORE_PHONE = "08-994-5190";
const STORE_PHONE_HREF = "tel:089945190";

const config = getCatalogConfig();

function CheckoutHeader() {
  return (
    <header className="border-b border-brand-tobacco-strong bg-brand-bg-secondary">
      <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-4">
        <a
          href="/"
          className="flex items-center gap-1.5 rounded-md p-1 text-sm text-brand-text-muted outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold"
        >
          <ArrowRight size={18} />
          חזרה לחנות
        </a>
        <span className="font-display text-xl text-brand-gold">בלאגן</span>
      </div>
    </header>
  );
}

function Notice({ children, kind = "info" }: { children: ReactNode; kind?: "info" | "danger" }) {
  return (
    <p
      role="status"
      className={`rounded-lg border px-3 py-2 text-sm ${
        kind === "danger" ? "border-brand-danger/40 bg-brand-danger/10 text-brand-danger" : "border-brand-border bg-brand-bg-elevated text-brand-text-muted"
      }`}
    >
      {children}
    </p>
  );
}

function FullPageState({ children }: { children: ReactNode }) {
  return <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 px-4 text-center">{children}</div>;
}

function SuccessPanel({ order }: { order: CreateOrderResult }) {
  return (
    <FullPageState>
      <h1 className="text-lg font-semibold text-brand-text">ההזמנה התקבלה!</h1>
      <p className="text-2xl font-bold text-brand-gold">#{order.orderNumber}</p>
      <p className="max-w-sm text-sm text-brand-text-muted">
        {order.paymentMethod === "cash"
          ? `ההזמנה אושרה ומחכה למשלוח — התשלום (₪${formatPrice(order.totalCents)}) יתבצע במזומן במעמד המסירה.`
          : "בקרוב תתאפשר השלמת התשלום ישירות באתר."}
      </p>
      {order.discountCents > 0 && <p className="text-sm text-brand-text-muted">כולל הנחת מועדון בסך ₪{formatPrice(order.discountCents)}.</p>}
      <p className="text-sm text-brand-text-muted">
        שאלות לגבי ההזמנה?{" "}
        <a href={STORE_PHONE_HREF} className="text-brand-gold underline underline-offset-2">
          {STORE_PHONE}
        </a>
      </p>
      <Button variant="secondary" onClick={() => window.location.assign("/")}>
        חזרה לחנות
      </Button>
    </FullPageState>
  );
}

function ErrorPanel({ onRetry }: { onRetry: () => void }) {
  return (
    <FullPageState>
      <h1 className="text-lg font-semibold text-brand-text">לא ניתן לאמת את פרטי ההזמנה כרגע</h1>
      <p className="max-w-sm text-sm text-brand-text-muted">בדקו את החיבור לאינטרנט ונסו שוב.</p>
      <Button onClick={onRetry}>נסו שוב</Button>
    </FullPageState>
  );
}

/**
 * `/checkout`: real navigation from `CartDrawer`'s "מעבר לתשלום", not a modal/drawer overlay — see the
 * checkout design doc. Re-validates against the database at the moments that matter (mount, tab refocus,
 * pre-submit) instead of a durable checkout-session object; a price change is shown but never blocks, a
 * stock shortfall blocks only the affected line, and a validation failure fails closed.
 *
 * Submitting the details form runs one FINAL revalidation pass, then calls `create_order()` — the server
 * re-validates everything again itself and is the only thing that actually creates the order; this page
 * never assumes success client-side. Card is collected in the form but not yet selectable (no payment
 * provider exists yet) — only cash orders are real today, end to end.
 */
export function CheckoutPage() {
  const { lines, totalPriceCents, clearCart } = useCart();
  const { status: catalogStatus } = useCatalog();
  const { settings } = useBusinessSettings();
  const validation = useCheckoutValidation();
  const [submitting, setSubmitting] = useState(false);
  // Snapshotting `items` at the moment of submit (rather than re-reading `lines` once validation settles)
  // means an edit to the cart made WHILE the final revalidation is running can't slip an order through for
  // contents the customer never actually confirmed — create_order() re-validates this exact snapshot anyway.
  const [pending, setPending] = useState<{ details: CustomerDetails; items: OrderItemPayload[] } | null>(null);
  const [order, setOrder] = useState<CreateOrderResult | null>(null);
  const [orderError, setOrderError] = useState<string | null>(null);

  // Club login (null in a build without one). A member's saved details replace the form's blank start; everyone else
  // is a guest, whose details may be remembered on THIS device (guestMemory.ts).
  const club = useClub();
  const member = club?.state.status === "member" ? club.state : null;
  const addresses = useClubAddresses(member?.session.accessToken ?? null);
  // Hold the form back until a restored session (and the member's addresses) are known, so it never flashes blank
  // and then jumps to the saved details.
  const clubLoading = club?.state.status === "loading" || (member !== null && addresses.status !== "ready");
  const [memoryVersion, setMemoryVersion] = useState(0);
  const remembered = useMemo(() => (member ? null : readGuestDetails()), [member !== null, memoryVersion]);
  const isMember = member !== null;
  // Coupons are a club benefit: `coupon` is the inert NO_COUPON in a build without a club login. The sign-in drawer is
  // owned here so the locked coupon box can open it too.
  const [loginOpen, setLoginOpen] = useState(false);
  const coupon = useClubCoupon({
    subtotalCents: totalPriceCents,
    isMember,
    getToken: () => (club ? club.getAccessToken() : Promise.resolve(null)),
  });
  useEffect(() => {
    if (isMember) clearGuestDetails(); // once someone is a member, their profile is the memory
  }, [isMember]);

  const belowMinimum = totalPriceCents < settings.min_order_cents;

  // Nothing to check out (emptied, or a direct/bookmarked visit) — nothing here for the customer to do.
  // Gated on `catalogStatus === "ready"`: on a first-ever visit in "supabase" mode the catalog fetch is
  // still in flight, so `lines` is empty for a moment even though the raw cart isn't — redirecting on that
  // transient emptiness would bounce a real cart home before it ever gets a chance to render. Once an
  // order exists the cart is cleared on purpose (see below), so `order` gates this instead of `lines.length`.
  useEffect(() => {
    if (catalogStatus === "ready" && lines.length === 0 && !order) window.location.assign("/");
  }, [catalogStatus, lines.length, order]);

  // The submit button triggers one more validation pass before create_order() is actually called.
  useEffect(() => {
    if (!submitting || validation.phase === "checking") return;
    setSubmitting(false);
    if (validation.phase !== "ready" || validation.blockedLines.length > 0 || belowMinimum || !pending) {
      setPending(null);
      return; // stay on the form; the existing notices above already explain why
    }

    const { details, items } = pending;
    setPending(null);
    setOrderError(null);
    const idempotencyKey = getOrCreateIdempotencyKey();

    const placeOrder = async (): Promise<CreateOrderResult | null> => {
      // Re-check the coupon right now. If it no longer holds it is dropped and the customer sees the new total and
      // confirms again — an order is never placed for a discount the customer didn't see.
      if (coupon.applied && !(await coupon.confirm())) {
        setOrderError("COUPON_DROPPED");
        return null;
      }
      // A member's order carries their own (fresh) token so the database attaches it to their account. If that token
      // can't be had, the order simply goes through as a guest order (it is claimed by phone at their next login).
      const token = member && club ? await club.getAccessToken() : null;
      return createOrder(config, items, details.paymentMethod, details, idempotencyKey, token ?? undefined, coupon.applied?.code);
    };

    void placeOrder()
      .then((result) => {
        if (!result) return;
        clearIdempotencyKey();
        clearCart();
        if (member && club) void club.refreshProfile(); // the order just taught the profile their name/address
        else saveGuestDetails(details);
        setOrder(result);
      })
      .catch((error: unknown) => {
        const code = error instanceof OrderCreationError ? error.code : "NETWORK_ERROR";
        if (code.startsWith("COUPON_")) coupon.rejectFromServer(code); // the database refused the coupon: drop it, keep the order
        setOrderError(code);
      });
  }, [submitting, validation.phase, validation.blockedLines, belowMinimum, pending]);

  if (order) {
    return (
      <div className="min-h-screen bg-brand-bg">
        <CheckoutHeader />
        <main className="mx-auto max-w-2xl px-4 py-8">
          <SuccessPanel order={order} />
        </main>
      </div>
    );
  }

  if (catalogStatus !== "ready") {
    return (
      <div className="min-h-screen bg-brand-bg">
        <CheckoutHeader />
        <main className="mx-auto max-w-2xl px-4 py-8">
          <FullPageState>
            <Loader2 size={28} className="animate-spin text-brand-gold" aria-hidden="true" />
            <p className="text-sm text-brand-text-muted">טוען…</p>
          </FullPageState>
        </main>
      </div>
    );
  }

  if (lines.length === 0) return null; // redirecting home

  const memberPrefill: DetailsPrefill | undefined = member
    ? { firstName: member.profile.firstName ?? "", lastName: member.profile.lastName ?? "", email: member.profile.email ?? "" }
    : undefined;

  return (
    <div className="min-h-screen bg-brand-bg">
      <CheckoutHeader />
      <main className="mx-auto max-w-2xl px-4 py-8">
        {validation.phase === "failed" ? (
          <ErrorPanel onRetry={validation.revalidate} />
        ) : clubLoading ? (
          <FullPageState>
            <Loader2 size={28} className="animate-spin text-brand-gold" aria-hidden="true" />
            <p className="text-sm text-brand-text-muted">טוען…</p>
          </FullPageState>
        ) : !validation.hasValidatedOnce ? (
          <FullPageState>
            <Loader2 size={28} className="animate-spin text-brand-gold" aria-hidden="true" />
            <p className="text-sm text-brand-text-muted">בודקים זמינות ומחירים…</p>
          </FullPageState>
        ) : (
          <div className="flex flex-col gap-6">
            <h1 className="text-xl font-semibold text-brand-text">השלמת פרטי ההזמנה</h1>

            {validation.droppedCount > 0 && (
              <Notice kind="danger">
                {validation.droppedCount === 1
                  ? "מוצר אחד כבר אינו זמין והוסר מההזמנה."
                  : `${validation.droppedCount} מוצרים כבר אינם זמינים והוסרו מההזמנה.`}
              </Notice>
            )}

            <OrderSummary
              changedPriceKeys={validation.changedPriceKeys}
              coupon={coupon.applied}
              couponSlot={<ClubCouponBox coupon={coupon} offerText={settings.club_offer_text ?? null} onJoin={() => setLoginOpen(true)} />}
            />

            {validation.blockedLines.length > 0 && (
              <Notice kind="danger">יש להתאים את הכמות של הפריטים המסומנים למעלה לפני שממשיכים.</Notice>
            )}

            {belowMinimum && (
              <Notice kind="danger">נדרשים עוד ₪{formatPrice(settings.min_order_cents - totalPriceCents)} להשלמת מינימום ההזמנה.</Notice>
            )}

            {orderError && <Notice kind="danger">{describeOrderError(orderError)}</Notice>}

            <ClubIdentity open={loginOpen} onOpenChange={setLoginOpen} />

            <DetailsForm
              key={member ? `member-${member.profile.id}` : `guest-${memoryVersion}`}
              prefill={member ? memberPrefill : remembered ?? undefined}
              lockedPhone={member ? formatLocalPhone(member.profile.phone) : undefined}
              savedAddresses={member ? addresses.addresses : undefined}
              termsAlreadyAccepted={member ? member.profile.termsVersion === CURRENT_TERMS_VERSION : false}
              rememberNote={!member}
              onForgetSavedDetails={
                !member && remembered
                  ? () => {
                      clearGuestDetails();
                      setMemoryVersion((value) => value + 1);
                    }
                  : undefined
              }
              disabled={validation.phase === "checking" || validation.blockedLines.length > 0 || belowMinimum}
              busy={submitting}
              onSubmit={(details) => {
                const items = lines.map((line) => ({ productId: line.product.id, option: line.option, quantity: line.quantity }));
                setPending({ details, items });
                setSubmitting(true);
                validation.revalidate();
              }}
            />
          </div>
        )}
      </main>
    </div>
  );
}
