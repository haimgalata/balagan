import { Hero } from "@/components/Hero";
import { CategoryCard } from "@/components/CategoryCard";
import { CategorySection } from "@/components/CategorySection";
import { categories } from "@/data/categories";

/**
 * Homepage — section order is just JSX order below: navbar (in `App.tsx`),
 * hero, categories, then one `CategorySection` per category in
 * `src/data/categories.ts` (currently cigarettes, then tobacco).
 */
export function HomePage() {
  return (
    <main id="top">
      <Hero />

      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <section id="categories" className="scroll-mt-16 py-5 sm:py-7">
          <h2 className="mb-3 text-lg font-bold text-brand-text sm:text-xl">קטגוריות</h2>
          <div className="grid grid-cols-2 gap-2 sm:gap-3">
            {categories.map((category) => (
              <CategoryCard key={category.id} category={category} />
            ))}
          </div>
        </section>

        <div className="border-t border-brand-border">
          {categories.map((category) => (
            <CategorySection key={category.id} category={category} />
          ))}
        </div>
      </div>
    </main>
  );
}
