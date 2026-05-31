import crypto from 'crypto';
import b4a from 'b4a';

/**
 * X402InvoiceEngine — standalone x402 payment-invoice signer for P2P micro-transactions.
 *
 * This is the LIGHTWEIGHT invoice layer: it generates and verifies signed x402 invoice
 * envelopes (USDC micro-payments) using a node's keyring. It is intentionally separate from
 * the full state-channel SETTLEMENT engine in `src/billing/payment-engine.js` (which handles
 * state channels, PoW micro-invoices, lamport accounting, and batch rollups). Both used to be
 * named `PaymentEngine`, which collided in the package barrel; this is the invoice half.
 */
export class X402InvoiceEngine {
  /**
   * @param {KeyringManager} keyring - Cryptographic signature generator
   */
  constructor(keyring) {
    this.keyring = keyring;
    this.ledger = new Map(); // Simple mock ledger storing local transaction hashes
  }

  /**
   * Generates a signed payment envelope (x402 standard) to delegate tasks.
   * @param {string} recipientPublicKey - Hex public key of target execution node
   * @param {number} amountUSD - Dollar amount (e.g. 0.001 USDC micro-payment)
   * @param {string} taskId - Cryptographic trace identifier
   */
  generateInvoice(recipientPublicKey, amountUSD, taskId) {
    const invoice = {
      protocol: 'x402',
      sender: b4a.toString(this.keyring.keypair.publicKey, 'hex'),
      recipient: recipientPublicKey,
      amount: amountUSD,
      currency: 'USDC',
      taskId,
      nonce: crypto.randomBytes(16).toString('hex'),
      timestamp: Date.now()
    };

    const serialized = JSON.stringify(invoice);
    const signature = b4a.toString(this.keyring.sign(serialized), 'hex');

    return {
      invoice,
      signature
    };
  }

  /**
   * Validates an incoming micropayment invoice envelope before task execution blocks boot.
   * @param {Object} paymentEnvelope - Struct containing invoice and sender signature
   */
  verifyInvoice(paymentEnvelope) {
    const { invoice, signature } = paymentEnvelope;

    if (invoice.protocol !== 'x402') {
      return false;
    }

    const serialized = JSON.stringify(invoice);
    const isValid = this.keyring.verify(
      serialized,
      b4a.from(signature, 'hex'),
      b4a.from(invoice.sender, 'hex')
    );

    if (isValid) {
      const txHash = crypto.createHash('sha256').update(serialized + signature).digest('hex');
      this.ledger.set(txHash, invoice);
      return txHash;
    }

    return null;
  }
}
