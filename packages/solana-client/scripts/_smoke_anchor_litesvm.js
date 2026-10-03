const { LiteSVM } = require('litesvm');
const { PublicKey } = require('@solana/web3.js');
const fs = require('fs');

const so = '/tmp/arena_escrow.so';
fs.copyFileSync('../../target/deploy/arena_escrow.so', so);
console.log('size', fs.statSync(so).size);
console.log('creating');
let s = new LiteSVM();
if (s.withTransactionHistory) s = s.withTransactionHistory(0n);
console.log('loading');
s.addProgramFromFile(
  new PublicKey('26fttiarz4KzXfcyB5W24WfXpMw8UqZHqKoTF9wWm2Ke'),
  so,
);
console.log('ok');

// Also try pinocchio for comparison
const soP = '/tmp/arena_escrow_pinocchio.so';
fs.copyFileSync('../../target/deploy/arena_escrow_pinocchio.so', soP);
console.log('pinocchio size', fs.statSync(soP).size);
let s2 = new LiteSVM();
if (s2.withTransactionHistory) s2 = s2.withTransactionHistory(0n);
s2.addProgramFromFile(
  new PublicKey('26fttiarz4KzXfcyB5W24WfXpMw8UqZHqKoTF9wWm2Ke'),
  soP,
);
console.log('pinocchio ok');
