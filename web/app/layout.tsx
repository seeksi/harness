// web/app/layout.tsx — Lane C sole writer.
// RSC root shell. Fonts + theme mount here (Space Grotesk + Geist when fonts increment lands).
// ponytail: font loading (next/font/google) — add when token/design-polish increment lands.
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Umbrella",
  description: "HARNESS four-phase agent build pipeline — holographic control panel",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
