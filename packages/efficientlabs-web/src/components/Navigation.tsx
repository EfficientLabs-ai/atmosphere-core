"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { useState } from "react";
import { Terminal, Shield, Cpu, Activity } from "lucide-react";

const links = [
  { href: "/", label: "Ecosystem", icon: Cpu },
  { href: "/stratos", label: "Stratos Agent", icon: Terminal },
  { href: "/atmosphere", label: "Atmosphere Mesh", icon: Shield },
  { href: "/pricing", label: "Pricing & Credits", icon: Activity },
];

export default function Navigation() {
  const pathname = usePathname();
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  return (
    <header className="fixed top-0 left-0 right-0 z-50 flex justify-center px-4 py-6">
      <motion.nav 
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-5xl glassmorphism rounded-full px-6 py-3 flex justify-between items-center shadow-glow-onyx"
      >
        {/* Brand Wordmark & Logo */}
        <Link href="/" className="flex items-center gap-2 group">
          <span className="text-cyan text-glow-cyan font-bold tracking-wider font-mono text-lg transition-transform group-hover:scale-105 duration-300">
            ▲
          </span>
          <span className="font-sans font-extrabold text-sm tracking-widest text-sterling-light uppercase group-hover:text-cyan transition-colors">
            Efficient Labs
          </span>
        </Link>

        {/* Navigation Anchors */}
        <div className="hidden md:flex items-center gap-1 font-mono text-xs text-sterling">
          {links.map((link, idx) => {
            const isActive = pathname === link.href;
            const Icon = link.icon;
            return (
              <Link 
                key={link.href}
                href={link.href}
                className="relative px-4 py-2 rounded-full transition-colors flex items-center gap-1.5 hover:text-white"
                onMouseEnter={() => setHoveredIdx(idx)}
                onMouseLeave={() => setHoveredIdx(null)}
              >
                {/* Background Hover Indicator */}
                {hoveredIdx === idx && (
                  <motion.div 
                    layoutId="nav-hover"
                    className="absolute inset-0 bg-white/5 rounded-full"
                    transition={{ type: "spring", stiffness: 350, damping: 30 }}
                  />
                )}
                
                {/* Active Underline Indicator */}
                {isActive && (
                  <motion.div 
                    layoutId="nav-active"
                    className="absolute bottom-1 left-4 right-4 h-0.5 bg-cyan text-glow-cyan rounded-full"
                    transition={{ type: "spring", stiffness: 380, damping: 30 }}
                  />
                )}

                <Icon className={`w-3.5 h-3.5 ${isActive ? "text-cyan text-glow-cyan" : "text-sterling-dark"}`} />
                <span className={isActive ? "text-white" : "text-sterling"}>
                  {link.label}
                </span>
              </Link>
            );
          })}
        </div>

        {/* CTA Launch Anchor */}
        <Link href="/atmosphere">
          <motion.button 
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.95 }}
            className="font-mono text-xs font-bold text-background bg-cyan px-5 py-2 rounded-full hover:bg-cyan-light transition-all shadow-glow-cyan hover:shadow-glow-cyan-strong"
          >
            LAUNCH NODE
          </motion.button>
        </Link>
      </motion.nav>
    </header>
  );
}
