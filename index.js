// testPumpSwapLogging.js
const {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
  Keypair,
  SystemProgram,
} = require('@solana/web3.js');

const { getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID } = require('@solana/spl-token');
const bs58 = require('bs58');
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
      this.log('User ATA will be created:', ata.toBase58());
      return { ata, ix };
    }
    this.log('User ATA exists:', ata.toBase58());
    return { ata, ix: null };
  }

  async executePumpSwap({ decryptedKey, tokenIn = 'SOL', tokenOut, amountIn }) {
    if (!tokenOut || !amountIn) throw new Error('tokenOut and amountIn are required');

    try {
      // --- Decode payer key
      this.log('🔹 Decoding payer key...');
      const secretKey = bs58.decode(decryptedKey);
      if (secretKey.length !== 64) throw new Error('Secret key length invalid');
      const payer = Keypair.fromSecretKey(secretKey);
      this.log('Payer:', payer.publicKey.toBase58());

      // --- Token addresses
      const wsol = 'So11111111111111111111111111111111111111112';
      if (tokenIn.toUpperCase() === 'SOL') tokenIn = wsol;
      if (tokenOut.toUpperCase() === 'SOL') tokenOut = wsol;
      const mintPubkey = new PublicKey(tokenOut);
      this.log('Mint Pubkey:', mintPubkey.toBase58());

      // --- Instruction data
      const lamportsIn = BigInt(Math.floor(Number(amountIn) * 1e9));
      const maxSol = BigInt(-1);
      const data = Buffer.alloc(24);
      Buffer.from(this.BUY_DISCRIM_HEX, 'hex').copy(data, 0);
      data.writeBigInt64LE(lamportsIn, 8);
      data.writeBigInt64LE(maxSol, 16);
      this.log('Instruction data (hex):', data.toString('hex'));

      // --- PDAs
      const [globalPda] = await PublicKey.findProgramAddress([Buffer.from('global')], this.PUMP_PROGRAM_ID);
      const [bondingCurvePda] = await PublicKey.findProgramAddress([Buffer.from('bonding-curve'), mintPubkey.toBuffer()], this.PUMP_PROGRAM_ID);
      this.log('Global PDA:', globalPda.toBase58());
      this.log('BondingCurve PDA:', bondingCurvePda.toBase58());

      // --- ATAs
      const bondingCurveATA = await getAssociatedTokenAddress(mintPubkey, bondingCurvePda, true);
      const { ata: userATA, ix: createUserAtaIx } = await this._getOrCreateATAIx(payer.publicKey, mintPubkey, payer.publicKey);
      this.log('BondingCurve ATA:', bondingCurveATA.toBase58());
      this.log('User ATA:', userATA.toBase58());

      // --- Build instruction
      const keys = [
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
      ];
      const buyIx = { keys, programId: this.PUMP_PROGRAM_ID, data };

      // --- Transaction
      const { blockhash } = await this.connection.getLatestBlockhash();
      const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash });
      if (createUserAtaIx) tx.add(createUserAtaIx);
      tx.add(buyIx);

      // --- Simulate before sending
      try {
        const sim = await this.connection.simulateTransaction(tx);
        this.log('Simulation result:', sim.value);
      } catch (simErr) {
        this.log('Simulation failed:', simErr.message);
      }

      // --- Send
      const signature = await sendAndConfirmTransaction(this.connection, tx, [payer], { commitment: 'confirmed' });
      this.log('✅ PumpFun BUY executed', { signature });
      return { signature };

    } catch (err) {
      this.log('❌ PumpFun BUY failed:', err?.message || err);
      throw new Error(`Swap buy failed: ${err?.message || err}`);
    }
  }
}

// --------- STANDALONE TEST ---------
(async () => {
  const RPC_URL = 'https://api.mainnet-beta.solana.com';
  const decryptedKey = '4NJA1qCuWLune6U3uyaCPzTdtA1H8cEuUwxinjTcK56ubDPMgzdBqSmJEimwbhnpp69nEsqFgDe4BkprdmJ7vfFk';
  const tokenOut = '6KvYCcmz1VjFxc6pmmqEWTdezssGT7XHk6CnyCNQpump'; // Example pump.fun token
  const amountIn = 0.01; // SOL to spend

  const solService = new SolanaService(RPC_URL);

  console.log('🔹 Running fully logged Pump.fun BUY test...');
  try {
    const result = await solService.executePumpSwap({ decryptedKey, tokenOut, amountIn });
    console.log('✅ Transaction signature:', result.signature);
  } catch (err) {
    console.error('❌ Test failed:', err);
  }
})();
