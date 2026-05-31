import cron from 'node-cron';
import { GsiCompiler } from './gsi-compiler.js';
import { ReasoningBank } from './reasoning-bank.js';

/**
 * GsiScheduler manages cron-based automated scheduling tasks, such as triggering compilation
 * routines over raw behavioral data traces during off-peak hours (e.g., 2:00 AM).
 */
export class GsiScheduler {
  /**
   * @param {Object} options
   * @param {string} [options.cronExpression="0 2 * * *"] - A node-cron format schedule string (defaults to 2:00 AM every night).
   * @param {ReasoningBank} options.reasoningBank - Initialized database workspace to fetch execution pathways.
   * @param {GsiCompiler} options.gsiCompiler - Compiler instance to compile pathways.
   */
  constructor(options = {}) {
    if (!options.reasoningBank) {
      throw new Error('[GsiScheduler] Error: "reasoningBank" is a required initialization parameter.');
    }
    if (!options.gsiCompiler) {
      throw new Error('[GsiScheduler] Error: "gsiCompiler" is a required initialization parameter.');
    }

    this.cronExpression = options.cronExpression || '0 2 * * *';
    this.reasoningBank = options.reasoningBank;
    this.gsiCompiler = options.gsiCompiler;
    this.privateKeyBundle = options.privateKeyBundle || null;
    this.task = null;
    this.isRunning = false;
  }

  /**
   * Activates the scheduled compilation process cron job.
   */
  start() {
    if (this.task) {
      console.warn('[GsiScheduler] Scheduler is already active.');
      return;
    }

    console.log(`[GsiScheduler] Initializing automated compilation schedule with expression: "${this.cronExpression}"`);
    
    this.task = cron.schedule(this.cronExpression, async () => {
      if (this.isRunning) {
        console.log('[GsiScheduler] Compile action triggered, but previous routine is still running. Skipping cycle.');
        return;
      }

      this.isRunning = true;
      console.log('[GsiScheduler] Cron triggered! Executing automated GSI optimization/compilation suite...');

      try {
        await this.executeCompilationCycle();
      } catch (err) {
        console.error('[GsiScheduler] Error during automated GSI compiler cron run:', err);
      } finally {
        this.isRunning = false;
      }
    });
  }

  /**
   * Executes a single optimization/compilation cycle manually.
   * Pulls traces and pathways from the reasoning database and signs new Wasm packages.
   * @returns {Promise<Array<Object>>} List of newly compiled packages
   */
  async executeCompilationCycle() {
    if (!this.privateKeyBundle) {
      console.warn('[GsiScheduler] No privateKeyBundle configured — cannot sign compiled skills. Skipping cycle.');
      return { compiled: [], skipped: [], failed: [] };
    }

    // Delegate to the real engine: harvest cognitive_skills -> distill/classify ->
    // content-hash dedupe -> compile to full-wasm-signed modules -> write + registry.
    const result = await this.gsiCompiler.compileFromDatabase(this.privateKeyBundle);
    console.log(`[GsiScheduler] Compilation cycle complete: ${result.compiled.length} compiled, ${result.skipped.length} unchanged, ${result.failed.length} failed.`);
    return result;
  }

  /**
   * Suspends and stops the active scheduled cron routine.
   */
  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
      console.log('[GsiScheduler] Successfully stopped scheduled compilation tasks.');
    }
  }
}
