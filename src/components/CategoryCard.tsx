import type { Category } from "@/types";

interface CategoryCardProps {
  category: Category;
  active: boolean;
  onSelect: () => void;
}

/**
 * Homepage main-category tab — text only (no icon), toggles which
 * category's products `CategoryBrowser` shows. Data-driven — no category
 * names hardcoded here.
 */
export function CategoryCard({ category, active, onSelect }: CategoryCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`shrink-0 whitespace-nowrap rounded-lg border px-4 py-2.5 text-sm font-bold transition-colors sm:text-base ${
        active
          ? "border-brand-gold bg-brand-gold text-brand-bg"
          : "border-brand-border bg-brand-bg-elevated text-brand-text hover:border-brand-gold hover:text-brand-gold"
      }`}
    >
      {category.name}
    </button>
  );
}
