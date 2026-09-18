/**
 * Homepage hero — image only, no text/buttons/overlay. Kept compact on
 * purpose so products are only a short scroll away.
 *
 * The source image (`new_pic.png`) is a wide ~2.45:1 banner. Below `md` the
 * `<img>` stays full-bleed (`w-full`, no wrapper constraint) at a height
 * close to that ratio, so `object-cover` only trims a sliver — this is the
 * good mobile crop and it's left untouched.
 *
 * Above `md`, full-bleed width against a much shorter height made the ratio
 * wildly wider than the image (viewport-width : ~200px could be 9:1+ on a
 * wide monitor), so `object-cover` was cropping out almost everything but a
 * thin center band. Capping the wrapper at the same `max-w-container` the
 * rest of the page sections use (mx-auto — a no-op below that width, so
 * mobile/tablet are unaffected) keeps the crop ratio close enough to the
 * source image that a taller desktop height shows it fully and centered
 * instead. `xl:h-[375px]` (vs. `lg:h-[280px]`) is deliberately taller, not
 * just the next step up — `max-w-container` (90rem/1440px) is wider than
 * the old 72rem cap, so the container itself is wider at this breakpoint
 * too, and the height needs to grow with it to keep the same crop ratio.
 */
export function Hero() {
  return (
    <section className="w-full overflow-hidden border-b border-brand-border bg-black">
      <div className="mx-auto max-w-container">
        <img
          src="/images/new_pic.png"
          alt="בלגן - מרכז הסיגריות והטבק"
          className="h-[140px] w-full object-cover object-center sm:h-[170px] md:h-[240px] lg:h-[280px] xl:h-[375px]"
        />
      </div>
    </section>
  );
}
