import { ArrowLeft, Package } from "lucide-react";
import type { Category } from "@/types";

interface CategoryCardProps {
  category: Category;
}

/**
 * Homepage category button — pure navigation, no stats. Data-driven —
 * no category names hardcoded here.
 */
export function CategoryCard({ category }: CategoryCardProps) {
  return (
    <a
      href={`#${category.slug}`}
      className="group flex items-center justify-between gap-3 rounded-lg border border-brand-border bg-brand-bg-elevated px-4 py-3 transition-colors hover:border-brand-gold"
    >
      <div className="flex items-center gap-2.5">
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand-bg text-brand-gold">
          <Package size={16} />
        </span>
        <h3 className="text-sm font-bold text-brand-text group-hover:text-brand-gold sm:text-base">
          {category.name}
        </h3>
      </div>
      <ArrowLeft
        size={16}
        className="shrink-0 text-brand-text-muted transition-transform group-hover:-translate-x-1 group-hover:text-brand-gold"
      />
    </a>
  );
}
