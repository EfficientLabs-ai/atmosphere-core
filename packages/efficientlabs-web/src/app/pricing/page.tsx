"use client";

import { motion } from "framer-motion";
import { Check, Zap, Terminal, Shield, Star, Globe } from "lucide-react";

const tiers = [
  {
    name: "Seed Plan",
    price: "Free",
    icon: Globe,
    description: "Connect to the network and run sovereign local-first nodes.",
    features: [
      "Idle compute credits exchange",
      "Standard P2P DHT swarming",
      "Local-first RAG vector database",
      "Community forum support",
    ],
    highlight: false,
    cta: "LAUNCH FREE",
  },
  {
    name: "Pro Plan",
    price: "$19",
    period: "/mo",
    icon: Terminal,
    description: "For power developers and advanced AI builders.",
    features: [
      "Unlimited local intercept shims",
      "Night Shift GSI evolution compilers",
      "Signed WASM dynamic hot-loaders",
      "Priority local-inference routing",
      "24/7 client developer channels",
    ],
    highlight: true,
    cta: "UPGRADE TO PRO",
  },
  {
    name: "Business Plan",
    price: "$99",
    period: "/mo",
    icon: Zap,
    description: "For startups, teams, and collaborative workflows.",
    features: [
      "Cloud API offset request routing",
      "Omni-channel context webhook isolation",
      "Shared telemetry databases",
      "Custom LanceDB vector collections",
      "Standard team access control",
    ],
    highlight: false,
    cta: "GET BUSINESS",
  },
  {
    name: "Sovereign",
    price: "$1,497",
    period: "/mo",
    icon: Shield,
    description: "Air-gapped infrastructure for regulated enterprise.",
    features: [
      "Air-gapped secure hardware enclaves",
      "Custom ML-DSA-65 signed binaries",
      "Z3 formal runtime verification",
      "SOC 2, HIPAA & FIPS 140 compliance",
      "Dedicated sovereign solutions architect",
    ],
    highlight: false,
    cta: "CONTACT SALES",
  },
];

export default function Pricing() {
  return (
    <div className="relative w-full overflow-hidden bg-background">
      {/* Grid and glows */}
      <div className="absolute inset-0 bg-cyber-grid opacity-20 z-0" />
      <div className="absolute bottom-1/4 right-1/3 w-[500px] h-[500px] bg-cyan/5 rounded-full filter blur-[120px] pointer-events-none z-0" />

      {/* Header */}
      <section className="relative z-10 max-w-7xl mx-auto px-6 pt-12 pb-16 text-center">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="font-mono text-xs text-cyan tracking-widest uppercase mb-4"
        >
          Dynamic Business Model
        </motion.div>
        
        <motion.h1
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="text-4xl sm:text-6xl font-sans font-black text-white uppercase tracking-tight"
        >
          Sovereign Business Plans
        </motion.h1>
        
        <p className="max-w-3xl mx-auto mt-6 text-zinc-400 font-sans text-base sm:text-lg leading-relaxed">
          From zero-cost decentralized node swarms to enterprise-grade air-gapped sandboxes. Scale your machine intelligence securely and transparently.
        </p>
      </section>

      {/* Pricing Matrix */}
      <section className="relative z-10 max-w-7xl mx-auto px-6 py-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 items-stretch">
          {tiers.map((tier, idx) => {
            const Icon = tier.icon;
            return (
              <motion.div
                key={tier.name}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: idx * 0.1 }}
                whileHover={{ y: -6 }}
                className={`glassmorphism rounded-3xl p-6 flex flex-col justify-between border transition-all duration-300 relative overflow-hidden h-full ${
                  tier.highlight 
                    ? "border-cyan/40 shadow-glow-cyan bg-onyx-dark/80" 
                    : "border-white/5 hover:border-cyan/20"
                }`}
              >
                {/* Popular Highlight Badge */}
                {tier.highlight && (
                  <div className="absolute top-4 right-4 bg-cyan/15 border border-cyan/35 rounded-full px-2.5 py-1 flex items-center gap-1">
                    <Star className="w-3 h-3 text-cyan fill-cyan animate-pulse" />
                    <span className="text-[9px] font-mono font-bold text-cyan-light uppercase tracking-wider">
                      Recommended
                    </span>
                  </div>
                )}

                <div>
                  {/* Icon */}
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-6 ${
                    tier.highlight ? "bg-cyan/15 border border-cyan/30" : "bg-white/5"
                  }`}>
                    <Icon className={`w-5 h-5 ${tier.highlight ? "text-cyan text-glow-cyan" : "text-sterling"}`} />
                  </div>

                  {/* Title & Description */}
                  <h3 className="font-sans font-black text-xl text-white uppercase tracking-wider">
                    {tier.name}
                  </h3>
                  <p className="text-zinc-500 text-xs mt-2 font-sans min-h-[32px]">
                    {tier.description}
                  </p>

                  {/* Price */}
                  <div className="mt-6 flex items-baseline gap-1 text-white">
                    <span className="text-3xl sm:text-4xl font-sans font-black">
                      {tier.price}
                    </span>
                    {tier.period && (
                      <span className="font-mono text-xs text-sterling-dark uppercase">
                        {tier.period}
                      </span>
                    )}
                  </div>

                  {/* Divider */}
                  <div className="h-px bg-white/5 my-6" />

                  {/* Features */}
                  <ul className="space-y-3 font-sans text-xs">
                    {tier.features.map((feature) => (
                      <li key={feature} className="flex items-start gap-2.5 text-sterling">
                        <Check className="w-3.5 h-3.5 text-cyan mt-0.5 flex-shrink-0" />
                        <span className="leading-relaxed text-zinc-400">{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>

                {/* CTA Action Button */}
                <button className={`w-full font-mono text-xs font-bold py-3.5 rounded-full mt-8 transition-all uppercase ${
                  tier.highlight
                    ? "bg-cyan text-background hover:bg-cyan-light shadow-glow-cyan hover:shadow-glow-cyan-strong"
                    : "bg-white/5 border border-white/10 hover:border-cyan/30 text-white hover:bg-cyan/5"
                }`}>
                  {tier.cta}
                </button>
              </motion.div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
