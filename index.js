// testPumpSwapOfficial.js
const { 
  Connection, 
  PublicKey, 
  LAMPORTS_PER_SOL, 
  Keypair, 
  Transaction, 
  sendAndConfirmTransaction, 
  SystemProgram 
} = require('@solana/web3.js');
const { 
  getAssociatedTokenAddress, 
  createAssociatedTokenAccountInstruction, 
  TOKEN_PROGRAM_ID 
} = require('@solana/spl-token');
const bs58 = require('bs58');

(async () => {
  // -------- CONFIGURATION --------
  const RPC_URL = "https://api.mainnet-beta.solana.com";
  const MINT = "6KvYCcmz1VjFxc6pmmqEWTdezssGT7XHk6CnyCNQpump"; // Pump.fun token
  const AMOUNT_IN_SOL = 0.1; // SOL to spend
  const PRIVATE_KEY_BASE58 = "4NJA1qCuWLune6U3uyaCPzTdtA1H8cEuUwxinjTcK56ubDPMgzdBqSmJEimwbhnpp69nEsqFgDe4BkprdmJ7vfFk";

  const connection = new Connection(RPC_URL, "confirmed");

  // -------- KEYPAIR --------
  const secretKey = bs58.decode(PRIVATE_KEY_BASE58);
  const payer = Keypair.fromSecretKey(secretKey);
  console.log("Payer:", payer.publicKey.toBase58());

  // -------- PUMP.FUN PROGRAM --------
  const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
  const GLOBAL_FEE_VAULT = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");
  const CONFIG_AUTHORITY = new PublicKey("Ce6TQqeCH9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1");

  // -------- DERIVE BLOCKHASH --------
  const { blockhash } = await connection.getLatestBlockhash();

  // -------- DERIVE PDAs --------
  const [globalPda] = await PublicKey.findProgramAddress(
    [Buffer.from("global")],
    PUMP_PROGRAM_ID
  );
  const [bondingCurvePda] = await PublicKey.findProgramAddress(
    [Buffer.from("bonding-curve"), new PublicKey(MINT).toBuffer()],
    PUMP_PROGRAM_ID
  );

  console.log("Global PDA:", globalPda.toBase58());
  console.log("BondingCurve PDA:", bondingCurvePda.toBase58());

  // -------- ASSOCIATED TOKEN ACCOUNTS --------
  const mintPubkey = new PublicKey(MINT);

  // Bonding curve ATA
  const bondingCurveATA = await getAssociatedTokenAddress(mintPubkey, bondingCurvePda, true);
  
  // User ATA, create instruction if doesn't exist
  const userATA = await getAssociatedTokenAddress(mintPubkey, payer.publicKey);
  const userATAInfo = await connection.getAccountInfo(userATA);
  let createUserAtaIx = null;
  if (!userATAInfo) {
    createUserAtaIx = createAssociatedTokenAccountInstruction(
      payer.publicKey, // payer
      userATA,
      payer.publicKey, // owner
      mintPubkey
    );
    console.log("User ATA will be created:", userATA.toBase58());
  } else {
    console.log("User ATA exists:", userATA.toBase58());
  }

  console.log("BondingCurve ATA:", bondingCurveATA.toBase58());

  // -------- BUILD INSTRUCTION DATA --------
  const lamportsIn = BigInt(Math.floor(AMOUNT_IN_SOL * LAMPORTS_PER_SOL));
  const maxSol = BigInt(-1);
  const data = Buffer.alloc(24);
  Buffer.from("66063d1201daebea", "hex").copy(data, 0);
  data.writeBigInt64LE(lamportsIn, 8);
  data.writeBigInt64LE(maxSol, 16);
  console.log("Instruction data (hex):", data.toString("hex"));

  // -------- BUILD ACCOUNTS --------
  const keys = [
    { pubkey: globalPda, isSigner: false, isWritable: false },
    { pubkey: GLOBAL_FEE_VAULT, isSigner: false, isWritable: true },
    { pubkey: mintPubkey, isSigner: false, isWritable: false },
    { pubkey: bondingCurvePda, isSigner: false, isWritable: true },
    { pubkey: bondingCurveATA, isSigner: false, isWritable: true },
    { pubkey: userATA, isSigner: false, isWritable: true },
    { pubkey: payer.publicKey, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: new PublicKey("SysvarRent11111111111111111111111111111111"), isSigner: false, isWritable: false },
    { pubkey: CONFIG_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  const buyIx = { keys, programId: PUMP_PROGRAM_ID, data };

  // -------- BUILD TRANSACTION --------
  const tx = new Transaction({ recentBlockhash: blockhash, feePayer: payer.publicKey });
  if (createUserAtaIx) tx.add(createUserAtaIx);
  tx.add(buyIx);

  // -------- SIMULATE --------
  try {
    const sim = await connection.simulateTransaction(tx);
    console.log("Simulation logs:", sim.value?.logs);
  } catch (err) {
    console.warn("Simulation failed:", err.message || err);
  }

  // -------- SEND --------
  try {
    const signature = await sendAndConfirmTransaction(connection, tx, [payer], { commitment: "confirmed" });
    console.log("✅ Transaction sent. Signature:", signature);
  } catch (err) {
    console.error("❌ PumpFun BUY failed:", err.message || err);
  }
})();
