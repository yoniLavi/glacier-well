import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Glacier Well",
  description: "Grow and terraform a wandering planet with captured cometary ice",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
