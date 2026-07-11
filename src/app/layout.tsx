import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Glacier Well",
  description: "Pilot an inertial terraforming ship and grow a wandering planet",
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
