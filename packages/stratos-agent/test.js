import { BrowserHarness, ReasoningBank, GsiCompiler, GsiScheduler } from './index.js';
import path from 'path';
import fs from 'fs/promises';

async function testAgentSuite() {
  console.log('--- Starting StratosAgent Verification Suite ---');

  const testDb = path.join(process.cwd(), '.stratos-test.db');
  const testVectorDir = path.join(process.cwd(), '.stratos-test-vector-store');
  const testSession = path.join(process.cwd(), '.stratos-test-session.json');
  const testProfile = path.join(process.cwd(), '.stratos-test-profile');

  // Clean up any lingering files
  await fs.rm(testDb, { force: true }).catch(() => {});
  await fs.rm(testDb + '.json', { force: true }).catch(() => {});
  await fs.rm(testVectorDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(testSession, { force: true }).catch(() => {});
  await fs.rm(testProfile, { recursive: true, force: true }).catch(() => {});

  let reasoningBank;
  let browserHarness;
  let gsiCompiler;
  let gsiScheduler;

  try {
    // 1. Validate ReasoningBank (SQLite and vector search simulation)
    console.log('\n[TEST 1] Initializing ReasoningBank...');
    reasoningBank = new ReasoningBank({
      dbPath: testDb,
      vectorStorePath: testVectorDir
    });
    await reasoningBank.initialize();

    console.log('[TEST 1] Recording pathway...');
    const pathwayId = 'pathway-google-search';
    const goal = 'Perform search query on Google';
    const steps = [
      { action: 'navigate', url: 'https://google.com', timestamp: new Date().toISOString() },
      { action: 'type', selector: 'textarea[name="q"]', text: 'Stratos Sovereign P2P Layer', timestamp: new Date().toISOString() },
      { action: 'press', selector: 'textarea[name="q"]', key: 'Enter', timestamp: new Date().toISOString() }
    ];
    await reasoningBank.recordPathway(pathwayId, goal, steps, 1.0);

    const retrievedPathway = await reasoningBank.getPathway(pathwayId);
    if (!retrievedPathway || retrievedPathway.goal !== goal || retrievedPathway.steps.length !== 3) {
      throw new Error('ReasoningBank failed to correctly record/retrieve success pathway.');
    }
    console.log('[TEST 1] Pathway verified successfully.');

    console.log('[TEST 1] Testing simulated vector store...');
    const vectorTable = 'knowledge-base';
    await reasoningBank.vectorInsert(vectorTable, [
      { id: 'doc-1', vector: [0.1, 0.9, -0.2], text: 'Sovereign computing principles', metadata: { source: 'whitepaper' } },
      { id: 'doc-2', vector: [0.8, -0.1, 0.4], text: 'P2P decentralized DHT protocols', metadata: { source: 'spec' } }
    ]);

    const vectorResults = await reasoningBank.vectorSearch(vectorTable, [0.75, -0.05, 0.35], 1);
    if (vectorResults.length === 0 || vectorResults[0].id !== 'doc-2') {
      throw new Error(`Vector search failed. Expected doc-2, got: ${JSON.stringify(vectorResults)}`);
    }
    console.log('[TEST 1] Vector store simulation verified successfully.');

    // 2. Validate GsiCompiler (Wasm compilation & signing)
    console.log('\n[TEST 2] Initializing GsiCompiler...');
    gsiCompiler = new GsiCompiler();
    
    console.log('[TEST 2] Compiling active traces...');
    const traceEvents = [
      ...steps,
      // Add a duplicate trace event to test optimization logic
      { action: 'navigate', url: 'https://google.com', timestamp: new Date().toISOString() }
    ];

    const { wasmBinary, signature, signedBlock } = await gsiCompiler.compile(traceEvents);
    if (!wasmBinary || !signature || !signedBlock) {
      throw new Error('GsiCompiler failed to build signed Wasm package.');
    }
    
    // Verify magic headers of WASM
    const magic = wasmBinary.subarray(0, 4);
    if (magic.toString('hex') !== '0061736d') {
      throw new Error(`Wasm magic header invalid: ${magic.toString('hex')}`);
    }
    console.log('[TEST 2] GsiCompiler WASM binary magic header verified.');

    // 3. Validate GsiScheduler (Cron integration & compilation suite execution)
    console.log('\n[TEST 3] Initializing GsiScheduler...');
    gsiScheduler = new GsiScheduler({
      cronExpression: '*/5 * * * * *', // Trigger every 5 seconds (not started, just checking validation)
      reasoningBank,
      gsiCompiler
    });

    console.log('[TEST 3] Testing manual compilation cycle execution via scheduler...');
    const compiledJobs = await gsiScheduler.executeCompilationCycle();
    if (compiledJobs.length === 0) {
      throw new Error('GsiScheduler compilation cycle did not generate compiled jobs.');
    }
    console.log(`[TEST 3] Scheduler successfully auto-compiled ${compiledJobs.length} active jobs.`);

    // 4. Validate BrowserHarness Instantiation (Playwright wrapper)
    console.log('\n[TEST 4] Initializing BrowserHarness instantiation...');
    browserHarness = new BrowserHarness({
      userDataDir: testProfile,
      sessionFilePath: testSession,
      headless: true
    });
    if (!browserHarness.args.includes('--disable-blink-features=AutomationControlled')) {
      throw new Error('BrowserHarness arguments missing anti-bot flags.');
    }
    console.log('[TEST 4] BrowserHarness configured correctly with anti-bot options.');

    console.log('\n--- ALL STRATOS-AGENT TESTS COMPLETED SUCCESSFULLY ---');

  } catch (err) {
    console.error('\n!!! StratosAgent Test Suite Failed !!!');
    console.error(err);
  } finally {
    if (reasoningBank) reasoningBank.close();
    if (gsiScheduler) gsiScheduler.stop();

    // Clean up files generated during testing
    await fs.rm(testDb, { force: true }).catch(() => {});
    await fs.rm(testDb + '.json', { force: true }).catch(() => {});
    await fs.rm(testVectorDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(testSession, { force: true }).catch(() => {});
    await fs.rm(testProfile, { recursive: true, force: true }).catch(() => {});
  }
}

testAgentSuite();
