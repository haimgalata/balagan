import { Loader2 } from "lucide-react";
import type { InputHTMLAttributes, ReactNode } from "react";

export const inputClasses =
  "w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-base text-brand-text placeholder:text-brand-text-muted outline-none transition-colors focus-visible:border-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-brand-border bg-brand-bg-elevated p-4 sm:p-5 ${className}`}>{children}</div>;
}

export function Notice({ children, kind = "info" }: { children: ReactNode; kind?: "info" | "danger" | "success" }) {
  const tone =
    kind === "danger"
      ? "border-brand-danger/40 bg-brand-danger/10 text-brand-danger"
      : kind === "success"
        ? "border-brand-gold/40 bg-brand-gold/10 text-brand-gold"
        : "border-brand-border bg-brand-bg-elevated text-brand-text-muted";
  return (
    <p role={kind === "danger" ? "alert" : "status"} className={`rounded-lg border px-3 py-2 text-sm ${tone}`}>
      {children}
    </p>
  );
}

export function Spinner({ label = "טוען…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-12 text-sm text-brand-text-muted" role="status">
      <Loader2 size={20} className="animate-spin text-brand-gold" aria-hidden="true" />
      {label}
    </div>
  );
}

export function TextField({
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
      <input id={id} value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={error ? true : undefined} className={inputClasses} {...rest} />
      {error && (
        <p role="alert" className="text-xs text-brand-danger">
          {error}
        </p>
      )}
    </div>
  );
}
