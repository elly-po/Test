// testPumpSwap.js
const fs = require("fs");
const path = require("path");
const { readFileSync } = require("fs");
const {
  Connection,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
} = require("@solana/web3.js");
const {
  findAssociatedTokenPda,
  getCreateAssociatedTokenInstruction,
  getProgramDerivedAddress,
  address,
  IInstruction,
  AccountRole,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstruction,
  signTransactionMessageWithSigners,
  getBase64EncodedWireTransaction,
  getAddressEncoder,
} = require("solana-program/web3.js");

(async () => {
  // -------- CONFIGURATION --------
  const RPC_URL = "https://api.mainnet-beta.solana.com";
  const MINT = "6KvYCcmz1VjFxc6pmmqEWTdezssGT7XHk6CnyCNQpump"; // Pump.fun token
  const AMOUNT_IN_SOL = 0.1; // Amount of SOL to spend
  const PRIVATE_KEY = "4NJA1qCuWLune6U3uyaCPzTdtA1H8cEuUwxinjTcK56ubDPMgzdBqSmJEimwbhnpp69nEsqFgDe4BkprdmJ7vfFk"; // Phantom private key

  // -------- CONNECTION --------
  const connection = new Connection(RPC_URL, "confirmed");

  // -------- DERIVE KEYPAIR --------
  const secretKey = Uint8Array.from(Buffer.from(PRIVATE_KEY, "base58"));
  const payer = require("@solana/web3.js").Keypair.fromSecretKey(secretKey);
  console.log("Payer:", payer.publicKey.toBase58());

  // -------- PUMP.FUN PROGRAM --------
  const PUMP_PROGRAM_ID = address("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
  const GLOBAL_FEE_VAULT = address("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");
  const CONFIG_AUTHORITY = address("Ce6TQqeCH9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");

  // -------- BLOCKHASH --------
  const { value: latestBlockhash } = await connection.getLatestBlockhash();

  // -------- AMOUNT & DATA --------
  const lamportsIn = BigInt(Math.floor(AMOUNT_IN_SOL * LAMPORTS_PER_SOL));
  const maxSol = BigInt(-1);
  const dataBuffer = Buffer.alloc(24);
  dataBuffer.write("66063d1201daebea", "hex");
  dataBuffer.writeBigInt64LE(lamportsIn, 8);
  dataBuffer.writeBigInt64LE(maxSol, 16);
  const data = Uint8Array.from(dataBuffer);
  console.log("Instruction data (hex):", dataBuffer.toString("hex"));

  // -------- DERIVE PDAs --------
  const addressEncoder = getAddressEncoder();

  const [globalPda] = getProgramDerivedAddress({
    seed: ["global"],
    programAdderss: PUMP_PROGRAM_ID,
  });
  const [bondingCurvePda] = getProgramDerivedAddress({
    seed: ["bonding-curve", addressEncoder.encode(address(MINT))],
    programAdderss: PUMP_PROGRAM_ID,
  });
  console.log("Global PDA:", globalPda);
  console.log("BondingCurve PDA:", bondingCurvePda);

  // -------- ASSOCIATED TOKEN ACCOUNTS --------
  const [bondingCurveATA] = findAssociatedTokenPda({
    mint: address(MINT),
    owner: bondingCurvePda,
  });
  const [userATA] = findAssociatedTokenPda({
    mint: address(MINT),
    owner: payer.publicKey.toBase58(),
  });
  console.log("BondingCurve ATA:", bondingCurveATA);
  console.log("User ATA:", userATA);

  const ataIx = getCreateAssociatedTokenInstruction({
    ata: userATA,
    mint: address(MINT),
    owner: payer.publicKey.toBase58(),
    payer,
  });

  // -------- INSTRUCTION --------
  const ix = {
    programAddress: PUMP_PROGRAM_ID,
    accounts: [
      { address: globalPda, role: AccountRole.READONLY },
      { address: GLOBAL_FEE_VAULT, role: AccountRole.WRITABLE },
      { address: address(MINT), role: AccountRole.READONLY },
      { address: bondingCurvePda, role: AccountRole.WRITABLE },
      { address: bondingCurveATA, role: AccountRole.WRITABLE },
      { address: userATA, role: AccountRole.WRITABLE },
      { address: payer.publicKey.toBase58(), role: AccountRole.WRITABLE_SIGNER },
      { address: address("11111111111111111111111111111111"), role: AccountRole.READONLY },
      { address: address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), role: AccountRole.READONLY },
      { address: address("SysvarRent11111111111111111111111111111111"), role: AccountRole.READONLY },
      { address: CONFIG_AUTHORITY, role: AccountRole.READONLY },
      { address: PUMP_PROGRAM_ID, role: AccountRole.READONLY },
    ],
    data,
  };

  // -------- BUILD & SIGN TX --------
  const txMessage = createTransactionMessage({ version: 0 });
  setTransactionMessageFeePayer(payer, txMessage);
  setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, txMessage);
  appendTransactionMessageInstruction(ataIx, txMessage);
  appendTransactionMessageInstruction(ix, txMessage);

  const signedTx = await signTransactionMessageWithSigners(txMessage);
  const encodedTx = await getBase64EncodedWireTransaction(signedTx);

  // -------- SIMULATE --------
  const sim = await connection.simulateTransaction(encodedTx, { encoding: "base64" });
  console.log("Simulation logs:", sim.value.logs);

  // -------- SEND --------
  const sig = await sendAndConfirmTransaction(connection, signedTx, [payer], { commitment: "confirmed" });
  console.log("Transaction sent. Signature:", sig);
})();
