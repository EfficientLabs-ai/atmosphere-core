"use client";

import { motion } from "framer-motion";
import { Shield, Zap, Server, Cpu, Globe, RefreshCcw, Network } from "lucide-react";

export default function AtmosphereMesh() {
  return (
    <div className="relative w-full overflow-hidden bg-background">
      {/* Background gradients and grid */}
      <div className="absolute inset-0 bg-cyber-grid opacity-25 z-0" />
      <div className="absolute top-1/4 left-1/4 w-[600px] h-[600px] bg-cyan/5 rounded-full filter blur-[150px] pointer-events-none z-0" />

      {/* Header */}
      <section className="relative z-10 max-w-7xl mx-auto px-6 pt-12 pb-12 text-center">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="font-mono text-xs text-cyan tracking-widest uppercase mb-4"
        >
          Sovereign Infrastructure
        </motion.div>
        
        <motion.h1
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="text-4xl sm:text-6xl font-sans font-black text-white uppercase tracking-tight"
        >
          Atmosphere Mesh Network
        </motion.h1>
        
        <p className="max-w-3xl mx-auto mt-6 text-zinc-400 font-sans text-base sm:text-lg leading-relaxed">
          The global decentralized physical infrastructure network (DePIN). Distribute sovereign compute clusters, participate in the local-first x402 resource billing channels, and earn tokens on Solana.
        </p>
      </section>

      {/* Node Monitor Interface */}
      <section className="relative z-10 max-w-5xl mx-auto px-6 py-8">
        <div className="glassmorphism rounded-3xl overflow-hidden shadow-2xl border border-white/5">
          {/* Header */}
          <div className="bg-onyx px-6 py-4 border-b border-white/5 flex items-center justify-between font-mono text-xs text-sterling">
            <div className="flex items-center gap-2">
              <Globe className="w-3.5 h-3.5 text-cyan animate-spin" style={{ animationDuration: "12s" }} />
              <span className="font-bold text-white uppercase tracking-wider">Mesh Node Activity Monitor</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-cyan text-glow-cyan">4,892 Nodes Active</span>
              <span className="w-2 h-2 rounded-full bg-cyan animate-pulse-cyan shadow-glow-cyan" />
            </div>
          </div>
          {/* Body */}
          <div className="grid grid-cols-1 md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-white/5 font-mono text-xs">
            {/* Column 1: DHT Logs */}
            <div className="p-6">
              <div className="text-sterling-light uppercase font-bold mb-3 flex items-center gap-1.5">
                <Network className="w-3.5 h-3.5 text-cyan" />
                <span>P2P DHT swarms</span>
              </div>
              <div className="space-y-2 text-zinc-500">
                <div>[DHT] Discovered 12 peers on topic "atmos-pqc"...</div>
                <div>[DHT] Dynamic routing table loaded: 14 hops.</div>
                <div className="text-cyan">[DHT] Sparse Hypercore replication sync complete.</div>
              </div>
            </div>

            {/* Column 2: Ledger rollups */}
            <div className="p-6">
              <div className="text-sterling-light uppercase font-bold mb-3 flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-cyan" />
                <span>x402 ledgers</span>
              </div>
              <div className="space-y-2 text-zinc-500">
                <div>[State Channel] Loaded treasury coordinates.</div>
                <div>[State Channel] Accumulated fee: 0.003 SOL.</div>
                <div className="text-green-400">[Auto-Rollup] Rollup generated. Settled: 0.006 SOL.</div>
              </div>
            </div>

            {/* Column 3: System telemetry */}
            <div className="p-6">
              <div className="text-sterling-light uppercase font-bold mb-3 flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-cyan" />
                <span>ZK Telemetry</span>
              </div>
              <div className="space-y-2 text-zinc-500">
                <div>[Telemetry] Scraped V8 heap metrics.</div>
                <div>[Anonymizer] Laplacian noise injected (ε = 0.55).</div>
                <div className="text-cyan">[Secure Exporter] Corestore logs appended safely.</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Ghost Node Fleet vs. Enterprise Maximus Nodes */}
      <section className="relative z-10 max-w-7xl mx-auto px-6 py-16">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          
          {/* Card 1: Ghost Node Fleet */}
          <div className="glassmorphism-cyan rounded-3xl p-8 border-glow-cyan relative overflow-hidden group">
            <div className="absolute -right-8 -top-8 w-28 h-28 bg-cyan/5 rounded-full filter blur-xl group-hover:bg-cyan/10 transition-colors" />
            <div className="bg-cyan/10 border border-cyan/20 w-12 h-12 rounded-2xl flex items-center justify-center mb-6">
              <Cpu className="w-6 h-6 text-cyan" />
            </div>
            <h3 className="font-sans font-black text-2xl text-white uppercase tracking-wider">
              Ghost Node Fleet
            </h3>
            <p className="text-sterling font-sans text-sm mt-4 leading-relaxed text-zinc-400">
              Proof-of-Compute node packages designed for idle household systems, consumer GPUs, and esports gaming lounges. Install on Windows or Linux with a simple PowerShell/Shell command, exchange idle computing cycles for compute credits, and support the decentralized network mesh.
            </p>
            <div className="bg-onyx-dark/80 p-4 rounded-2xl font-mono text-[10px] sm:text-xs text-sterling overflow-x-auto mt-6">
              <span className="text-sterling-dark"># Run local installer</span> <br />
              powershell -c "irm https://install.efficientlabs.ai/ghost | iex"
            </div>
          </div>

          {/* Card 2: Enterprise Maximus Nodes */}
          <div className="glassmorphism rounded-3xl p-8 border border-white/5 relative overflow-hidden group">
            <div className="absolute -right-8 -top-8 w-28 h-28 bg-cyan/5 rounded-full filter blur-xl group-hover:bg-cyan/10 transition-colors" />
            <div className="bg-cyan/10 border border-cyan/20 w-12 h-12 rounded-2xl flex items-center justify-center mb-6">
              <Server className="w-6 h-6 text-cyan" />
            </div>
            <h3 className="font-sans font-black text-2xl text-white uppercase tracking-wider">
              Maximus Nodes
            </h3>
            <p className="text-sterling font-sans text-sm mt-4 leading-relaxed text-zinc-400">
              High-availability server infrastructure tailored for institutional data centers, specialized AI cloud compute facilities, and enterprise deployment. Includes premium telemetry exporters, automated Docker-Compose grids, native post-quantum ML-KEM exchange mechanisms, and SOC 2 / HIPAA compliance profiles.
            </p>
            <div className="bg-onyx-dark/80 p-4 rounded-2xl font-mono text-[10px] sm:text-xs text-sterling overflow-x-auto mt-6">
              <span className="text-sterling-dark"># Pull Docker cluster setup</span> <br />
              docker compose -f packages/maximus-telemetry/docker-compose.yml up -d
            </div>
          </div>

        </div>
      </section>
    </div>
  );
}
