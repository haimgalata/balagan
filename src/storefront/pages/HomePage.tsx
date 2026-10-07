import { Hero } from "@/storefront/components/Hero";
import { BusinessInfoBar } from "@/storefront/components/BusinessInfoBar";
import { SecurePaymentBar } from "@/storefront/components/SecurePaymentBar";
import { CategoryBrowser } from "@/storefront/components/CategoryBrowser";
import { LastOrderStripLoader } from "@/storefront/components/LastOrderStripLoader";

/**
 * Homepage — section order is just JSX order below: navbar (in `App.tsx`),
 * hero, sticky business-info strip, secure-payment strip, then the
 * category tabs + active category's products (`CategoryBrowser`, driven
 * by `seed-data/categories.ts` — currently cigarettes, then tobacco).
 */
export function HomePage() {
  return (
    <main id="top">
      <h1 className="sr-only">בלאגן - מרכז הסיגריות והטבק</h1>
      <LastOrderStripLoader />
      <Hero />
      <BusinessInfoBar />
      <SecurePaymentBar />
      <CategoryBrowser />
    </main>
  );
}
