// Tailwind v4 uses the dedicated PostCSS plugin; no tailwind.config required for the
// scaffold. Lane C's styles/tailwind.config.ts maps tokens → theme when it lands.
const config = {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};

export default config;
