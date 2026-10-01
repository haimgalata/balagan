import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Button } from "@/shared/ui/Button";
import { StreetField } from "@/checkout/StreetField";
import { NETIVOT_CITY_NAME, NETIVOT_STREETS } from "@/checkout/data/netivotStreets";
import { getCatalogConfig } from "@/storefront/lib/catalogApi";
import { addAddress, deleteAddress, describeMemberError, getMyAddresses, makeDefaultAddress, MemberApiError, updateAddress } from "@/account/memberApi";
import type { AddressInput, SavedAddress } from "@/account/types";
import { Card, Notice, Spinner, TextField } from "@/account/page/pageUi";
import { useMemberRun } from "@/account/page/useMemberRun";
import { useCustomerSession } from "@/account/CustomerSessionContext";

const config = getCatalogConfig();
/** The database keeps at most this many (the least recently used one is dropped when a new one is added). */
const MAX_ADDRESSES = 5;

const EMPTY: AddressInput = { street: "", houseNumber: "", entrance: "", floor: "", apartment: "", intercomCode: "", notes: "" };

const toInput = (a: SavedAddress): AddressInput => ({
  street: a.street, houseNumber: a.houseNumber, entrance: a.entrance, floor: a.floor, apartment: a.apartment, intercomCode: a.intercomCode, notes: a.notes,
});

function details(a: SavedAddress): string {
  return [a.entrance && `כניסה ${a.entrance}`, a.floor && `קומה ${a.floor}`, a.apartment && `דירה ${a.apartment}`, a.intercomCode && `קוד ${a.intercomCode}`]
    .filter(Boolean)
    .join(" · ");
}

function AddressForm({ initial, busy, error, onSave, onCancel }: { initial: AddressInput; busy: boolean; error: string | null; onSave: (value: AddressInput) => void; onCancel: () => void }) {
  const [value, setValue] = useState<AddressInput>(initial);
  const [errors, setErrors] = useState<{ street?: string; houseNumber?: string }>({});
  const set = (key: keyof AddressInput) => (next: string) => setValue((previous) => ({ ...previous, [key]: next }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const next: typeof errors = {};
    if (!NETIVOT_STREETS.includes(value.street.trim())) next.street = "נא לבחור רחוב מהרשימה המוצעת";
    if (value.houseNumber.trim() === "") next.houseNumber = "נא להזין מספר בית";
    setErrors(next);
    if (Object.keys(next).length === 0) onSave(value);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium text-brand-text">עיר</span>
        <div className="rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-base text-brand-text">{NETIVOT_CITY_NAME}</div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <StreetField id="address-street" label="רחוב" value={value.street} onChange={set("street")} error={errors.street} streets={NETIVOT_STREETS} />
        </div>
        <TextField label="מספר בית" id="address-house" value={value.houseNumber} onChange={set("houseNumber")} error={errors.houseNumber} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <TextField label="כניסה" id="address-entrance" value={value.entrance} onChange={set("entrance")} />
        <TextField label="קומה" id="address-floor" value={value.floor} onChange={set("floor")} />
        <TextField label="דירה" id="address-apartment" value={value.apartment} onChange={set("apartment")} />
        <TextField label="קוד כניסה / אינטרקום" id="address-intercom" value={value.intercomCode} onChange={set("intercomCode")} />
      </div>
      <TextField label="הערות למשלוח (אופציונלי)" id="address-notes" value={value.notes} onChange={set("notes")} />
      {error && <Notice kind="danger">{error}</Notice>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy ? "שומרים…" : "שמירה"}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          ביטול
        </Button>
      </div>
    </form>
  );
}

/**
 * "כתובות": the member's saved delivery addresses. The first one is the default (the most recently used — checkout and
 * "make default" both just touch it). Addresses also appear on their own after an order; this screen is for tidying them.
 */
export function AddressesTab() {
  const run = useMemberRun();
  const { state } = useCustomerSession();
  const customerId = state.status === "member" ? state.profile.id : null;
  const [addresses, setAddresses] = useState<SavedAddress[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setAddresses(await run((token) => getMyAddresses(config, token)));
    } catch (error) {
      setLoadError(error instanceof MemberApiError ? error.code : "NETWORK_ERROR");
    }
  }, [run]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: () => Promise<void>, after?: () => void) => {
    setSaving(true);
    setActionError(null);
    try {
      await action();
      after?.();
      await load();
    } catch (error) {
      setActionError(describeMemberError(error instanceof MemberApiError ? error.code : "NETWORK_ERROR"));
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <div className="flex flex-col items-start gap-3">
        <Notice kind="danger">{describeMemberError(loadError)}</Notice>
        <Button type="button" variant="outline" onClick={() => void load()}>
          נסו שוב
        </Button>
      </div>
    );
  }
  if (addresses === null) return <Spinner />;

  if (editing) {
    const existing = editing.id ? addresses.find((a) => a.id === editing.id) : undefined;
    return (
      <Card>
        <h2 className="mb-4 text-base font-semibold text-brand-text">{existing ? "עריכת כתובת" : "כתובת חדשה"}</h2>
        <AddressForm
          initial={existing ? toInput(existing) : EMPTY}
          busy={saving}
          error={actionError}
          onCancel={() => {
            setEditing(null);
            setActionError(null);
          }}
          onSave={(value) =>
            void act(
              () => run((token) => (existing ? updateAddress(config, token, existing.id, value) : addAddress(config, token, customerId ?? "", value))),
              () => setEditing(null)
            )
          }
        />
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {actionError && <Notice kind="danger">{actionError}</Notice>}

      {addresses.length === 0 ? (
        <Card>
          <p className="text-sm font-semibold text-brand-text">אין עדיין כתובות שמורות</p>
          <p className="mt-1 text-sm text-brand-text-muted">כתובת נשמרת אוטומטית אחרי כל הזמנה שלכם, ואפשר גם להוסיף אותה כאן מראש.</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {addresses.map((address, index) => (
            <li key={address.id}>
              <Card className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <span className="text-base font-semibold text-brand-text">
                      {address.street} {address.houseNumber}
                    </span>
                    {details(address) && <span className="text-xs text-brand-text-muted">{details(address)}</span>}
                    {address.notes && <span className="text-xs text-brand-text-muted">{address.notes}</span>}
                  </div>
                  {index === 0 && <span className="shrink-0 rounded-full border border-brand-gold/50 bg-brand-gold/10 px-2.5 py-1 text-xs font-medium text-brand-gold">ברירת מחדל</span>}
                </div>

                {confirmDeleteId === address.id ? (
                  <div className="flex flex-wrap items-center gap-2" role="group" aria-label="אישור מחיקה">
                    <span className="text-sm text-brand-text">למחוק את הכתובת?</span>
                    <Button
                      type="button"
                      size="sm"
                      disabled={saving}
                      onClick={() => void act(() => run((token) => deleteAddress(config, token, address.id)), () => setConfirmDeleteId(null))}
                    >
                      כן, למחוק
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDeleteId(null)}>
                      ביטול
                    </Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {index !== 0 && (
                      <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => void act(() => run((token) => makeDefaultAddress(config, token, address.id)))}>
                        הפוך לברירת מחדל
                      </Button>
                    )}
                    <Button type="button" size="sm" variant="secondary" onClick={() => setEditing({ id: address.id })}>
                      עריכה
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmDeleteId(address.id)}>
                      מחיקה
                    </Button>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col items-start gap-2">
        <Button type="button" variant="outline" onClick={() => setEditing({ id: null })}>
          הוספת כתובת
        </Button>
        {addresses.length >= MAX_ADDRESSES && (
          <p className="text-xs text-brand-text-muted">אפשר לשמור עד {MAX_ADDRESSES} כתובות. הוספת כתובת נוספת תסיר את זו שבשימוש הכי ישן.</p>
        )}
      </div>
    </div>
  );
}
