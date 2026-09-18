import type { MouseEvent } from "react";
import { useBusinessStatus } from "@/hooks/useBusinessStatus";

/**
 * Homepage hero — a real photo used as atmosphere behind a brand moment,
 * not a bare banner. A gradient (transparent → tobacco-brown → near-black,
 * toward the text side) keeps the overlay text legible without a flat
 * black box. The open/closed pill reads real, live data from
 * `useBusinessStatus` (same source `BusinessInfoBar` uses below it) —
 * nothing here is invented copy.
 *
 * The image is now taller than the old bare-banner crop (which was sized
 * to show the whole source photo) since it only needs to read as
 * atmosphere, not as the page's sole content.
 */
export function Hero() {
  const { isOpen, hoursLabel } = useBusinessStatus();

  const scrollToCategories = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    document.getElementById("categories")?.scrollIntoView({ block: "start" });
  };

  return (
    <section className="relative w-full overflow-hidden border-b border-brand-tobacco-strong bg-black">
      <div className="relative mx-auto max-w-container">
        <img
          src="/images/new_pic.png"
          alt=""
          aria-hidden="true"
          className="h-[220px] w-full object-cover object-center sm:h-[280px] md:h-[340px] lg:h-[400px] xl:h-[460px]"
        />

        <div
          className="absolute inset-0 bg-gradient-to-l from-black/10 via-brand-tobacco/75 to-black/90"
          aria-hidden="true"
        />

        <div className="absolute inset-0 flex flex-col items-start justify-end gap-2 p-4 sm:gap-2.5 sm:p-6 lg:p-10">
          <h2 className="font-display text-3xl leading-none text-brand-gold sm:text-4xl lg:text-5xl">
            בלגן
          </h2>
          <p className="max-w-[16rem] text-sm text-brand-text sm:max-w-xs sm:text-base lg:max-w-sm">
            הבית של הסיגריות והטבק בנתיבות
          </p>

          <span className="mt-1 flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1 text-xs font-semibold sm:text-sm">
            <span
              className={`h-1.5 w-1.5 shrink-0 rounded-full ${isOpen ? "bg-brand-success" : "bg-brand-danger"}`}
              aria-hidden="true"
            />
            <span className={isOpen ? "text-brand-success" : "text-brand-danger"}>
              {isOpen ? "פתוח עכשיו" : "סגור כעת"}
            </span>
            <span className="text-brand-text-muted">· {hoursLabel}</span>
          </span>

          <a
            href="#categories"
            onClick={scrollToCategories}
            className="mt-2 inline-flex items-center rounded-lg bg-brand-gold px-5 py-2.5 text-sm font-semibold text-brand-bg outline-none transition-colors hover:bg-brand-gold-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-text"
          >
            למוצרים
          </a>
        </div>
      </div>
    </section>
  );
}
