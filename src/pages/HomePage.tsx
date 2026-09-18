import { Hero } from "@/components/Hero";
import { BusinessInfoBar } from "@/components/BusinessInfoBar";
import { SecurePaymentBar } from "@/components/SecurePaymentBar";
import { CategoryBrowser } from "@/components/CategoryBrowser";

/**
 * Homepage — section order is just JSX order below: navbar (in `App.tsx`),
 * hero, sticky business-info strip, secure-payment strip, then the
 * category tabs + active category's products (`CategoryBrowser`, driven
 * by `src/data/categories.ts` — currently cigarettes, then tobacco).
 */
export function HomePage() {
  return (
    <main id="top">
      <h1 className="sr-only">בלגן - מרכז הסיגריות והטבק</h1>
      <Hero />
      <BusinessInfoBar />
      <SecurePaymentBar />
      <CategoryBrowser />
    </main>
  );
}
