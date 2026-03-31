/**
 * zkkyc-solana demo
 * Privacy-preserving KYC compliance check via Arcium MXE.
 *
 * Usage:
 *   ANCHOR_WALLET=~/.config/solana/wallet2.json npx ts-node --transpile-only scripts/run_demo.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { Keypair, PublicKey } from "@solana/web3.js";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  RescueCipher,
  deserializeLE,
  getMXEPublicKey,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  x25519,
} from "@arcium-hq/client";

const PROGRAM_ID = new PublicKey("Eyn3GkHCZkPFTr3yhbUwxgpmfwSBf6mfMvj76TeUSG2h");
const SIGN_PDA_SEED = Buffer.from("ArciumSignerAccount");
const EVIDENCE_LOG = path.join(__dirname, "../evidence/mxe_runs.jsonl");

function log(event: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ event, ...data, ts: new Date().toISOString() });
  fs.mkdirSync(path.dirname(EVIDENCE_LOG), { recursive: true });
  fs.appendFileSync(EVIDENCE_LOG, line + "\n");
  console.log(line);
}

async function withRpcRetry<T>(fn: () => Promise<T>, retries = 8): Promise<T> {
  let delayMs = 500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      const message = error?.message || String(error);
      if (attempt >= retries || !message.includes("429")) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs *= 2;
    }
  }
}

async function confirmSignatureByPolling(
  connection: anchor.web3.Connection,
  signature: string,
  lastValidBlockHeight: number,
  commitment: anchor.web3.Commitment,
): Promise<void> {
  for (;;) {
    const [{ value: statuses }, currentBlockHeight] = await Promise.all([
      withRpcRetry(() => connection.getSignatureStatuses([signature])),
      withRpcRetry(() => connection.getBlockHeight(commitment)),
    ]);

    const status = statuses[0];
    if (status?.err) {
      throw new Error(`Signature ${signature} failed: ${JSON.stringify(status.err)}`);
    }
    if (
      status &&
      (status.confirmationStatus === "confirmed" ||
        status.confirmationStatus === "finalized")
    ) {
      return;
    }
    if (currentBlockHeight > lastValidBlockHeight) {
      throw new Error(`Signature ${signature} has expired: block height exceeded.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function sendAndConfirmCompat(
  provider: anchor.AnchorProvider,
  tx: anchor.web3.Transaction,
  signers: anchor.web3.Signer[] = [],
  opts: anchor.web3.ConfirmOptions = {},
): Promise<string> {
  const commitment = opts.commitment || opts.preflightCommitment || "confirmed";
  const latest = await withRpcRetry(() =>
    provider.connection.getLatestBlockhash({ commitment }),
  );

  tx.feePayer ||= provider.publicKey;
  tx.recentBlockhash ||= latest.blockhash;
  tx.lastValidBlockHeight ||= latest.lastValidBlockHeight;

  if (signers.length > 0) {
    tx.partialSign(...signers);
  }

  const signed = await provider.wallet.signTransaction(tx);
  const sig = await withRpcRetry(() =>
    provider.connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: opts.skipPreflight,
      preflightCommitment: opts.preflightCommitment || commitment,
      maxRetries: opts.maxRetries,
    }),
  );

  await withRpcRetry(() =>
    confirmSignatureByPolling(
      provider.connection,
      sig,
      tx.lastValidBlockHeight!,
      commitment,
    ),
  );

  return sig;
}

async function getMxePublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  retries = 8,
  delayMs = 1000,
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const key = await getMXEPublicKey(provider, programId);
    if (key) {
      return key;
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(`MXE public key unavailable for program ${programId.toString()}`);
}

async function main() {
  process.env.ARCIUM_CLUSTER_OFFSET = "456";

  const walletPath = process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/devnet.json`;
  const conn = new anchor.web3.Connection(
    process.env.ANCHOR_PROVIDER_URL || process.env.RPC_URL || "https://api.devnet.solana.com",
    {
      commitment: "confirmed",
      wsEndpoint: process.env.WS_RPC_URL,
    },
  );
  const owner = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath).toString())),
  );
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(owner), {
    commitment: "confirmed",
    skipPreflight: true,
  });
  provider.sendAndConfirm = (
    tx: anchor.web3.Transaction,
    signers?: anchor.web3.Signer[],
    opts?: anchor.web3.ConfirmOptions,
  ) => sendAndConfirmCompat(provider, tx, signers || [], opts || {});
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "../target/idl/zkkyc.json"), "utf-8"));
  const program = new anchor.Program(idl, provider) as anchor.Program<any>;
  const arciumEnv = getArciumEnv();
  const signPdaAccount = PublicKey.findProgramAddressSync([SIGN_PDA_SEED], PROGRAM_ID)[0];

  log("demo_start", {
    program: PROGRAM_ID.toString(),
    wallet: owner.publicKey.toString(),
    description: "Encrypted KYC check via MXE without exposing PII",
  });

  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  const mxePublicKey = await getMxePublicKeyWithRetry(provider, PROGRAM_ID);

  const age = BigInt(Math.floor(Math.random() * 48) + 18);
  const jurisdiction = BigInt(Math.floor(Math.random() * 2));
  log("identity_prepared", {
    age: "encrypted",
    jurisdiction: "encrypted",
    note: `Local sample values prepared for compliance check (${age.toString()}, ${jurisdiction.toString()})`,
  });

  const nonce = randomBytes(16);
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
  const cipher = new RescueCipher(sharedSecret);
  const ciphertext = cipher.encrypt([age, jurisdiction], nonce);

  const computationOffset = new anchor.BN(randomBytes(8), "hex");
  const clusterOffset = arciumEnv.arciumClusterOffset;

  try {
    const sig = await program.methods
      .verifyKyc(
        computationOffset,
        Array.from(ciphertext[0]),
        Array.from(ciphertext[1]),
        Array.from(publicKey),
        new anchor.BN(deserializeLE(nonce).toString()),
      )
      .accountsPartial({
        payer: owner.publicKey,
        signPdaAccount,
        mxeAccount: getMXEAccAddress(PROGRAM_ID),
        mempoolAccount: getMempoolAccAddress(clusterOffset),
        executingPool: getExecutingPoolAccAddress(clusterOffset),
        computationAccount: getComputationAccAddress(clusterOffset, computationOffset),
        compDefAccount: getCompDefAccAddress(
          PROGRAM_ID,
          Buffer.from(getCompDefAccOffset("verify_kyc")).readUInt32LE(),
        ),
        clusterAccount: getClusterAccAddress(clusterOffset),
      })
      .rpc({ skipPreflight: true, commitment: "confirmed" });

    log("kyc_queued", {
      sig,
      explorer: `https://explorer.solana.com/tx/${sig}?cluster=devnet`,
      note: "KYC compliance check queued in MXE cluster 456",
    });

    const finalizeSig = await Promise.race([
      awaitComputationFinalization(provider, computationOffset, PROGRAM_ID, "confirmed"),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), 90_000)),
    ]);

    log("kyc_success", {
      queueSig: sig,
      finalizeSig,
      clusterOffset,
    });
  } catch (e: any) {
    log("kyc_fail", {
      message: e.message || String(e),
      logs: e.logs || [],
      code: e.code,
      raw: (() => { try { return JSON.stringify(e); } catch { return String(e); } })(),
    });
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(JSON.stringify({ event: "fatal", message: e.message }));
  process.exit(1);
});
