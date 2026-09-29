import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

interface StreetFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  streets: readonly string[];
}

const MAX_SUGGESTIONS = 8;

const inputClasses =
  "w-full rounded-lg border border-brand-border bg-brand-bg px-3 py-2.5 text-base text-brand-text placeholder:text-brand-text-muted outline-none transition-colors focus-visible:border-brand-gold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold";

/**
 * A text field restricted to a fixed list of valid streets (delivery is Netivot-only — see
 * `data/netivotStreets.ts`). The customer can't submit free text: `DetailsForm` rejects any value that
 * isn't an exact match in `streets`, and this component's only job is to make picking a valid one easy —
 * a small hand-rolled combobox (filter-as-you-type + keyboard nav) rather than a new UI dependency, since
 * the option list is short and entirely local.
 */
export function StreetField({ id, label, value, onChange, error, streets }: StreetFieldProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = `${id}-listbox`;

  const suggestions = useMemo(() => {
    const query = value.trim();
    const list = query === "" ? streets : streets.filter((street) => street.includes(query));
    return list.slice(0, MAX_SUGGESTIONS);
  }, [value, streets]);

  useEffect(() => {
    setActiveIndex(-1);
  }, [suggestions]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  const select = (street: string) => {
    onChange(street);
    setOpen(false);
    setActiveIndex(-1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.min(index + 1, suggestions.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      if (open && activeIndex >= 0 && suggestions[activeIndex]) {
        event.preventDefault();
        select(suggestions[activeIndex]);
      }
    } else if (event.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-brand-text">
        {label}
      </label>
      <div ref={containerRef} className="relative">
        <input
          id={id}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined}
          aria-invalid={error ? true : undefined}
          autoComplete="off"
          placeholder="התחילו להקליד שם רחוב..."
          className={inputClasses}
        />
        {open && suggestions.length > 0 && (
          <ul id={listboxId} role="listbox" className="absolute inset-x-0 top-full z-10 mt-1 max-h-56 overflow-y-auto rounded-lg border border-brand-border bg-brand-bg-elevated shadow-lg">
            {suggestions.map((street, index) => (
              <li
                key={street}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                onMouseDown={(event) => {
                  event.preventDefault(); // keep focus on the input so the click isn't lost to blur
                  select(street);
                }}
                onMouseEnter={() => setActiveIndex(index)}
                className={`cursor-pointer px-3 py-2 text-sm ${index === activeIndex ? "bg-brand-gold/15 text-brand-gold" : "text-brand-text"}`}
              >
                {street}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs text-brand-danger">
          {error}
        </p>
      )}
    </div>
  );
}
