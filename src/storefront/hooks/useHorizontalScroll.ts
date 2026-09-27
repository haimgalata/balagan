import { useCallback, useEffect, useRef, useState } from "react";

interface UseHorizontalScrollResult {
  scrollerRef: React.RefObject<HTMLDivElement>;
  canScrollStart: boolean;
  canScrollEnd: boolean;
  scroll: (direction: "prev" | "next") => void;
}

/**
 * Shared engine behind every horizontally-scrolling pill/tab row in the
 * app: tracks whether there's more content in either direction (for
 * fade/arrow affordances), redirects vertical wheel/trackpad input to
 * horizontal scroll, and exposes a `scroll` function for prev/next
 * buttons. Originally built for `SubcategoryNav`; extracted here so the
 * category tab row can reuse the exact same behavior instead of
 * duplicating it.
 *
 * Scroll math assumes the modern, spec-compliant RTL `scrollLeft` behavior
 * (0 at the start/right edge, growing negative as content scrolls toward
 * the left).
 *
 * `deps` re-attaches the listeners when the scroller's content changes
 * out from under the same DOM node (e.g. switching category swaps
 * `SubcategoryNav`'s pills and thus its scrollable width).
 */
export function useHorizontalScroll(deps: readonly unknown[] = []): UseHorizontalScrollResult {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canScrollStart, setCanScrollStart] = useState(false);
  const [canScrollEnd, setCanScrollEnd] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const maxScroll = el.scrollWidth - el.clientWidth;
    setCanScrollStart(el.scrollLeft < -1);
    setCanScrollEnd(el.scrollLeft > -(maxScroll - 1));
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    updateScrollState();

    const handleWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      el.scrollLeft += event.deltaY;
      event.preventDefault();
    };

    el.addEventListener("scroll", updateScrollState, { passive: true });
    el.addEventListener("wheel", handleWheel, { passive: false });

    const resizeObserver = new ResizeObserver(updateScrollState);
    resizeObserver.observe(el);

    return () => {
      el.removeEventListener("scroll", updateScrollState);
      el.removeEventListener("wheel", handleWheel);
      resizeObserver.disconnect();
    };
    // `deps` lets callers re-attach when the scroller's content changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateScrollState, ...deps]);

  const scroll = (direction: "prev" | "next") => {
    const el = scrollerRef.current;
    if (!el) return;
    const amount = el.clientWidth * 0.6;
    el.scrollBy({ left: direction === "next" ? -amount : amount, behavior: "smooth" });
  };

  return { scrollerRef, canScrollStart, canScrollEnd, scroll };
}
