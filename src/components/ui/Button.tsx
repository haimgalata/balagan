import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "outline";
type Size = "xs" | "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  children: ReactNode;
}

const variantClasses: Record<Variant, string> = {
  primary:
    "bg-brand-gold text-brand-bg font-semibold hover:bg-brand-gold-hover active:bg-brand-gold-hover disabled:bg-brand-gold/40 disabled:text-brand-bg/60",
  secondary:
    "bg-brand-bg-elevated text-brand-text border border-brand-border hover:border-brand-border-strong disabled:opacity-50",
  outline:
    "bg-transparent text-brand-gold border border-brand-gold hover:bg-brand-gold hover:text-brand-bg disabled:opacity-40",
  ghost: "bg-transparent text-brand-text hover:bg-brand-bg-elevated disabled:opacity-40",
};

const sizeClasses: Record<Size, string> = {
  // Tighter padding/font below `sm` so two `xs` buttons fit side by side
  // in the narrow ProductCard footer without overflowing; sm: values
  // match the previous fixed sizing exactly, so `sm` and up are unchanged.
  xs: "text-[11px] px-1 py-2.5 rounded-md gap-1 sm:px-2 sm:text-xs",
  sm: "text-sm px-3 py-1.5 rounded-md gap-1.5",
  md: "text-sm px-4 py-2.5 rounded-lg gap-2",
  lg: "text-base px-6 py-3.5 rounded-lg gap-2",
};

/**
 * Central button primitive. All CTA styling (colors, radius, states)
 * flows through here so it can be tuned once for the whole site.
 */
export function Button({
  variant = "primary",
  size = "md",
  className = "",
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      className={`inline-flex min-w-0 items-center justify-center whitespace-nowrap outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-gold disabled:cursor-not-allowed ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
