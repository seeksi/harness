// console/app/layout.tsx — RSC root shell.
// Fonts self-hosted via next/font/google (no layout shift, no external runtime fetch):
//   Geist Sans  — UI/body        (--font-geist-sans)
//   Geist Mono  — tabular data    (--font-geist-mono)
//   Oxanium     — DISPLAY face, industrial/mechanical character, project names +
//                 big numbers ONLY (--font-oxanium); must not leak into chrome.
import type { Metadata } from "next";
import { Geist, Geist_Mono, Oxanium } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ subsets: ["latin"], variable: "--font-geist-sans", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });
const oxanium = Oxanium({ subsets: ["latin"], variable: "--font-oxanium", weight: ["500", "600", "700"], display: "swap" });

export const metadata: Metadata = {
  title: "GANTRY · mission control",
  description: "Multi-project agent mission control — launch, watch, and steer harness runs.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} ${oxanium.variable}`}>{children}</body>
    </html>
  );
}
