import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Tracks scroll direction for "collapse on scroll-down, expand on
 * scroll-up" UI (currently: the sticky category tabs row in
 * `CategoryBrowser.tsx`, which hides while scrolling down and reappears
 * while scrolling up, alongside the always-sticky business-info and
 * subcategory rows).
 *
 * Returns `true` when the element should be collapsed/hidden. Always
 * `false` at the very top of the page.
 *
 * Hysteresis: `lastY` (the baseline a delta is measured from) only moves
 * when a direction change is actually committed, not on every scroll
 * frame. Without this, tiny sub-pixel-noisy deltas during a slow scroll
 * each get compared against the immediately-previous frame instead of
 * the last committed position, which is what produced the reveal
 * jitter/shake on slow upward scrolling — a stray frame crossing
 * `threshold` in the wrong direction would flip `hidden` and immediately
 * flip back.
 *
 * Activation gating: when `activation` is given, direction-based
 * hide/show only kicks in once the page has scrolled past the element's
 * own resting position (measured via a sentinel placed where the element
 * naturally sits before it goes sticky), offset by how far the element's
 * sticky `top` sits from the viewport top. Before that point `hidden` is
 * forced `false`, so the element just scrolls with the page like normal
 * content instead of reacting to scroll direction early.
 */
/** Slightly longer than the 300ms collapse transition in `CategoryBrowser`. */
const SETTLE_MS = 450;

export function useScrollDirection(
  threshold = 16,
  activation?: { ref: RefObject<HTMLElement | null>; offset?: number },
) {
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);
  const frame = useRef(0);
  const activationY = useRef<number | null>(null);
  const activated = useRef(!activation);
  // Until this timestamp, scroll events are treated as the layout's own
  // reaction to the last collapse/expand (see the settle note below).
  const settleUntil = useRef(0);

  const activationRef = activation?.ref;
  const activationOffset = activation?.offset ?? 0;

  useEffect(() => {
    lastY.current = window.scrollY;

    const measureActivation = () => {
      if (!activationRef?.current || activated.current) return;
      const rect = activationRef.current.getBoundingClientRect();
      activationY.current = rect.top + window.scrollY - activationOffset;
    };
    measureActivation();

    const handleScroll = () => {
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        measureActivation();
        const y = window.scrollY;

        if (!activated.current) {
          if (activationY.current !== null && y >= activationY.current) {
            activated.current = true;
          } else {
            setHidden(false);
            lastY.current = y;
            return;
          }
        }

        // Collapsing/expanding the element changes the page height, and the
        // browser answers with a scroll-position correction (scroll anchoring,
        // clamping near the bottom). That correction is not the visitor
        // scrolling; reading it as a direction change re-toggles the element
        // and loops (flicker). So while the change settles, ignore events and
        // re-baseline on the resulting position.
        if (performance.now() < settleUntil.current) {
          lastY.current = y;
          return;
        }

        const delta = y - lastY.current;

        if (y <= 0) {
          setHidden(false);
          lastY.current = y;
        } else if (delta >= threshold) {
          setHidden((prev) => {
            if (!prev) settleUntil.current = performance.now() + SETTLE_MS;
            return true;
          });
          lastY.current = y;
        } else if (delta <= -threshold) {
          setHidden((prev) => {
            if (prev) settleUntil.current = performance.now() + SETTLE_MS;
            return false;
          });
          lastY.current = y;
        }
      });
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", measureActivation);
    return () => {
      window.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", measureActivation);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [threshold, activationRef, activationOffset]);

  return hidden;
}
