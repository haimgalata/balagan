import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useStoreStatus } from "@/storefront/hooks/useStoreStatus";
import { StoreHoursPanel } from "@/storefront/components/StoreHoursPanel";
/**
 * Homepage hero — a real photo used as atmosphere behind a brand moment,
 * not a bare banner. A gradient (transparent → tobacco-brown → near-black,
 * toward the text side) keeps the overlay text legible without a flat
 * black box. The open/closed pill reads real, live data from
 * `useStoreStatus` (the PHYSICAL store's own schedule — see
 * BusinessSettingsContext; `BusinessInfoBar` below it is about online
 * orders, a separate concept) — nothing here is invented copy.
 *
 * Clicking the pill expands `StoreHoursPanel` (the full week, today
 * highlighted) beneath it, in the same spot this status has always lived —
 * but the panel itself is portaled to `document.body` (same reason
 * `CategoryOverflowMenu`'s panel is: this `<section>` is `overflow-hidden`,
 * and the pill sits near the very bottom of it, so a normally-nested
 * absolutely-positioned panel gets clipped by the hero's own bottom edge
 * instead of floating above the page content below it). Position is
 * computed from the trigger's rect when opened, and the panel closes on
 * scroll/resize rather than tracking continuously.
 *
 * The image is now taller than the old bare-banner crop (which was sized
 * to show the whole source photo) since it only needs to read as
 * atmosphere, not as the page's sole content.
 */
export function Hero() {
  const { isOpen, hoursLabel } = useStoreStatus();
  const [expanded, setExpanded] = useState(false);
  const [panelPosition, setPanelPosition] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expanded) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setExpanded(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    const closeOnScrollOrResize = () => setExpanded(false);
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", closeOnScrollOrResize, true);
    window.addEventListener("resize", closeOnScrollOrResize);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", closeOnScrollOrResize, true);
      window.removeEventListener("resize", closeOnScrollOrResize);
    };
  }, [expanded]);

  const openPanel = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPanelPosition({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    setExpanded(true);
  };

  return (
    <section className="relative w-full overflow-hidden border-b border-brand-tobacco-strong bg-black">
      <div className="relative mx-auto max-w-container">
        <img
          src="/images/logo.png"
          alt=""
          aria-hidden="true"
          className="h-[220px] w-full object-cover object-center sm:h-[280px] md:h-[340px] lg:h-[400px] xl:h-[460px]"
        />

        <div
          className="absolute inset-0 bg-gradient-to-l from-black/10 via-brand-tobacco/75 to-black/10"
          aria-hidden="true"
        />

        <div className="absolute inset-0 flex flex-col items-start justify-end gap-2 p-4 sm:gap-2.5 sm:p-6 lg:p-10">
          <button
            ref={triggerRef}
            type="button"
            onClick={() => (expanded ? setExpanded(false) : openPanel())}
            aria-expanded={expanded}
            aria-controls="store-hours-panel"
            aria-label="שעות פתיחת החנות"
            className="mt-1 flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1 text-xs font-semibold outline-none transition-colors hover:bg-black/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold sm:text-sm"
          >
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${isOpen ? "bg-brand-success" : "bg-brand-danger"}`}
              aria-hidden="true"
            />
            <span className={isOpen ? "text-brand-success" : "text-brand-danger"}>
              {isOpen ? "פתוח עכשיו" : "סגור כעת"}
            </span>
            <span className="text-brand-text-muted">· {hoursLabel}</span>
            <span aria-hidden="true" className={`text-brand-text-muted transition-transform ${expanded ? "-rotate-180" : ""}`}>
              ˅
            </span>
          </button>
        </div>
      </div>

      {expanded &&
        panelPosition &&
        createPortal(
          <div
            ref={panelRef}
            id="store-hours-panel"
            aria-label="שעות פתיחה השבועיות"
            style={{ position: "fixed", top: panelPosition.top, right: panelPosition.right }}
            className="z-[95] w-60 overflow-hidden rounded-lg border border-brand-border bg-brand-bg-elevated shadow-2xl"
          >
            <StoreHoursPanel />
          </div>,
          document.body
        )}
    </section>
  );
}
