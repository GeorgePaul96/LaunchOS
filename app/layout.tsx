import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "LaunchOS", description: "Autonomous growth layer" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
