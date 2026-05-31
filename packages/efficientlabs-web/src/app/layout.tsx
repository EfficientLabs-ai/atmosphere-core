import type { Metadata } from "next";
import { Outfit, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import SmoothScroll from "@/components/SmoothScroll";
import Navigation from "@/components/Navigation";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Efficient Labs | Sovereign Intelligence & DePIN Infrastructure",
  description: "Reclaiming sovereign machine intelligence. Launch the Atmosphere Mesh Network and deploy Stratos Agent natively across post-quantum, zero-trust infrastructure.",
  keywords: "DePIN, Solana, P2P Compute, Stratos Agent, Atmosphere Mesh, Post-Quantum Security, AI Orchestration",
  authors: [{ name: "Efficient Labs" }],
  openGraph: {
    type: "website",
    locale: "en_US",
    url: "https://efficientlabs.ai",
    title: "Efficient Labs | Sovereign Intelligence & DePIN Infrastructure",
    description: "Reclaiming sovereign machine intelligence. Launch the Atmosphere Mesh Network and deploy Stratos Agent natively.",
    siteName: "Efficient Labs",
  },
  twitter: {
    card: "summary_large_image",
    title: "Efficient Labs | Sovereign Intelligence & DePIN Infrastructure",
    description: "Reclaiming sovereign machine intelligence. Launch the Atmosphere Mesh Network and deploy Stratos Agent natively.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${outfit.variable} ${jetbrainsMono.variable}`}>
      <body className="antialiased bg-background text-foreground selection:bg-cyan/30 selection:text-cyan-light min-h-screen flex flex-col">
        {/* Lenis Inertial Scroll Controller */}
        <SmoothScroll />

        {/* Global Premium cybernetic navigation header */}
        <Navigation />

        {/* Core Site Pages Content */}
        <main className="flex-grow pt-24 z-10">
          {children}
        </main>

        {/* Global cybernetic footer */}
        <footer className="w-full border-t border-white/5 bg-onyx-dark/80 backdrop-blur-md py-8 mt-20 z-10">
          <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="font-mono text-cyan text-glow-cyan font-bold tracking-wider">▲ ATMOSPHERE</span>
              <span className="text-sterling-dark text-xs font-mono">v1.0.0-pqc</span>
            </div>
            <p className="text-sterling-dark text-xs font-mono">
              © 2026 Efficient Labs, Inc. Sovereign Machine Intelligence. All Rights Reserved.
            </p>
            <div className="flex items-center gap-6 font-mono text-xs text-sterling-dark">
              <a href="#" className="hover:text-cyan transition-colors">Terminals</a>
              <a href="#" className="hover:text-cyan transition-colors">Solana Treasury</a>
              <a href="#" className="hover:text-cyan transition-colors">Documentation</a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
