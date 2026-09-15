/**
 * Tailwind theme configuration.
 *
 * All brand colors are read from CSS custom properties defined in
 * `src/styles/theme.css`. To re-brand the site (colors only), edit that
 * file — do NOT hardcode hex values in components or here.
 */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  darkMode: ["class"],
  // `hover:` only matches on pointers that actually support hovering
  // (@media (hover: hover)). Without this, tapping a button on a touch
  // device applies its `hover:` style and it visually "sticks" until the
  // user taps elsewhere, since there's no real pointer to leave the
  // element. Desktop mouse users are unaffected.
  future: {
    hoverOnlyWhenSupported: true,
  },
  theme: {
    extend: {
      colors: {
        brand: {
          bg: "rgb(var(--color-bg) / <alpha-value>)",
          "bg-secondary": "rgb(var(--color-bg-secondary) / <alpha-value>)",
          "bg-elevated": "rgb(var(--color-bg-elevated) / <alpha-value>)",
          border: "rgb(var(--color-border) / <alpha-value>)",
          "border-strong": "rgb(var(--color-border-strong) / <alpha-value>)",
          gold: "rgb(var(--color-gold) / <alpha-value>)",
          "gold-hover": "rgb(var(--color-gold-hover) / <alpha-value>)",
          "gold-muted": "rgb(var(--color-gold-muted) / <alpha-value>)",
          text: "rgb(var(--color-text) / <alpha-value>)",
          "text-muted": "rgb(var(--color-text-muted) / <alpha-value>)",
          danger: "rgb(var(--color-danger) / <alpha-value>)",
          success: "rgb(var(--color-success) / <alpha-value>)",
        },
      },
      fontFamily: {
        sans: ["Heebo", "Assistant", "system-ui", "sans-serif"],
      },
      maxWidth: {
        // Shared site content width (`max-w-container`), used by every
        // section wrapper (Header, Hero, BusinessInfoBar, SecurePaymentBar,
        // HomePage, Footer) instead of a bare Tailwind size, so the whole
        // site's width caps in one place. 90rem/1440px reads as a modern
        // "wide" desktop layout without feeling stretched on very large
        // monitors; below that width (including every mobile/tablet size)
        // it's a no-op and content already fills the viewport.
        container: "90rem",
      },
    },
  },
  plugins: [],
};
