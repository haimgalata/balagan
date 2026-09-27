import type { LucideIcon } from "lucide-react";
import type { Category } from "@/storefront/types";

interface CategoryCardProps {
  category: Category;
  active: boolean;
  count: number;
  icon?: LucideIcon;
  onSelect: () => void;
}

/**
 * Homepage main-category tab — toggles which category's products
 * `CategoryBrowser` shows. Data-driven — no category names hardcoded
 * here. `icon` and `count` are real, existing signal (a semantic icon
 * where one fits, and the category's live product count) rather than
 * decoration; see the redesign plan's "Visual Direction" section.
 */
export function CategoryCard({ category, active, count, icon: Icon, onSelect }: CategoryCardProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={`flex shrink-0 snap-start items-center gap-1.5 whitespace-nowrap rounded-lg border px-4 py-2.5 text-sm outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold sm:text-base ${
        active
          ? "border-brand-gold bg-brand-gold font-bold text-brand-bg"
          : "border-brand-border bg-brand-bg-elevated font-semibold text-brand-text hover:border-brand-gold hover:text-brand-gold"
      }`}
    >
      {Icon && <Icon size={16} className="shrink-0" aria-hidden="true" />}
      {category.name}
      <span className={active ? "text-brand-bg/70" : "text-brand-text-muted"}>· {count}</span>
    </button>
  );
}
