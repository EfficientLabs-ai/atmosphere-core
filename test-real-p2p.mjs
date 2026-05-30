// REAL P2P verification (single-machine, honest about limits).
//
// (1) TRANSPORT PROOF — direct hyperdht connect-by-key over a local DHT testnet.
//     Proves the genuine networking stack works: real DHT, real Noise handshake,
//     real bidirectional encrypted data. This passes anywhere.
//
// (2) PRODUCT-PATH CHECK — instantiate the real P2PNetwork class (real Hyperswarm) and
//     confirm it starts + joins a topic. NOTE: full topic-based *mutual discovery* between
//     two nodes needs at least one reachable peer. This VPS reports `firewalled: true`
//     (hardened, zero public UDP ports), so two same-host firewalled nodes cannot
//     holepunch-discover each other here. The definitive mesh test is cross-machine
//     (two different IPs) — see the runbook printed at the end.
import createTestnet from 'hyperdht/testnet.js';
import DHT from 'hyperdht';
import { KeyringManager } from './packages/atmos-core/keyring.js';
import { P2PNetwork } from './packages/atmos-core/p2p-network.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const testnet = await createTestnet(3);

// (1) Direct transport proof
const a = new DHT({ bootstrap: testnet.bootstrap });
const b = new DHT({ bootstrap: testnet.bootstrap });
await a.ready(); await b.ready();
const keyPair = DHT.keyPair();
let serverRecv = false, clientRecv = false;
const server = a.createServer((socket) => {
  socket.on('data', () => { serverRecv = true; socket.write(Buffer.from('ack')); });
  socket.on('error', () => {});
});
await server.listen(keyPair);
const sock = b.connect(keyPair.publicKey);
sock.on('open', () => sock.write(Buffer.from('hello')));
sock.on('data', () => { clientRecv = true; });
sock.on('error', () => {});
for (let i = 0; i < 20 && !(serverRecv && clientRecv); i++) await sleep(1000);
const transportOk = serverRecv && clientRecv;
console.log(`(1) Transport: real DHT + Noise handshake + bidirectional data => ${transportOk ? '✅ PASS' : '❌ FAIL'}`);
await server.close(); await a.destroy(); await b.destroy();

// (2) Product P2PNetwork path
const k = new KeyringManager('consumer'); await k.init();
const net = new P2PNetwork(k, { isMaximus: true, bootstrap: testnet.bootstrap });
await net.start();
const discovery = net.joinTopic('atmos-product-path-check');
await net.swarm.flush();
const productOk = !!net.swarm && !!discovery;
console.log(`(2) P2PNetwork: real Hyperswarm starts + joins topic => ${productOk ? '✅ PASS' : '❌ FAIL'}`);
await net.stop();
await testnet.destroy();

console.log('\n— Cross-machine mesh (the definitive test) needs a 2nd device + the DHT UDP port reachable.');
process.exit(transportOk && productOk ? 0 : 1);
