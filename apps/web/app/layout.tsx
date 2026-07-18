import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "PasarAI",
  description:
    "A multilingual daily gross-margin copilot for Malaysian food micro-vendors."
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ms">
      <body>{children}</body>
    </html>
  );
}
