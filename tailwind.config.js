/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  // Дизайн-система DesignVK живёт в src/index.css (классы .surface, .btn, .field и т.д.).
  // Tailwind остаётся для структурных утилит (grid/flex/gap/…), цвета задаются CSS-переменными.
  theme: {
    extend: {
      colors: {
        stories: "#F59E0B",
        milana: "#8B5CF6",
        life: "#22C55E",
        veronica: "#EC4899",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
