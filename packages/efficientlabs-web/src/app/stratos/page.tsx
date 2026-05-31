"use client";

import { motion } from "framer-motion";
import { Terminal, Shield, EyeOff, Code, HardDrive, RefreshCcw, Compass } from "lucide-react";

export default function StratosAgent() {
  return (
    <div className="relative w-full overflow-hidden bg-background">
      {/* Grid background */}
      <div className="absolute inset-0 bg-cyber-grid opacity-20 z-0" />
      <div className="absolute top-1/3 right-1/4 w-[500px] h-[500px] bg-cyan/5 rounded-full filter blur-[120px] pointer-events-none z-0" />

      {/* Main content header */}
      <section className="relative z-10 max-w-7xl mx-auto px-6 pt-12 pb-16 text-center">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="font-mono text-xs text-cyan tracking-widest uppercase mb-4"
        >
          Product Integration Layer
        </motion.div>
        
        <motion.h1
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="text-4xl sm:text-6xl font-sans font-black text-white uppercase tracking-tight"
        >
          Stratos Agent Core
        </motion.h1>
        
        <p className="max-w-3xl mx-auto mt-6 text-zinc-400 font-sans text-base sm:text-lg leading-relaxed">
          The sovereign drop-in replacement for OpenClaw. A private agent executing zero-trust workflows, local vector lookups, and post-quantum hybrid signed tasks.
        </p>
      </section>

      {/* Dynamic Terminal Box */}
      <section className="relative z-10 max-w-5xl mx-auto px-6 py-8">
        <div className="glassmorphism-cyan rounded-3xl overflow-hidden shadow-2xl border-glow-cyan">
          {/* Header */}
          <div className="bg-onyx/90 px-6 py-4 border-b border-cyan/20 flex items-center justify-between font-mono text-xs text-cyan-light">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-cyan animate-pulse-cyan shadow-glow-cyan" />
              <span>stratos-execution-sandbox (WASI)</span>
            </div>
            <span>secure-bridge:4099</span>
          </div>
          {/* Body */}
          <div className="p-6 sm:p-8 font-mono text-xs sm:text-sm text-sterling-light leading-relaxed bg-onyx-dark/70 overflow-x-auto whitespace-nowrap">
            <div><span className="text-sterling-dark">[System]</span> Initializing capability-governed WASI Sandbox...</div>
            <div className="text-cyan"><span className="text-sterling-dark">[System]</span> Restricting ambient access. Mounting isolated pre-opens only.</div>
            <div><span className="text-sterling-dark">[System]</span> Guest dynamic Hot-Loader loaded successfully.</div>
            <div><span className="text-zinc-500">Executing guest dynamic compiler stubs:</span></div>
            <div className="text-green-400">  ▶ Verified ML-DSA-65 signed binary signatures.</div>
            <div className="text-green-400">  ▶ Zeroed out 128MB linear buffer memory segment successfully.</div>
            <div><span className="text-sterling-dark">[Execution Results]</span> Task completed. Returns: <span className="text-cyan">0xdeadbeef</span></div>
          </div>
        </div>
      </section>

      {/* Feature Grid: Sandboxing, Hygiene, Evolution */}
      <section className="relative z-10 max-w-7xl mx-auto px-6 py-16">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          
          {/* WASI Sandboxing */}
          <div className="glassmorphism rounded-2xl p-6 border border-white/5">
            <div className="bg-cyan/5 w-10 h-10 rounded-xl flex items-center justify-center mb-4">
              <Shield className="w-5 h-5 text-cyan" />
            </div>
            <h4 className="font-mono text-sm font-bold text-white uppercase">WASI Sandboxing</h4>
            <p className="text-zinc-400 text-xs mt-3 leading-relaxed">
              Guest modules are locked inside pre-configured capability directories. Ambient host command traversing (..) or socket generation is strictly filtered.
            </p>
          </div>

          {/* Memory Hygiene */}
          <div className="glassmorphism rounded-2xl p-6 border border-white/5">
            <div className="bg-cyan/5 w-10 h-10 rounded-xl flex items-center justify-center mb-4">
              <EyeOff className="w-5 h-5 text-cyan" />
            </div>
            <h4 className="font-mono text-sm font-bold text-white uppercase">V8 Memory Hygiene</h4>
            <p className="text-zinc-400 text-xs mt-3 leading-relaxed">
              Decryption tasks ingest keys as `Uint8Array` buffers and immediately execute a `.fill(0)` sweep to eliminate lingering RAM traces in garbage-collected piles.
            </p>
          </div>

          {/* Self-Evolution */}
          <div className="glassmorphism rounded-2xl p-6 border border-white/5">
            <div className="bg-cyan/5 w-10 h-10 rounded-xl flex items-center justify-center mb-4">
              <RefreshCcw className="w-5 h-5 text-cyan" />
            </div>
            <h4 className="font-mono text-sm font-bold text-white uppercase">Night Shift Evolution</h4>
            <p className="text-zinc-400 text-xs mt-3 leading-relaxed">
              Autonomous cron-schedules evaluate behavioral execution traces overnight, translating successful pathways into optimized WASM bytecodes signed under ML-DSA-65.
            </p>
          </div>

          {/* Omni-Channel Isolation */}
          <div className="glassmorphism rounded-2xl p-6 border border-white/5">
            <div className="bg-cyan/5 w-10 h-10 rounded-xl flex items-center justify-center mb-4">
              <Compass className="w-5 h-5 text-cyan" />
            </div>
            <h4 className="font-mono text-sm font-bold text-white uppercase">Metadata Isolation</h4>
            <p className="text-zinc-400 text-xs mt-3 leading-relaxed">
              Incoming Discord/Slack webhooks are tagged via `isolatedContextTag` metadata, segregating concurrent vector lookups and preventing cross-client trace bleeding.
            </p>
          </div>

        </div>
      </section>

      {/* Connection Protocol Guides: Cursor & Claude Desktop */}
      <section className="relative z-10 max-w-4xl mx-auto px-6 py-12 border-t border-white/5">
        <h3 className="font-sans font-black text-2xl text-white uppercase mb-8 text-center">
          1-Click MCP Connect Integration
        </h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          
          {/* Claude Desktop Config */}
          <div className="bg-onyx rounded-2xl p-6 border border-white/5">
            <div className="flex items-center gap-2 mb-4">
              <Code className="w-4 h-4 text-cyan" />
              <span className="font-mono text-xs text-white uppercase font-bold">Claude Desktop</span>
            </div>
            <p className="text-zinc-400 text-xs mb-4">
              Mount Stratos Agent directly as an MCP server in `claude_desktop_config.json`:
            </p>
            <div className="bg-onyx-dark/80 p-4 rounded-xl font-mono text-[10px] sm:text-xs text-sterling overflow-x-auto">
<pre>{`{
  "mcpServers": {
    "stratos": {
      "command": "node",
      "args": ["~/atmosphere-core/packages/api-shim/index.js"]
    }
  }
}`}</pre>
            </div>
          </div>

          {/* Cursor Configuration */}
          <div className="bg-onyx rounded-2xl p-6 border border-white/5">
            <div className="flex items-center gap-2 mb-4">
              <Code className="w-4 h-4 text-cyan" />
              <span className="font-mono text-xs text-white uppercase font-bold">Cursor / VS Code</span>
            </div>
            <p className="text-zinc-400 text-xs mb-4">
              Route OpenAI/Anthropic SDKs cleanly through the interception shield proxy:
            </p>
            <div className="bg-onyx-dark/80 p-4 rounded-xl font-mono text-[10px] sm:text-xs text-sterling overflow-x-auto">
<pre>{`// Set your client base URL
const openai = new OpenAI({
  baseURL: "http://127.0.0.1:4099/v1",
  apiKey: "stratos-sovereign-vault"
});`}</pre>
            </div>
          </div>

        </div>
      </section>
    </div>
  );
}
