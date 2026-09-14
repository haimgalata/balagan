import { useEffect, useRef, useState } from "react";

/**
 * Hide-on-scroll-down / show-on-scroll-up behavior for a fixed header.
 *
 * Returns `true` when the header should be hidden. Always visible at the
 * very top of the page. A small `threshold` (px) absorbs tiny scroll
 * jitter (e.g. mobile bounce/rubber-banding) so the header doesn't
 * flicker on movements that aren't a deliberate scroll.
 */
export function useSmartHeader(threshold = 8) {
  const [hidden, setHidden] = useState(false);
  const lastY = useRef(0);
  const frame = useRef(0);

  useEffect(() => {
    lastY.current = window.scrollY;

    const handleScroll = () => {
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        const y = window.scrollY;
        const delta = y - lastY.current;

        if (y <= 0) {
          setHidden(false);
        } else if (Math.abs(delta) >= threshold) {
          setHidden(delta > 0);
        }
        lastY.current = y;
      });
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", handleScroll);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [threshold]);

  return hidden;
}
