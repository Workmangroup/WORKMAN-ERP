import type { Metadata, Viewport } from "next";
import { Inter, Noto_Sans_Arabic } from "next/font/google";
import { AuthProvider } from "@/lib/auth";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const arabic = Noto_Sans_Arabic({ subsets: ["arabic"], variable: "--font-arabic" });

export const metadata: Metadata = {
  title: { default: "WORKVOICE — Portail Collaborateur Workman", template: "%s · WORKVOICE" },
  description: "Demandes RH, réclamations et suggestions des collaborateurs Workman.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { themeColor: "#0b3d91" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr" className={`${inter.variable} ${arabic.variable} h-full antialiased`}>
      <body className="min-h-full">
        <AuthProvider>{children}</AuthProvider>
        <Toaster theme="light" richColors position="top-right" />
      </body>
    </html>
  );
}
