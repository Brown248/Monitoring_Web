import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_Thai } from "next/font/google";
import type { ReactNode } from "react";
import { Toaster } from "@/components/client/toast";
import { SessionBanner } from "@/components/client/session-banner";
import { TipLayer } from "@/components/client/tip-layer";
import "./globals.css";

const plexThai = IBM_Plex_Sans_Thai({
  subsets: ["thai", "latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-plex-thai",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "SYNTECH Web Monitor", template: "%s · SYNTECH Web Monitor" },
  description: "ระบบตรวจสถานะเว็บไซต์ภายในองค์กร",
};

// ตั้งธีมก่อน paint แรก (กันหน้าขาวกระพริบในโหมดมืด) — ค่า: "light" | "dark" | ไม่มี = ตามระบบ
const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem("wm-theme");var d=t==="dark"||(t==="system"&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d)}catch(e){}})()`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th" className={`${plexThai.variable} ${plexMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-screen font-sans antialiased">
        {children}
        <Toaster />
        <SessionBanner />
        <TipLayer />
      </body>
    </html>
  );
}
