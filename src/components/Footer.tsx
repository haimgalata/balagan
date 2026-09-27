import { Phone } from "lucide-react";
import { useCatalog } from "@/context/CatalogContext";

/**
 * Site footer — business blurb, contact, a category sitemap generated
 * from the catalog (grows automatically as categories are added, no
 * changes needed here), and the legal line. Category links activate the
 * right section on load via `CategoryBrowser`'s hash-read.
 */
export function Footer() {
  const { categories } = useCatalog();

  return (
    <footer className="border-t border-brand-tobacco-strong bg-brand-bg-secondary">
      <div className="mx-auto flex max-w-container flex-col items-center gap-5 px-4 py-8 text-center sm:px-6 sm:py-10">
        <span className="font-display text-xl text-brand-gold">בלאגן</span>

        <p className="max-w-md text-sm leading-relaxed text-brand-text-muted">
          מרכז הסיגריות והטבק בלאגן — חנות ותיקה למוצרי עישון וטבק.
        </p>

        <nav aria-label="קטגוריות" className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          {categories.map((category) => (
            <a
              key={category.id}
              href={`#${category.slug}`}
              className="text-sm text-brand-text-muted outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold"
            >
              {category.name}
            </a>
          ))}
        </nav>

        <a
          href="tel:089945190"
          className="flex items-center gap-2 rounded-md text-sm text-brand-text-muted outline-none transition-colors hover:text-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold"
        >
          <Phone size={16} />
          08-994-5190
        </a>
      </div>

      <div className="border-t border-brand-border px-4 py-4 text-center sm:px-6">
        <p className="text-xs text-brand-text-muted">
          המכירה אסורה לבני 21 ומטה. העישון מזיק לבריאות.
        </p>
        <p className="mt-1 text-xs text-brand-text-muted">
          © {new Date().getFullYear()} בלאגן - מרכז הסיגריות והטבק. כל הזכויות שמורות.
        </p>
      </div>
    </footer>
  );
}
