/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "hsl(var(--bg) / <alpha-value>)",
        fg: "hsl(var(--fg) / <alpha-value>)",
        muted: "hsl(var(--muted) / <alpha-value>)",
        "muted-fg": "hsl(var(--muted-fg) / <alpha-value>)",
        card: "hsl(var(--card) / <alpha-value>)",
        "card-fg": "hsl(var(--card-fg) / <alpha-value>)",
        line: "hsl(var(--line) / <alpha-value>)",
        accent: "hsl(var(--accent) / <alpha-value>)",
        "accent-fg": "hsl(var(--accent-fg) / <alpha-value>)",
        sidebar: "hsl(var(--sidebar) / <alpha-value>)",
        "sidebar-fg": "hsl(var(--sidebar-fg) / <alpha-value>)",
        ok: "hsl(var(--ok) / <alpha-value>)",
        warn: "hsl(var(--warn) / <alpha-value>)",
        danger: "hsl(var(--danger) / <alpha-value>)",
        stories: "#E86A33",
        milana: "#2FA36B",
        life: "#3B7BD6",
        veronica: "#D4537E",
      },
      fontFamily: {
        sans: ["Manrope", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["Manrope", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        soft: "0 1px 2px rgba(16,18,27,0.04), 0 8px 24px rgba(16,18,27,0.06)",
        lift: "0 12px 40px rgba(16,18,27,0.12)",
      },
      borderRadius: {
        xl: "1rem",
        "2xl": "1.25rem",
        "3xl": "1.75rem",
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.55" },
        },
      },
      animation: {
        "fade-in": "fade-in 0.35s ease both",
        "pulse-soft": "pulse-soft 1.8s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
