// testPumpSwapStandalone.js
const {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  Keypair,
  SystemProgram,
} = require('@solana/web3.js');

const {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');

const bs58 = require('bs58'); // v5.x
const Bottleneck = require('bottleneck');

class SolanaService {
  constructor(rpcUrl) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.limiter = new Bottleneck({ maxConcurrent: 5, minTime: 200 });

    this.PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    this.GLOBAL_FEE_VAULT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
    this.CONFIG_AUTHORITY = new PublicKey('Ce6TQqeCH9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
    this.BUY_DISCRIM_HEX = '66063d1201daebea';
  }

  log(...args) {
    console.log(new Date().toISOString(), ...args);
  }

  async _getOrCreateATAIx(ownerPubkey, mintPubkey, payerPubkey) {
    const ata = await getAssociatedTokenAddress(mintPubkey, ownerPubkey, true);
    const info = await this.connection.getAccountInfo(ata);
    if (!info) {
      const ix = createAssociatedTokenAccountInstruction(payerPubkey, ata, ownerPubkey, mintPubkey);
      return { ata, ix };
    }
    return { ata, ix: null };
  }

  async executePumpSwap({ decryptedKeyBase58, tokenIn = 'SOL', tokenOut, amountIn }) {
    if (!tokenOut || !amountIn) throw new Error('tokenOut and amountIn are required');

    try {
      const secretKey = bs58.decode(decryptedKeyBase58);
      const payer = Keypair.fromSecretKey(secretKey);

      const wsol = 'So11111111111111111111111111111111111111112';
      if (tokenIn.toUpperCase() === 'SOL') tokenIn = wsol;
      if (tokenOut.toUpperCase() === 'SOL') tokenOut = wsol;

      const mintPubkey = new PublicKey(tokenOut);
      const { blockhash } = await this.connection.getLatestBlockhash();

      // Build instruction data
      const lamportsIn = BigInt(Math.floor(Number(amountIn) * 1e9));
      const maxSol = BigInt(-1);
      const data = Buffer.alloc(24);
      Buffer.from(this.BUY_DISCRIM_HEX, 'hex').copy(data, 0);
      data.writeBigInt64LE(lamportsIn, 8);
      data.writeBigInt64LE(maxSol, 16);

      // Derive PDAs
      const [globalPda] = await PublicKey.findProgramAddress([Buffer.from('global')], this.PUMP_PROGRAM_ID);
      const [bondingCurvePda] = await PublicKey.findProgramAddress(
        [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
        this.PUMP_PROGRAM_ID
      );

      // Get ATAs
      const bondingCurveATA = await getAssociatedTokenAddress(mintPubkey, bondingCurvePda, true);
      const { ata: userATA, ix: createUserAtaIx } = await this._getOrCreateATAIx(
        payer.publicKey,
        mintPubkey,
        payer.publicKey
      );

      // Validate all public keys (32 bytes)
      const validatePK = (pk, name) => {
        if (!pk || pk.toBytes().length !== 32) throw new Error(`Invalid PublicKey: ${name} -> ${pk}`);
        console.log(`${name}: ${pk.toBase58()}`);
      };

      validatePK(mintPubkey, 'Mint Pubkey');
      validatePK(globalPda, 'Global PDA');
      validatePK(bondingCurvePda, 'BondingCurve PDA');
      validatePK(bondingCurveATA, 'BondingCurve ATA');
      validatePK(userATA, 'User ATA');
      validatePK(payer.publicKey, 'Payer');

      // Build TransactionInstruction
      const buyIx = new TransactionInstruction({
        keys: [
          { pubkey: globalPda, isSigner: false, isWritable: false },
          { pubkey: this.GLOBAL_FEE_VAULT, isSigner: false, isWritable: true },
          { pubkey: mintPubkey, isSigner: false, isWritable: false },
          { pubkey: bondingCurvePda, isSigner: false, isWritable: true },
          { pubkey: bondingCurveATA, isSigner: false, isWritable: true },
          { pubkey: userATA, isSigner: false, isWritable: true },
          { pubkey: payer.publicKey, isSigner: true, isWritable: true },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
          { pubkey: new PublicKey('SysvarRent11111111111111111111111111111111'), isSigner: false, isWritable: false },
          { pubkey: this.CONFIG_AUTHORITY, isSigner: false, isWritable: false },
          { pubkey: this.PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        programId: this.PUMP_PROGRAM_ID,
        data,
      });

      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: payer.publicKey });
      if (createUserAtaIx) tx.add(createUserAtaIx);
      tx.add(buyIx);

      // Optional simulation
      try {
        const sim = await this.connection.simulateTransaction(tx);
        this.log('Simulation result:', sim.value);
      } catch (simErr) {
        this.log('Simulation error:', simErr.message);
      }

      // Send transaction
      const signature = await sendAndConfirmTransaction(this.connection, tx, [payer], { commitment: 'confirmed' });
      this.log('✅ PumpFun BUY executed', { signature });
      return { signature };
    } catch (err) {
      this.log('❌ PumpFun BUY failed:', err?.message || err);
      throw new Error(`Swap buy failed: ${err?.message || err}`);
    }
  }
}

// --------- TEST CONFIGURATION ---------
(async () => {
  const RPC_URL = 'https://api.mainnet-beta.solana.com';

  // Phantom base58 private key string
  const decryptedKeyBase58 = '4NJA1qCuWLune6U3uyaCPzTdtA1H8cEuUwxinjTcK56ubDPMgzdBqSmJEimwbhnpp69nEsqFgDe4BkprdmJ7vfFk';

  // Replace with a valid SPL token mint on mainnet
  const tokenOut = 'GuvGCUW8ay7Aa1Au8TTR8rZGajZcq8ZE6spdCa3Mmoon'; // wrapped SOL example
  const amountIn = 0.01; // SOL amount to spend

  const solService = new SolanaService(RPC_URL);

  try {
    console.log('🔹 Running standalone Pump.fun BUY test...');
    const result = await solService.executePumpSwap({ decryptedKeyBase58, tokenOut, amountIn });
    console.log('✅ Transaction signature:', result.signature);
  } catch (err) {
    console.error('❌ Test failed:', err);
  }
})();
