import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ready2Ship — AI Code Review",
  description: "Open-source AI pull request review. Bring your own Gemini key.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
