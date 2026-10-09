import type { Metadata, Viewport } from "next";
import { Ubuntu } from "next/font/google";
import "mapbox-gl/dist/mapbox-gl.css";
import "./globals.css";

// Ubuntu for text and headings (Kyle, 2026-10-09) — the same face as
// wally.guide and the Wally app's titles. Replaced Geist + Source Serif 4.
const ubuntu = Ubuntu({
  variable: "--font-ubuntu",
  subsets: ["latin"],
  weight: ["400", "500", "700"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "WallyMap",
  description: "A research tool for the outdoors. Ask the map: every answer is drawn, cited, and exportable.",
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
};

export const viewport: Viewport = {
  themeColor: "#FAF9F5",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${ubuntu.variable} h-full antialiased`}>
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
