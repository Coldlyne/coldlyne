import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";

const sans = Geist({ variable: "--font-brand-sans", subsets: ["latin"], display: "swap" });
const mono = Geist_Mono({ variable: "--font-brand-mono", subsets: ["latin"], display: "swap" });
const serif = Instrument_Serif({ variable: "--font-brand-serif", subsets: ["latin"], weight: "400", style: "italic", display: "swap" });

export const metadata: Metadata = {
  title: { default: "Coldlyne", template: "%s · Coldlyne" },
  description: "Votre prospection depuis Claude ou ChatGPT.",
  robots: { index: false },
};

/** The browser's own bar in the app's midnight, which is dark only. */
export const viewport: Viewport = { themeColor: "#030408", colorScheme: "dark" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr" className={`dark ${sans.variable} ${mono.variable} ${serif.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
