import type { Metadata, Viewport } from "next";
import { Geologica } from "next/font/google";
import "mapbox-gl/dist/mapbox-gl.css";
import "./globals.css";

// Geologica for headings (Kyle, 2026-10-14) — the title face on wally.guide
// and the Wally app. Text is the system font, Light.
const geologica = Geologica({
  variable: "--font-geologica",
  subsets: ["latin"],
  weight: ["600", "700"],
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
  // The map runs edge to edge under the notch and home indicator; the controls move in by the safe-area insets
  // (--safe-* in app/globals.css).
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geologica.variable} h-full antialiased`}>
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
