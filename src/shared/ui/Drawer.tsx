import { useEffect } from "react";
import { X } from "lucide-react";
import type { ReactNode } from "react";

interface DrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  /** Which screen edge the panel slides in from. */
  side?: "left" | "right";
  /** Optional id on the panel, so a trigger button elsewhere can point
   * `aria-controls` at it. */
  id?: string;
  children: ReactNode;
}

/**
 * Shared slide-in panel used by both the mobile navigation and the
 * cart drawer, so overlay/scroll-lock/close behavior lives in one place.
 */
export function Drawer({ isOpen, onClose, title, side = "left", id, children }: DrawerProps) {
  useEffect(() => {
    if (!isOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose]);

  const sideClasses = side === "left" ? "left-0" : "right-0";
  const translateClosed = side === "left" ? "-translate-x-full" : "translate-x-full";

  return (
    <div
      className={`fixed inset-0 z-[90] transition-opacity ${
        isOpen ? "visible opacity-100" : "invisible opacity-0"
      }`}
      aria-hidden={!isOpen}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        id={id}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`absolute inset-y-0 ${sideClasses} flex w-full max-w-sm flex-col bg-brand-bg-secondary shadow-2xl transition-transform duration-300 ${
          isOpen ? "translate-x-0" : translateClosed
        }`}
      >
        <div className="flex items-center justify-between border-b border-brand-border px-4 py-4">
          <h2 className="text-lg font-semibold text-brand-text">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="סגור"
            className="rounded-md p-1.5 text-brand-text-muted outline-none transition-colors hover:bg-brand-bg-elevated hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold"
          >
            <X size={22} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
