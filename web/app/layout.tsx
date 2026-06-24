// web/app/layout.tsx — (C) placeholder shell. Lane C owns this: RSC root, fonts
// (Geist Sans/Mono, Space Grotesk), theme, mounts the scene + HUD shells. Lane 0
// ships a minimal render only — zero behavior.
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
