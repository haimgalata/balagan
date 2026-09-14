/**
 * Homepage hero — image only, no text/buttons/overlay. Uses `<picture>`
 * so mobile/tablet get the mobile crop and desktop gets the desktop crop,
 * switching at the `md` breakpoint (768px). Kept compact on purpose —
 * roughly half the height of the original hero — so products are only
 * a short scroll away.
 */
export function Hero() {
  return (
    <section className="w-full overflow-hidden border-b border-brand-border bg-brand-bg-secondary">
      <picture>
        <source media="(min-width: 768px)" srcSet="/images/new_pic.png" />
        <img
          src="/images/new_pic.png"
          alt="בלגן - מרכז הסיגריות והטבק"
          className="h-[140px] w-full object-cover object-center sm:h-[170px] md:h-[200px]"
        />
      </picture>
    </section>
  );
}
