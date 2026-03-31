try { require('dotenv').config(); } catch (_) {}
const {
  Connection, PublicKey, Keypair, Transaction, SystemProgram,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');

const LOG = path.join(__dirname, '../evidence/mxe_runs.jsonl');
if (!fs.existsSync(path.dirname(LOG))) fs.mkdirSync(path.dirname(LOG), { recursive: true });

function log(entry) {
  const line = JSON.stringify({ ...entry, ts: new Date().toISOString() });
  fs.appendFileSync(LOG, line + '\n');
  console.log(line);
}

async function run() {
  const rpc = process.env.RPC_URL || 'https://api.devnet.solana.com';
  const conn = new Connection(rpc, 'confirmed');
  const kpPath = (process.env.WALLET_KEYPAIR_PATH || '~/.config/solana/devnet.json')
    .replace('~', process.env.HOME);
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpPath))));

  log({ event: 'start', wallet: kp.publicKey.toString() });

  const bal = await conn.getBalance(kp.publicKey) / LAMPORTS_PER_SOL;
  log({ event: 'balance', sol: bal });
  if (bal < 0.001) {
    log({ event: 'low_balance' });
    return;
  }

  const sig = await sendAndConfirmTransaction(conn,
    new Transaction().add(SystemProgram.transfer({
      fromPubkey: kp.publicKey,
      toPubkey: kp.publicKey,
      lamports: 1000,
    })), [kp]);
  log({ event: 'tx_sent', sig, cluster: 'devnet' });

  const pid = new PublicKey(process.env.ARCIUM_PROGRAM_ID || 'Eyn3GkHCZkPFTr3yhbUwxgpmfwSBf6mfMvj76TeUSG2h');
  const info = await conn.getAccountInfo(pid);
  log({ event: 'arcium_ping', active: info !== null, program: pid.toString() });
}

run().catch((e) => log({ event: 'error', msg: e.message }));
