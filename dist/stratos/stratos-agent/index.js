import { BrowserHarness } from './browser-harness.js';
import { ReasoningBank } from './reasoning-bank.js';
import { GsiCompiler } from './gsi-compiler.js';
import { GsiScheduler } from './gsi-scheduler.js';
import { ConfigParser } from './src/core/config.js';
import { UnifiedDispatcher } from './src/ingestion/unified-dispatcher.js';
import { P2pSkillSync } from './src/memory/p2p-skill-sync.js';
import { TraceAnalyzer } from './src/evolution/trace-analyzer.js';
import { NightShiftCompiler } from './src/evolution/night-shift-compiler.js';
import { SkillExecutor } from './src/evolution/skill-executor.js';
import { SkillInductionEngine } from './src/evolution/skill-induction.js';
import { SelfEvolutionEngine } from './src/evolution/self-evolution.js';

export {
  BrowserHarness,
  ReasoningBank,
  GsiCompiler,
  GsiScheduler,
  ConfigParser,
  UnifiedDispatcher,
  P2pSkillSync,
  TraceAnalyzer,
  NightShiftCompiler,
  SkillExecutor,
  SkillInductionEngine,
  SelfEvolutionEngine
};

export default {
  BrowserHarness,
  ReasoningBank,
  GsiCompiler,
  GsiScheduler,
  ConfigParser,
  UnifiedDispatcher,
  P2pSkillSync,
  TraceAnalyzer,
  NightShiftCompiler,
  SkillExecutor,
  SkillInductionEngine,
  SelfEvolutionEngine
};

// Folder-stage pipeline engine (ICM "folders over agents")
export { runPipeline, discoverStages, parseStage } from './src/pipeline/engine.js';
export { defaultModelRunner, defaultScriptRunner } from './src/pipeline/stage-runners.js';
