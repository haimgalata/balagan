import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { Loader2, Lock } from "lucide-react";
import { Button } from "@/shared/ui/Button";
import { StreetField } from "@/checkout/StreetField";
import { NETIVOT_CITY_NAME, NETIVOT_STREETS } from "@/checkout/data/netivotStreets";
import type { PaymentMethod } from "@/checkout/lib/ordersApi";
import { isValidIsraeliPhone } from "@/storefront/lib/phone";
import type { SavedAddress } from "@/account/types";

export interface CustomerDetails {
  firstName: string;
  lastName: string;
  phone: string;
  /** Optional — for future order confirmations/receipts only. */
  email: string;
  /** Always `NETIVOT_CITY_NAME`: delivery is Netivot-only and this isn't user-editable. */
  city: string;
  street: string;
  houseNumber: string;
  entrance: string;
  floor: string;
  apartment: string;
  intercomCode: string;
  notes: string;
  ageConfirmed: boolean;
  termsAccepted: boolean;
  /** Always "cash" today — card is shown but disabled until a payment provider is chosen. */
  paymentMethod: PaymentMethod;
}

/** Values the form starts with — a member's profile, or a guest's details remembered on this device. */
export interface DetailsPrefill {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  street?: string;
  houseNumber?: string;
  entrance?: string;
  floor?: string;
  apartment?: string;
  intercomCode?: string;
  notes?: string;
}

interface DetailsFormProps {
  /** True while a blocking validation issue (or a below-minimum total) means submitting can't proceed yet. */
  disabled: boolean;
  /** True while the pre-submit revalidation triggered by this form is in flight. */
  busy: boolean;
  onSubmit: (details: CustomerDetails) => void;
  /** Initial values (the form reads them once, on mount — remount it with a new `key` to apply different ones). */
  prefill?: DetailsPrefill;
  /** Club member: the phone is the one verified at login and is shown, not edited. */
  lockedPhone?: string;
  /** Club member: saved delivery addresses, most recently used first. The first one is selected by default. */
  savedAddresses?: SavedAddress[];
  /** Club member who has accepted the CURRENT terms version: the terms checkbox is not shown. The 18+ confirmation always is. */
  termsAlreadyAccepted?: boolean;
  /** Guest: explain that details are remembered on this device only. */
  rememberNote?: boolean;
  /** Guest whose details were prefilled from this device: lets them forget them. */
  onForgetSavedDetails?: () => void;
}

type FieldErrors = Partial<
  Record<"firstName" | "lastName" | "phone" | "email" | "street" | "houseNumber" | "ageConfirmed" | "termsAccepted", string>
>;

const inputClasses =
  "w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-base text-brand-text placeholder:text-brand-text-muted outline-none transition-colors focus-visible:border-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold";

function addressSummary(address: SavedAddress): string {
  return `${address.street} ${address.houseNumber}`;
}

function addressDetails(address: SavedAddress): string {
  return [
    address.entrance && `כניסה ${address.entrance}`,
    address.floor && `קומה ${address.floor}`,
    address.apartment && `דירה ${address.apartment}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function isValidEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

function Field({
  label,
  id,
  value,
  onChange,
  error,
  ...rest
}: { label: string; id: string; value: string; onChange: (value: string) => void; error?: string } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "id" | "value" | "onChange"
>) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-brand-text">
        {label}
      </label>
      <input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        className={inputClasses}
        {...rest}
      />
      {error && (
        <p role="alert" className="text-xs text-brand-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function ConfirmCheckbox({
  id,
  checked,
  onChange,
  error,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex items-start gap-3 text-sm text-brand-text">
        <input
          id={id}
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
          aria-invalid={error ? true : undefined}
          className="mt-0.5 h-5 w-5 shrink-0 accent-[rgb(var(--color-gold))]"
        />
        <span>{children}</span>
      </label>
      {error && (
        <p role="alert" className="text-xs text-brand-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Customer + delivery-address details. Client-side validation only — submitting does not persist an order
 * yet (there is no order-processing backend); the parent shows a "coming soon" state once this and one
 * final revalidation pass both succeed.
 *
 * Delivery is Netivot-only today: the city is fixed (not an editable field) and the street is restricted
 * to `NETIVOT_STREETS` (see `data/netivotStreets.ts`) via `StreetField`'s autocomplete — free text that
 * doesn't match an entry in that list is rejected on submit, same as any other required field.
 */
export function DetailsForm({
  disabled,
  busy,
  onSubmit,
  prefill,
  lockedPhone,
  savedAddresses,
  termsAlreadyAccepted = false,
  rememberNote = false,
  onForgetSavedDetails,
}: DetailsFormProps) {
  // Only addresses the delivery area still accepts can be picked (a saved street that left the list is ignored).
  const saved = (savedAddresses ?? []).filter((address) => NETIVOT_STREETS.includes(address.street));
  const first = saved[0];
  const seed = prefill ?? {};
  const [firstName, setFirstName] = useState(seed.firstName ?? "");
  const [lastName, setLastName] = useState(seed.lastName ?? "");
  const [phone, setPhone] = useState(lockedPhone ?? seed.phone ?? "");
  const [email, setEmail] = useState(seed.email ?? "");
  const [street, setStreet] = useState(first?.street ?? seed.street ?? "");
  const [houseNumber, setHouseNumber] = useState(first?.houseNumber ?? seed.houseNumber ?? "");
  const [entrance, setEntrance] = useState(first?.entrance ?? seed.entrance ?? "");
  const [floor, setFloor] = useState(first?.floor ?? seed.floor ?? "");
  const [apartment, setApartment] = useState(first?.apartment ?? seed.apartment ?? "");
  const [intercomCode, setIntercomCode] = useState(first?.intercomCode ?? seed.intercomCode ?? "");
  const [notes, setNotes] = useState(first?.notes ?? seed.notes ?? "");
  // How the delivery address is entered: "saved" = the selected saved address as a one-line card, "picker" = choose
  // among saved ones (or a new one), "new" = the full fields (the only mode a guest, or a member with none saved, sees).
  const [addressMode, setAddressMode] = useState<"saved" | "picker" | "new">(first ? "saved" : "new");
  const [addressId, setAddressId] = useState<string | null>(first?.id ?? null);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  // Card isn't wired to a payment provider yet (see CLAUDE.md) — cash is the only real choice today.
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("cash");
  const [errors, setErrors] = useState<FieldErrors>({});

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || busy) return;

    const nextErrors: FieldErrors = {};
    if (firstName.trim() === "") nextErrors.firstName = "נא להזין שם פרטי";
    if (lastName.trim() === "") nextErrors.lastName = "נא להזין שם משפחה";
    if (!isValidIsraeliPhone(phone)) nextErrors.phone = "נא להזין מספר טלפון תקין";
    if (email.trim() !== "" && !isValidEmail(email)) nextErrors.email = "נא להזין כתובת אימייל תקינה";
    if (!NETIVOT_STREETS.includes(street.trim())) nextErrors.street = "נא לבחור רחוב מהרשימה המוצעת";
    if (houseNumber.trim() === "") nextErrors.houseNumber = "נא להזין מספר בית";
    if (!ageConfirmed) nextErrors.ageConfirmed = "יש לאשר את הצהרת הגיל כדי להמשיך";
    if (!termsAlreadyAccepted && !termsAccepted) nextErrors.termsAccepted = "יש לאשר את התקנון כדי להמשיך";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      // a problem with the address must be visible: leave the collapsed saved-address card for the full fields
      if (nextErrors.street || nextErrors.houseNumber) setAddressMode("new");
      return;
    }

    onSubmit({
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      phone: phone.trim(),
      email: email.trim(),
      city: NETIVOT_CITY_NAME,
      street: street.trim(),
      houseNumber: houseNumber.trim(),
      entrance: entrance.trim(),
      floor: floor.trim(),
      apartment: apartment.trim(),
      intercomCode: intercomCode.trim(),
      notes: notes.trim(),
      ageConfirmed,
      termsAccepted: termsAlreadyAccepted || termsAccepted,
      paymentMethod,
    });
  };

  const chooseAddress = (address: SavedAddress | null) => {
    setAddressId(address?.id ?? null);
    setStreet(address?.street ?? "");
    setHouseNumber(address?.houseNumber ?? "");
    setEntrance(address?.entrance ?? "");
    setFloor(address?.floor ?? "");
    setApartment(address?.apartment ?? "");
    setIntercomCode(address?.intercomCode ?? "");
    if (address) setNotes(address.notes);
    setErrors((previous) => ({ ...previous, street: undefined, houseNumber: undefined }));
    setAddressMode(address ? "saved" : "new");
  };
  const selectedAddress = saved.find((address) => address.id === addressId) ?? null;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6 rounded-2xl border border-brand-border bg-brand-bg-elevated p-4 sm:p-6">
      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-sm font-semibold text-brand-text">פרטים אישיים</legend>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="שם פרטי" id="checkout-first-name" value={firstName} onChange={setFirstName} error={errors.firstName} autoComplete="given-name" />
          <Field label="שם משפחה" id="checkout-last-name" value={lastName} onChange={setLastName} error={errors.lastName} autoComplete="family-name" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {lockedPhone ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-brand-text">טלפון</span>
              <div className="flex items-center justify-between gap-2 rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-base text-brand-text">
                <span dir="ltr">{lockedPhone}</span>
                <span className="flex items-center gap-1 text-xs text-brand-text-muted">
                  <Lock size={13} aria-hidden="true" />
                  מאומת בהתחברות
                </span>
              </div>
            </div>
          ) : (
            <Field
              label="טלפון"
              id="checkout-phone"
              value={phone}
              onChange={setPhone}
              error={errors.phone}
              type="tel"
              inputMode="tel"
              dir="ltr"
              autoComplete="tel"
            />
          )}
          <Field
            label="אימייל (אופציונלי)"
            id="checkout-email"
            value={email}
            onChange={setEmail}
            error={errors.email}
            type="email"
            inputMode="email"
            dir="ltr"
            autoComplete="email"
            placeholder="לשליחת אישור הזמנה"
          />
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-1 text-sm font-semibold text-brand-text">כתובת למשלוח</legend>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-brand-text">עיר</span>
          <div className="flex items-center justify-between gap-2 rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-base text-brand-text">
            <span>{NETIVOT_CITY_NAME}</span>
            <span className="flex items-center gap-1 text-xs text-brand-text-muted">
              <Lock size={13} aria-hidden="true" />
              משלוח זמין רק בעיר זו
            </span>
          </div>
        </div>

        {addressMode === "saved" && selectedAddress && (
          <div className="flex items-start justify-between gap-3 rounded-lg border border-brand-gold/60 bg-brand-gold/5 px-3 py-3">
            <div className="flex flex-col gap-0.5 text-sm text-brand-text">
              <span className="text-xs text-brand-text-muted">משלוח אל</span>
              <span className="font-medium">{addressSummary(selectedAddress)}</span>
              {addressDetails(selectedAddress) && <span className="text-xs text-brand-text-muted">{addressDetails(selectedAddress)}</span>}
            </div>
            <button type="button" onClick={() => setAddressMode("picker")} className="shrink-0 text-sm text-brand-gold underline underline-offset-2">
              שינוי
            </button>
          </div>
        )}

        {addressMode === "picker" && (
          <div role="radiogroup" aria-label="כתובת למשלוח" className="flex flex-col gap-2">
            {saved.map((address) => (
              <button
                key={address.id}
                type="button"
                role="radio"
                aria-checked={address.id === addressId}
                onClick={() => chooseAddress(address)}
                className={`rounded-lg border px-3 py-2.5 text-start text-sm transition-colors ${
                  address.id === addressId ? "border-brand-gold bg-brand-gold/10 text-brand-text" : "border-brand-border text-brand-text hover:border-brand-border-strong"
                }`}
              >
                <span className="block font-medium">{addressSummary(address)}</span>
                {addressDetails(address) && <span className="block text-xs text-brand-text-muted">{addressDetails(address)}</span>}
              </button>
            ))}
            <button
              type="button"
              role="radio"
              aria-checked={false}
              onClick={() => chooseAddress(null)}
              className="rounded-lg border border-dashed border-brand-border px-3 py-2.5 text-start text-sm text-brand-text hover:border-brand-border-strong"
            >
              כתובת חדשה
            </button>
          </div>
        )}

        {addressMode === "new" && (
          <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <StreetField id="checkout-street" label="רחוב" value={street} onChange={setStreet} error={errors.street} streets={NETIVOT_STREETS} />
            </div>
            <Field label="מספר בית" id="checkout-house-number" value={houseNumber} onChange={setHouseNumber} error={errors.houseNumber} />
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs text-brand-text-muted">פרטי גישה נוספים (אופציונלי)</p>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="כניסה" id="checkout-entrance" value={entrance} onChange={setEntrance} />
              <Field label="קומה" id="checkout-floor" value={floor} onChange={setFloor} />
              <Field label="דירה" id="checkout-apartment" value={apartment} onChange={setApartment} />
              <Field label="קוד כניסה / אינטרקום" id="checkout-intercom" value={intercomCode} onChange={setIntercomCode} />
            </div>
          </div>

            {saved.length > 0 && (
              <button type="button" onClick={() => setAddressMode("picker")} className="self-start text-sm text-brand-gold underline underline-offset-2">
                בחירה מכתובת שמורה
              </button>
            )}
          </>
        )}
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="checkout-notes" className="text-sm font-medium text-brand-text">
          הערות למשלוח (אופציונלי)
        </label>
        <textarea id="checkout-notes" value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} className={inputClasses} />
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold text-brand-text">אופן תשלום</legend>
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setPaymentMethod("cash")}
            aria-pressed={paymentMethod === "cash"}
            className={`rounded-lg border p-3 text-sm font-medium transition-colors ${
              paymentMethod === "cash"
                ? "border-brand-gold bg-brand-gold/10 text-brand-gold"
                : "border-brand-border text-brand-text hover:border-brand-border-strong"
            }`}
          >
            מזומן במסירה
          </button>
          <button
            type="button"
            disabled
            aria-disabled="true"
            className="cursor-not-allowed rounded-lg border border-brand-border p-3 text-sm font-medium text-brand-text-muted opacity-60"
          >
            כרטיס אשראי
            <span className="block text-xs">בקרוב</span>
          </button>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-1 text-sm font-semibold text-brand-text">אישורים נדרשים</legend>

        <ConfirmCheckbox id="checkout-age-confirm" checked={ageConfirmed} onChange={setAgeConfirmed} error={errors.ageConfirmed}>
          אני מאשר/ת כי מקבל/ת המשלוח הינו/ה בן/בת 18 ומעלה, וכי מסירת מוצרים המוגבלים לפי גיל תתבצע אך ורק בהצגת
          תעודה מזהה המעידה על גיל 18 ומעלה במעמד המסירה — אם לא תוצג תעודה מתאימה, המשלוח לא יימסר.
        </ConfirmCheckbox>

        {/* The terms/ordering-and-delivery page doesn't exist yet (see CLAUDE.md) — once it does, wrap the
            phrase below in a real <a href="..."> to it instead of this styled span. */}
        {!termsAlreadyAccepted && (
          <ConfirmCheckbox id="checkout-terms-accept" checked={termsAccepted} onChange={setTermsAccepted} error={errors.termsAccepted}>
            קראתי ואני מסכימ/ה ל<span className="text-brand-gold underline underline-offset-2">תקנון האתר ותנאי ההזמנה והמשלוח</span>.
          </ConfirmCheckbox>
        )}
      </fieldset>

      {rememberNote && (
        <p className="text-xs text-brand-text-muted">
          הפרטים יישמרו במכשיר הזה בלבד, כדי להקל על הזמנה הבאה.
          {onForgetSavedDetails && (
            <>
              {" "}
              <button type="button" onClick={onForgetSavedDetails} className="text-brand-gold underline underline-offset-2">
                מחיקת הפרטים השמורים
              </button>
            </>
          )}
        </p>
      )}

      <Button type="submit" size="lg" disabled={disabled || busy} className="w-full">
        {busy ? (
          <>
            <Loader2 size={18} className="animate-spin" aria-hidden="true" />
            בודקים זמינות…
          </>
        ) : (
          "לסיום ההזמנה"
        )}
      </Button>
    </form>
  );
}
