import { useEffect, useState } from "react";
import { Button } from "@/shared/ui/Button";
import { OTHER_REASON, cancelHoldsStock, cancelReasons, type OrderRow } from "@/admin/orders/orderModel";

interface CancelOrderDialogProps {
  order: Pick<OrderRow, "order_number" | "order_status" | "fulfillment_method">;
  busy: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

/** Cancelling always needs a reason (the database refuses without one). Says what will happen to the stock. */
export function CancelOrderDialog({ order, busy, error, onConfirm, onClose }: CancelOrderDialogProps) {
  const [choice, setChoice] = useState<string>("");
  const [other, setOther] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const reason = choice === OTHER_REASON ? other.trim() : choice;
  const holdsStock = cancelHoldsStock(order.order_status);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`ביטול הזמנה ${order.order_number}`}
        className="w-full max-w-md rounded-xl border border-brand-border bg-brand-bg-elevated p-5 text-brand-text"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mb-1 text-lg font-semibold">ביטול הזמנה #{order.order_number}</h2>
        <p className="mb-3 text-sm text-brand-text-muted">
          {holdsStock
            ? "ההזמנה כבר יצאה למשלוח: המלאי לא יוחזר עד שתאשרו שהמוצרים חזרו פיזית לחנות."
            : "המלאי של ההזמנה יוחזר אוטומטית."}
        </p>

        <fieldset className="mb-3 grid gap-2">
          <legend className="mb-1 text-sm font-medium">סיבת הביטול (חובה)</legend>
          {cancelReasons(order.fulfillment_method).map((r) => (
            <label key={r} className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2.5 text-sm ${choice === r ? "border-brand-gold bg-brand-gold/10" : "border-brand-border"}`}>
              <input type="radio" name="cancel-reason" value={r} checked={choice === r} onChange={() => setChoice(r)} className="accent-[rgb(var(--color-gold))]" />
              {r}
            </label>
          ))}
        </fieldset>

        {choice === OTHER_REASON && (
          <input
            type="text"
            value={other}
            onChange={(event) => setOther(event.target.value)}
            maxLength={200}
            placeholder="פרטו את הסיבה"
            aria-label="פירוט הסיבה"
            className="mb-3 w-full rounded-md border border-brand-border bg-brand-bg px-3 py-2.5 text-sm outline-none focus:border-brand-gold"
          />
        )}

        {error && (
          <p role="alert" className="mb-3 rounded-md border border-brand-danger/40 bg-brand-danger/10 px-3 py-2 text-sm text-brand-danger">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            חזרה
          </Button>
          <Button onClick={() => onConfirm(reason)} disabled={busy || reason === ""} className="!bg-brand-danger !text-white">
            בטלו את ההזמנה
          </Button>
        </div>
      </div>
    </div>
  );
}
