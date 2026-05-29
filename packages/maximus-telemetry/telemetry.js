import os from 'os';
import { KeyringManager, P2PNetwork } from 'atmos-core';

/**
 * Maximus Telemetry Client
 * Exposes core host resources (CPU, Memory, GPU virtualizations)
 * to the Atmos P2P network over secure, Noise-encrypted RPC streams.
 */
export class MaximusTelemetry {
  constructor(keyring, network) {
    this.keyring = keyring;
    this.network = network;
    this.intervalId = null;
  }

  /**
   * Capture system statistics.
   */
  captureMetrics() {
    const cpus = os.cpus();
    const load = os.loadavg();
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();

    // Emulate GPU telemetry for data center heavy-lifting nodes
    const gpuMetrics = {
      model: 'NVIDIA H100 Tensor Core 80GB (Virtual)',
      utilization: Math.floor(Math.random() * 30) + 10, // 10% - 40% load
      tempC: 62,
      memoryTotalMB: 81920,
      memoryUsedMB: Math.floor(Math.random() * 20000) + 15000
    };

    return {
      timestamp: Date.now(),
      nodeId: this.keyring.keypair.publicKey.toString('hex'),
      nodeType: 'maximus',
      cpu: {
        cores: cpus.length,
        model: cpus[0].model,
        load1m: load[0],
        load5m: load[1],
        load15m: load[2]
      },
      memory: {
        totalBytes: totalMemory,
        freeBytes: freeMemory,
        usedPercent: ((totalMemory - freeMemory) / totalMemory * 100).toFixed(2)
      },
      gpu: gpuMetrics,
      status: 'active'
    };
  }

  /**
   * Start reporting telemetry to the overlay mesh network.
   * @param {number} [intervalMs=5000] - Telemetry broadcast interval
   */
  start(intervalMs = 5000) {
    console.log('📈 Starting Maximus Hardware Telemetry Exporter...');
    
    this.intervalId = setInterval(() => {
      const metrics = this.captureMetrics();
      console.log(`[MAXIMUS-TELEMETRY] Exposing Load Metrics to mesh: CPU ${metrics.memory.usedPercent}% RAM used | GPU ${metrics.gpu.utilization}%`);
      
      this.network.broadcast({
        type: 'MAXIMUS_TELEMETRY',
        metrics,
        signature: this.keyring.sign(JSON.stringify(metrics)).toString('hex')
      });
    }, intervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

// Executable boots automatically if run directly
async function bootstrap() {
  const hsmKey = process.env.HSM_KEY || 'maximus-secure-hsm-hardware-key-enclave';
  console.log(`🔑 Initializing Keyring with HSM Enclave Key: ${hsmKey.substring(0, 12)}...`);
  
  const keyring = new KeyringManager('maximus');
  await keyring.init(hsmKey);
  
  const bootstrapNodes = process.env.DHT_BOOTSTRAP
    ? process.env.DHT_BOOTSTRAP.split(',').map(s => s.trim())
    : null;

  const networkOpts = { isMaximus: true };
  if (bootstrapNodes) {
    console.log(`🌐 Configuring private DHT Bootstrap Servers: ${JSON.stringify(bootstrapNodes)}`);
    networkOpts.bootstrap = bootstrapNodes;
  }
  
  const network = new P2PNetwork(keyring, networkOpts);
  await network.start();
  
  const topic = process.env.DHT_TOPIC || 'atmos-maximus-mesh-v1';
  console.log(`🎯 Joining DHT topic: ${topic}`);
  network.joinTopic(topic);

  const telemetry = new MaximusTelemetry(keyring, network);
  const interval = parseInt(process.env.TELEMETRY_INTERVAL_MS || '5000', 10);
  telemetry.start(interval);
}

if (process.argv[1] && (process.argv[1].endsWith('telemetry.js') || process.argv[1].includes('maximus-telemetry'))) {
  bootstrap().catch(console.error);
}
