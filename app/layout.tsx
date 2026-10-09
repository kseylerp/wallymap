import type { Metadata, Viewport } from "next";
import "mapbox-gl/dist/mapbox-gl.css";
import "./globals.css";
import { ThemeScript } from "@/lib/theme/ThemeScript";

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
    // Light by default; the inline script applies a stored dark choice before first paint.
    <html lang="en" data-theme="light" className="h-full antialiased" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="h-full overflow-hidden">{children}</body>
    </html>
  );
}
