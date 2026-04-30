import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";

import { Sidebar } from "@/app/components/Sidebar";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ETL — Unleashed Data Warehouse",
  description: "Production ETL data warehouse for Unleashed and downstream systems.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${jetbrainsMono.variable} antialiased`}>
        <div className="flex min-h-screen bg-[#0B0F14]">
          <Sidebar />
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </body>
    </html>
  );
}
