/**
 * Admin tables are real tables from `md` up; on a phone each row becomes a small card (one `label  value` line per
 * column) instead of a sideways-scrolling strip. Same DOM either way — only classes change — so rows, cells and
 * test ids are identical on every screen. The mobile label is `aria-hidden`: a cell's accessible name stays its value.
 */
export const RT_TABLE = "w-full text-sm max-md:block md:min-w-[42rem]";
export const RT_HEAD = "max-md:sr-only";
export const RT_BODY = "max-md:block";
export const RT_ROW = "max-md:block max-md:px-3 max-md:py-2.5";
export const RT_CELL = "px-3 py-2 max-md:flex max-md:items-baseline max-md:justify-between max-md:gap-3 max-md:px-0 max-md:py-1";

/** The column name shown beside the value on a phone (hidden from `md` up, where the table header says it). */
export function MobileLabel({ children }: { children: string }) {
  return (
    <span aria-hidden="true" className="shrink-0 text-xs text-brand-text-muted md:hidden">
      {children}
    </span>
  );
}
