try { require('dotenv').config(); } catch (_) {}
const {
  Connection, PublicKey, Keypair, Transaction, SystemProgram,
  LAMPORTS_PER_SOL,
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

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendAndConfirmWithPolling(conn, tx, signer) {
  const latest = await conn.getLatestBlockhash('confirmed');
  tx.feePayer = signer.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(signer);

  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    preflightCommitment: 'confirmed',
    maxRetries: 3,
  });

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const statusResp = await conn.getSignatureStatuses([sig], {
      searchTransactionHistory: true,
    });
    const status = statusResp.value[0];
    if (status && status.err) {
      throw new Error(`Transaction ${sig} failed: ${JSON.stringify(status.err)}`);
    }
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) {
      return sig;
    }
    const currentHeight = await conn.getBlockHeight('confirmed');
    if (currentHeight > latest.lastValidBlockHeight) {
      throw new Error(`Signature ${sig} has expired: block height exceeded.`);
    }
    await sleep(1500);
  }

  throw new Error(`Timed out waiting for confirmation for ${sig}`);
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

  const sig = await sendAndConfirmWithPolling(conn,
    new Transaction().add(SystemProgram.transfer({
      fromPubkey: kp.publicKey,
      toPubkey: kp.publicKey,
      lamports: 1000,
    })), kp);
  log({ event: 'tx_sent', sig, cluster: 'devnet' });

  const pid = new PublicKey(process.env.ARCIUM_PROGRAM_ID || 'Eyn3GkHCZkPFTr3yhbUwxgpmfwSBf6mfMvj76TeUSG2h');
  const info = await conn.getAccountInfo(pid);
  log({ event: 'arcium_ping', active: info !== null, program: pid.toString() });
}

run().catch((e) => log({ event: 'error', msg: e.message }));
