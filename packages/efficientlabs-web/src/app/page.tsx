"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Terminal, Shield, Cpu, ArrowRight, Zap, RefreshCw, Layers } from "lucide-react";

export default function Home() {
  return (
    <div className="relative w-full overflow-hidden bg-background">
      {/* Cyber Grid Background */}
      <div className="absolute inset-0 bg-cyber-grid opacity-30 z-0" />
      
      {/* Cybernetic Radial Glows */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-cyan/5 rounded-full filter blur-[120px] pointer-events-none z-0" />
      <div className="absolute bottom-10 left-1/4 w-[400px] h-[400px] bg-cyan/5 rounded-full filter blur-[100px] pointer-events-none z-0" />

      {/* Hero Section */}
      <section className="relative z-10 max-w-7xl mx-auto px-6 pt-16 pb-24 md:py-32 flex flex-col items-center text-center">
        <motion.div
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-cyan/20 bg-cyan/5 backdrop-blur-md mb-8"
        >
          <span className="w-2 h-2 rounded-full bg-cyan animate-pulse-cyan shadow-glow-cyan" />
          <span className="text-[10px] font-mono text-cyan-light tracking-widest uppercase">
            Atmosphere Mesh v1.0.0 is Live
          </span>
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.1 }}
          className="text-4xl sm:text-6xl md:text-8xl font-sans font-black tracking-tight text-white uppercase leading-none"
        >
          Reclaim <br className="hidden sm:inline" />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-white via-cyan-light to-cyan text-glow-cyan">
            Sovereign Intelligence
          </span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
          className="max-w-3xl mt-8 text-sterling font-sans text-base sm:text-lg md:text-xl leading-relaxed text-zinc-400"
        >
          Efficient Labs is deploying the world’s first decentralized, post-quantum secure P2P AI orchestration layer. End data sharecropping. Deploy sovereign sandboxed agents on global idle compute networks.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.3 }}
          className="flex flex-col sm:flex-row items-center gap-4 mt-12 w-full justify-center"
        >
          <Link href="/stratos" className="w-full sm:w-auto">
            <button className="w-full font-mono text-xs font-bold text-background bg-white px-8 py-4 rounded-full hover:bg-sterling-light transition-all flex items-center justify-center gap-2 group">
              DEPLOY STRATOS
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-1" />
            </button>
          </Link>
          <Link href="/atmosphere" className="w-full sm:w-auto">
            <button className="w-full font-mono text-xs font-bold text-white border border-white/10 hover:border-cyan/50 hover:bg-cyan/5 px-8 py-4 rounded-full transition-all flex items-center justify-center gap-2">
              RUN A NODE
              <Zap className="w-4 h-4 text-cyan" />
            </button>
          </Link>
        </motion.div>
      </section>

      {/* Core Ecosystem Pillars Section */}
      <section className="relative z-10 max-w-7xl mx-auto px-6 py-20 border-t border-white/5">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          
          {/* Pillar 1: Stratos Agent */}
          <motion.div 
            whileHover={{ y: -6 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            className="glassmorphism rounded-3xl p-8 flex flex-col h-full hover:border-cyan/30 duration-300 relative group overflow-hidden"
          >
            <div className="absolute -right-10 -top-10 w-36 h-36 bg-cyan/5 rounded-full filter blur-xl group-hover:bg-cyan/10 transition-colors" />
            <div className="bg-cyan/10 border border-cyan/20 w-12 h-12 rounded-2xl flex items-center justify-center mb-6">
              <Terminal className="w-6 h-6 text-cyan" />
            </div>
            <h3 className="font-sans font-black text-xl text-white uppercase tracking-wider">
              Stratos Agent Core
            </h3>
            <p className="text-sterling-dark text-sm mt-4 font-sans leading-relaxed flex-grow">
              A private, sovereign, local-first dynamic agent. Fully compatible with OpenAI/Anthropic shims, running local-first RAG and execution traces.
            </p>
            <Link href="/stratos" className="mt-8 inline-flex items-center gap-1 text-xs font-mono text-cyan hover:text-cyan-light transition-colors">
              INSPECT AGENT SPEC <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </motion.div>

          {/* Pillar 2: Atmosphere Mesh */}
          <motion.div 
            whileHover={{ y: -6 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            className="glassmorphism rounded-3xl p-8 flex flex-col h-full hover:border-cyan/30 duration-300 relative group overflow-hidden"
          >
            <div className="absolute -right-10 -top-10 w-36 h-36 bg-cyan/5 rounded-full filter blur-xl group-hover:bg-cyan/10 transition-colors" />
            <div className="bg-cyan/10 border border-cyan/20 w-12 h-12 rounded-2xl flex items-center justify-center mb-6">
              <Shield className="w-6 h-6 text-cyan" />
            </div>
            <h3 className="font-sans font-black text-xl text-white uppercase tracking-wider">
              Atmosphere DePIN
            </h3>
            <p className="text-sterling-dark text-sm mt-4 font-sans leading-relaxed flex-grow">
              Decentralized mesh networks powered by standard P2P DHT nodes. Encrypted, hyper-resilient swarming, zero cloud reliance.
            </p>
            <Link href="/atmosphere" className="mt-8 inline-flex items-center gap-1 text-xs font-mono text-cyan hover:text-cyan-light transition-colors">
              EXPLORE INFRASTRUCTURE <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </motion.div>

          {/* Pillar 3: x402 Micropayments */}
          <motion.div 
            whileHover={{ y: -6 }}
            transition={{ type: "spring", stiffness: 300, damping: 20 }}
            className="glassmorphism rounded-3xl p-8 flex flex-col h-full hover:border-cyan/30 duration-300 relative group overflow-hidden"
          >
            <div className="absolute -right-10 -top-10 w-36 h-36 bg-cyan/5 rounded-full filter blur-xl group-hover:bg-cyan/10 transition-colors" />
            <div className="bg-cyan/10 border border-cyan/20 w-12 h-12 rounded-2xl flex items-center justify-center mb-6">
              <Layers className="w-6 h-6 text-cyan" />
            </div>
            <h3 className="font-sans font-black text-xl text-white uppercase tracking-wider">
              x402 Protocol
            </h3>
            <p className="text-sterling-dark text-sm mt-4 font-sans leading-relaxed flex-grow">
              Cryptographic Proof-of-Work task billing and auto-settlements over Solana. Micro-credit rolls automatically settling at 0.005 SOL.
            </p>
            <Link href="/pricing" className="mt-8 inline-flex items-center gap-1 text-xs font-mono text-cyan hover:text-cyan-light transition-colors">
              VIEW CREDIT RATES <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </motion.div>

        </div>
      </section>

      {/* Futuristic Visual Monorepo Architecture Stub */}
      <section className="relative z-10 max-w-5xl mx-auto px-6 py-20">
        <div className="glassmorphism rounded-3xl border border-white/5 overflow-hidden shadow-2xl">
          {/* Header */}
          <div className="bg-onyx/80 px-6 py-4 border-b border-white/5 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-3 h-3 rounded-full bg-red-500/80" />
              <span className="w-3 h-3 rounded-full bg-yellow-500/80" />
              <span className="w-3 h-3 rounded-full bg-green-500/80" />
            </div>
            <span className="font-mono text-xs text-sterling-dark tracking-widest">
              ~/atmosphere-core/install.sh
            </span>
            <div className="w-4 h-4 opacity-0" />
          </div>
          {/* Body */}
          <div className="p-6 sm:p-8 font-mono text-xs sm:text-sm text-sterling leading-relaxed bg-onyx-dark/50 overflow-x-auto whitespace-nowrap">
            <div className="flex gap-2">
              <span className="text-sterling-dark">1</span>
              <span><span className="text-cyan">#!/usr/bin/env bash</span></span>
            </div>
            <div className="flex gap-2">
              <span className="text-sterling-dark">2</span>
              <span><span className="text-sterling-dark"># Efficient Labs Sovereign Bootstrap</span></span>
            </div>
            <div className="flex gap-2">
              <span className="text-sterling-dark">3</span>
              <span>curl -sSL https://install.efficientlabs.ai | sh</span>
            </div>
            <div className="flex gap-2">
              <span className="text-sterling-dark">4</span>
              <span><span className="text-sterling-dark"># Initializing post-quantum hybrid keys...</span></span>
            </div>
            <div className="flex gap-2">
              <span className="text-sterling-dark">5</span>
              <span>atmos-keygen --pqc=ML-KEM-768 --output=.stratos-profile</span>
            </div>
            <div className="flex gap-2">
              <span className="text-sterling-dark">6</span>
              <span><span className="text-green-400">✓ Keys verified (ML-KEM-768 / ML-DSA-65)</span></span>
            </div>
            <div className="flex gap-2">
              <span className="text-sterling-dark">7</span>
              <span><span className="text-sterling-dark"># Starting local-first shim daemon...</span></span>
            </div>
            <div className="flex gap-2">
              <span className="text-sterling-dark">8</span>
              <span>pm2 start atmos-secure-bridge --port 4099</span>
            </div>
            <div className="flex gap-2">
              <span className="text-sterling-dark">9</span>
              <span><span className="text-cyan">🚀 Stratos Sovereign active! Local intercept: http://127.0.0.1:4099</span></span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
