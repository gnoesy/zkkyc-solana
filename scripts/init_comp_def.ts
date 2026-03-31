import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import {
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  uploadCircuit,
  getMXEAccAddress,
  getLookupTableAddress,
  getRawCircuitAccAddress,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";

const MAX_ACCOUNT_SIZE = 10 * 1024 * 1024;
const MAX_UPLOAD_PER_TX_BYTES = 814;

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

async function sendAndConfirmCompat(
  provider: anchor.AnchorProvider,
  tx: anchor.web3.Transaction,
  signers: anchor.web3.Signer[] = [],
  opts: anchor.web3.ConfirmOptions = {},
): Promise<string> {
  const commitment = opts.commitment || opts.preflightCommitment || "confirmed";
  const latest = await withRpcRetry(() => provider.connection.getLatestBlockhash({ commitment }));

  tx.feePayer ||= provider.publicKey;
  tx.recentBlockhash ||= latest.blockhash;
  tx.lastValidBlockHeight ||= latest.lastValidBlockHeight;

  if (signers.length > 0) {
    tx.partialSign(...signers);
  }

  const signed = await provider.wallet.signTransaction(tx);
  const sig = await withRpcRetry(() => provider.connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: opts.skipPreflight,
    preflightCommitment: opts.preflightCommitment || commitment,
    maxRetries: opts.maxRetries,
  }));

  await withRpcRetry(() => provider.connection.confirmTransaction(
    {
      signature: sig,
      blockhash: tx.recentBlockhash,
      lastValidBlockHeight: tx.lastValidBlockHeight!,
    },
    commitment,
  ));

  return sig;
}

async function uploadCircuitFallback(
  provider: anchor.AnchorProvider,
  owner: Keypair,
  circuitName: string,
  programId: PublicKey,
  rawCircuit: Buffer,
): Promise<void> {
  const conn = provider.connection;
  const program = getArciumProgram(provider);
  const offsetBytes = getCompDefAccOffset(circuitName);
  const offset = Buffer.from(offsetBytes).readUInt32LE(0);
  const compDefPDA = PublicKey.findProgramAddressSync(
    [getArciumAccountBaseSeed("ComputationDefinitionAccount"), programId.toBuffer(), offsetBytes],
    getArciumProgramId(),
  )[0];
  const partSize = MAX_ACCOUNT_SIZE - 9;
  const partCount = Math.ceil(rawCircuit.length / partSize);

  for (let rawCircuitIndex = 0; rawCircuitIndex < partCount; rawCircuitIndex++) {
    const rawCircuitPart = rawCircuit.subarray(
      rawCircuitIndex * partSize,
      Math.min((rawCircuitIndex + 1) * partSize, rawCircuit.length),
    );
    const rawCircuitPda = getRawCircuitAccAddress(compDefPDA, rawCircuitIndex);
    let accInfo = await withRpcRetry(() => conn.getAccountInfo(rawCircuitPda));

    if (accInfo === null) {
      const initTx = await program.methods
        .initRawCircuitAcc(offset, programId, rawCircuitIndex)
        .accounts({ signer: owner.publicKey })
        .transaction();
      const initSig = await sendAndConfirmCompat(provider, initTx, [owner], {
        skipPreflight: true,
        preflightCommitment: "confirmed",
        commitment: "confirmed",
      });
      console.log(`init raw circuit acc ${rawCircuitIndex}: ${initSig}`);
      accInfo = await withRpcRetry(() => conn.getAccountInfo(rawCircuitPda));
    }

    const requiredSize = rawCircuitPart.length + 9;
    while ((accInfo?.data.length || 0) < requiredSize) {
      const resizeTx = await program.methods
        .embiggenRawCircuitAcc(offset, programId, rawCircuitIndex)
        .accounts({ signer: owner.publicKey })
        .transaction();
      const resizeSig = await sendAndConfirmCompat(provider, resizeTx, [owner], {
        skipPreflight: true,
        preflightCommitment: "confirmed",
        commitment: "confirmed",
      });
      accInfo = await withRpcRetry(() => conn.getAccountInfo(rawCircuitPda));
      console.log(`resize raw circuit acc ${rawCircuitIndex}: ${resizeSig} size=${accInfo?.data.length}`);
    }

    for (let circuitOffset = 0; circuitOffset < rawCircuitPart.length; circuitOffset += MAX_UPLOAD_PER_TX_BYTES) {
      const chunk = rawCircuitPart.subarray(
        circuitOffset,
        Math.min(circuitOffset + MAX_UPLOAD_PER_TX_BYTES, rawCircuitPart.length),
      );
      const paddedChunk = Buffer.alloc(MAX_UPLOAD_PER_TX_BYTES);
      chunk.copy(paddedChunk);
      const uploadTx = await program.methods
        .uploadCircuit(offset, programId, rawCircuitIndex, Array.from(paddedChunk), circuitOffset)
        .accounts({ signer: owner.publicKey })
        .transaction();
      const uploadSig = await sendAndConfirmCompat(provider, uploadTx, [owner], {
        skipPreflight: true,
        preflightCommitment: "confirmed",
        commitment: "confirmed",
      });
      console.log(`upload raw circuit acc ${rawCircuitIndex} offset=${circuitOffset}: ${uploadSig}`);
    }
  }

  const finalizeTx = await program.methods
    .finalizeComputationDefinition(offset, programId)
    .accounts({ signer: owner.publicKey })
    .transaction();
  const finalizeSig = await sendAndConfirmCompat(provider, finalizeTx, [owner], {
    skipPreflight: true,
    preflightCommitment: "confirmed",
    commitment: "confirmed",
  });
  console.log(`finalize computation definition: ${finalizeSig}`);
}

async function main() {
  process.env.ARCIUM_CLUSTER_OFFSET = "456";

  const rpcUrl = process.env.ANCHOR_PROVIDER_URL || process.env.RPC_URL || "https://api.devnet.solana.com";
  const walletPath = process.env.ANCHOR_WALLET || `${os.homedir()}/.config/solana/devnet.json`;
  const conn = new anchor.web3.Connection(rpcUrl, "confirmed");
  const owner = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath).toString()))
  );
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(owner), {
    commitment: "confirmed", skipPreflight: true,
  });
  provider.sendAndConfirm = (
    tx: anchor.web3.Transaction,
    signers?: anchor.web3.Signer[],
    opts?: anchor.web3.ConfirmOptions,
  ) => sendAndConfirmCompat(provider, tx, signers || [], opts || {});
  anchor.setProvider(provider);

  const idl = JSON.parse(fs.readFileSync("target/idl/zkkyc.json", "utf-8"));
  const program = new anchor.Program(idl, provider) as Program<any>;
  const arciumProgram = getArciumProgram(provider);

  console.log("Program ID:", program.programId.toString());
  console.log("RPC URL:", rpcUrl);
  console.log("Wallet:", owner.publicKey.toString());

  const baseSeed = getArciumAccountBaseSeed("ComputationDefinitionAccount");
  const offset = getCompDefAccOffset("verify_kyc");
  const compDefPDA = PublicKey.findProgramAddressSync(
    [baseSeed, program.programId.toBuffer(), offset],
    getArciumProgramId(),
  )[0];
  console.log("Comp def PDA:", compDefPDA.toString());

  const mxeAccount = getMXEAccAddress(program.programId);
  const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
  const lutAddress = getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);

  try {
    const sig = await program.methods
      .initVerifyKycCompDef()
      .accounts({ compDefAccount: compDefPDA, payer: owner.publicKey, mxeAccount, addressLookupTable: lutAddress })
      .signers([owner])
      .rpc({ commitment: "confirmed" });
    console.log("init_verify_kyc_comp_def sig:", sig);
  } catch (e: any) {
    console.log("Comp def already exists or error:", e.message || String(e));
  }

  console.log("Uploading circuit...");
  const rawCircuit = fs.readFileSync("build/verify_kyc.arcis");
  const chunkSize = Number(process.env.ARCIUM_UPLOAD_CHUNK_SIZE || "10");
  try {
    await uploadCircuit(provider, "verify_kyc", program.programId, rawCircuit, true, chunkSize,
      { skipPreflight: true, preflightCommitment: "confirmed", commitment: "confirmed" });
  } catch (e: any) {
    console.error("Upload circuit error:", e?.message || String(e));
    console.error("Upload circuit raw:", (() => { try { return JSON.stringify(e); } catch { return String(e); } })());
    console.log("Retrying with sequential fallback uploader...");
    await uploadCircuitFallback(provider, owner, "verify_kyc", program.programId, rawCircuit);
  }
  console.log("Circuit uploaded!");
}

main().catch(e => { console.error("Fatal:", e.message || String(e)); process.exit(1); });
