import { createRequire } from 'module';
const require = createRequire(import.meta.url);

console.log('🐒 Injecting safe compat-layer monkey patches...');

// Patch 1: Safe Hypercore.prototype patching using configurable descriptor getters
try {
  const Hypercore = require('hypercore');
  if (Hypercore && Hypercore.prototype) {
    const hasReplicator = Object.getOwnPropertyDescriptor(Hypercore.prototype, 'replicator');
    if (!hasReplicator) {
      Object.defineProperty(Hypercore.prototype, 'replicator', {
        get() {
          return this._replicator_dummy || {
            setInflightRange: () => {},
            clearRequests: () => {}
          };
        },
        set(val) {
          this._replicator_dummy = val;
        },
        configurable: true,
        enumerable: true
      });
      console.log('🐒 Patched Hypercore.prototype with safe dummy replicator getter/setter');
    }
  }
} catch (err) {
  console.log('🐒 Failed to patch raw Hypercore:', err.message);
}

// Patch 2: HypercoreBatch prototype patching (for checkout and batch sessions passed to Hyperbee)
try {
  const HypercoreBatch = require('hypercore/lib/batch.js');
  if (HypercoreBatch && HypercoreBatch.prototype) {
    if (!HypercoreBatch.prototype.hasOwnProperty('replicator')) {
      Object.defineProperty(HypercoreBatch.prototype, 'replicator', {
        get() {
          return {
            setInflightRange: () => {},
            clearRequests: () => {}
          };
        },
        configurable: true,
        enumerable: true
      });
      console.log('🐒 Patched HypercoreBatch.prototype with safe dummy replicator getter');
    }
  }
} catch (err) {
  console.log('🐒 Failed to patch HypercoreBatch:', err.message);
}

// Patch 3: Autobase AutocoreSession instances
try {
  const Autocore = require('autobase/lib/core.js');
  if (Autocore && Autocore.prototype) {
    const originalCreateSession = Autocore.prototype._createSession;
    Autocore.prototype._createSession = function (...args) {
      const session = originalCreateSession.apply(this, args);
      if (session) {
        Object.defineProperty(session, 'replicator', {
          value: {
            setInflightRange: () => {},
            clearRequests: () => {}
          },
          writable: true,
          configurable: true
        });
        
        const proto = Object.getPrototypeOf(session);
        if (proto && !proto.hasOwnProperty('replicator')) {
          Object.defineProperty(proto, 'replicator', {
            get() {
              return {
                setInflightRange: () => {},
                clearRequests: () => {}
              };
            },
            configurable: true
          });
        }
      }
      return session;
    };
    console.log('🐒 Patched Autobase AutocoreSession class successfully!');
  }
} catch (err) {
  console.log('🐒 Failed to patch Autobase core:', err.message);
}

export { KeyringManager } from './keyring.js';
export { P2PNetwork } from './p2p-network.js';
export { StorageManager } from './storage.js';
// PaymentEngine = the real state-channel settlement engine (PoW micro-invoices + rollups),
// the one all three payment test suites exercise. X402InvoiceEngine = the lightweight
// standalone invoice signer. Previously both were named `PaymentEngine`, so the barrel
// silently exported the lighter one while the system relied on the settlement engine.
export { PaymentEngine } from './src/billing/payment-engine.js';
export { X402InvoiceEngine } from './x402-invoice.js';
