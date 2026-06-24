// web/app/layout.tsx — Lane C sole writer.
// RSC root shell. Fonts + theme mount here (design-polish increment).
// Geist Sans 13px (UI/body) + Geist Mono 12px tabular-lining (data) + Space Grotesk
// reserved for large 3D node labels ONLY (scene/**) — exposed as CSS vars so the
// HUD reads --font-geist-sans/--font-geist-mono and the scene reads
// --font-space-grotesk, with the boundary kept in CSS (display font never styles
// HUD chrome). Loaded via next/font/google (self-hosted, no layout shift).
import type { Metadata } from "next";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

// Space Grotesk: large holographic node labels only — must not leak into HUD chrome.
const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Umbrella",
  description: "HARNESS four-phase agent build pipeline — holographic control panel",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} ${spaceGrotesk.variable}`}>
        {children}
      </body>
    </html>
  );
}
