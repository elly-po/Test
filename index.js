// testPumpSwapFullyValidatedWithChecks.js
const {
  Connection,
  PublicKey,
  LAMPORTS_PER_SOL,
  Transaction,
  sendAndConfirmTransaction,
  Keypair,
  SystemProgram,
  SendTransactionError,
} = require('@solana/web3.js');

const {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
} = require('@solana/spl-token');

const bs58 = require('bs58');
const Bottleneck = require('bottleneck');

class SolanaService {
  constructor(rpcUrl) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.limiter = new Bottleneck({ maxConcurrent: 5, minTime: 200 });

    // Hardcoded addresses
    this.PUMP_PROGRAM_ID_STR = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
    this.GLOBAL_FEE_VAULT_STR = 'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM';
    this.CONFIG_AUTHORITY_STR = 'Ce6TQqeCH9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1';
    this.SYSVAR_RENT_STR = 'SysvarRent111111111111111111111111111111111';

    this.BUY_DISCRIM_HEX = '66063d1201daebea';
  }

  log(...args) {
    console.log(new Date().toISOString(), ...args);
  }

  async _getOrCreateATAIx(ownerPubkey, mintPubkey, payerPubkey) {
    const ata = await getAssociatedTokenAddress(mintPubkey, ownerPubkey, true);
    const info = await this.connection.getAccountInfo(ata);
    if (!info) {
      this.log(`🔹 ATA does not exist, will create: ${ata.toBase58()}`);
      const ix = createAssociatedTokenAccountInstruction(payerPubkey, ata, ownerPubkey, mintPubkey);
      return { ata, ix };
    }
    return { ata, ix: null };
  }

  validateAddress(name, addrStr) {
    try {
      const pk = new PublicKey(addrStr);
      this.log(`✅ ${name} valid: ${pk.toBase58()}`);
      return pk;
    } catch (err) {
      this.log(`❌ ${name} INVALID: ${addrStr}`, err.message);
      throw new Error(`${name} invalid`);
    }
  }

  async executePumpSwap({ decryptedKey, tokenIn = 'SOL', tokenOut, amountIn }) {
    if (!tokenOut || !amountIn) throw new Error('tokenOut and amountIn are required');

    try {
      this.log('🔹 Decoding payer key...');
      const secretKey = bs58.decode(decryptedKey);
      const payer = Keypair.fromSecretKey(secretKey);
      this.log('Payer:', payer.publicKey.toBase58());

      // Validate hardcoded addresses
      const PUMP_PROGRAM_ID = this.validateAddress('PUMP_PROGRAM_ID', this.PUMP_PROGRAM_ID_STR);
      const GLOBAL_FEE_VAULT = this.validateAddress('GLOBAL_FEE_VAULT', this.GLOBAL_FEE_VAULT_STR);
      const CONFIG_AUTHORITY = this.validateAddress('CONFIG_AUTHORITY', this.CONFIG_AUTHORITY_STR);
      const SYSVAR_RENT = this.validateAddress('SYSVAR_RENT', this.SYSVAR_RENT_STR);

      // Token addresses
      const wsol = 'So11111111111111111111111111111111111111112';
      if (tokenIn.toUpperCase() === 'SOL') tokenIn = wsol;
      if (tokenOut.toUpperCase() === 'SOL') tokenOut = wsol;

      const mintPubkey = new PublicKey(tokenOut);
      this.log('Mint Pubkey is valid:', mintPubkey.toBase58());

      const { blockhash } = await this.connection.getLatestBlockhash();

      // Instruction data
      const lamportsIn = BigInt(Math.floor(Number(amountIn) * 1e9));
      const maxSol = BigInt(-1);
      const data = Buffer.alloc(24);
      Buffer.from(this.BUY_DISCRIM_HEX, 'hex').copy(data, 0);
      data.writeBigInt64LE(lamportsIn, 8);
      data.writeBigInt64LE(maxSol, 16);
      this.log('Instruction data (hex):', data.toString('hex'));

      // PDAs
      const [globalPda] = await PublicKey.findProgramAddress([Buffer.from('global')], PUMP_PROGRAM_ID);
      const [bondingCurvePda] = await PublicKey.findProgramAddress(
        [Buffer.from('bonding-curve'), mintPubkey.toBuffer()],
        PUMP_PROGRAM_ID
      );
      this.log('Global PDA:', globalPda.toBase58());
      this.log('BondingCurve PDA:', bondingCurvePda.toBase58());

      // ATAs
      const bondingCurveATA = await getAssociatedTokenAddress(mintPubkey, bondingCurvePda, true);
      const { ata: userATA, ix: createUserAtaIx } = await this._getOrCreateATAIx(
        payer.publicKey,
        mintPubkey,
        payer.publicKey
      );
      this.log('BondingCurve ATA:', bondingCurveATA.toBase58());
      this.log('User ATA:', userATA.toBase58());

      // Validate all addresses
      const allAddresses = [
        { name: 'Payer', addr: payer.publicKey },
        { name: 'Mint', addr: mintPubkey },
        { name: 'Global PDA', addr: globalPda },
        { name: 'BondingCurve PDA', addr: bondingCurvePda },
        { name: 'BondingCurve ATA', addr: bondingCurveATA },
        { name: 'User ATA', addr: userATA },
        { name: 'GLOBAL_FEE_VAULT', addr: GLOBAL_FEE_VAULT },
        { name: 'CONFIG_AUTHORITY', addr: CONFIG_AUTHORITY },
        { name: 'SYSVAR_RENT', addr: SYSVAR_RENT },
        { name: 'SystemProgram', addr: SystemProgram.programId },
        { name: 'TOKEN_PROGRAM_ID', addr: TOKEN_PROGRAM_ID },
        { name: 'PUMP_PROGRAM_ID', addr: PUMP_PROGRAM_ID },
      ];

      allAddresses.forEach(({ name, addr }) => {
        try {
          new PublicKey(addr);
          this.log(`✅ ${name} valid: ${addr.toBase58 ? addr.toBase58() : addr.toString()}`);
        } catch (err) {
          this.log(`❌ ${name} INVALID: ${addr.toString()}`, err.message);
          throw new Error(`${name} invalid`);
        }
      });

      // Transaction
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
        { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
        { pubkey: CONFIG_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
      ];

      const buyIx = { keys, programId: PUMP_PROGRAM_ID, data };
      const tx = new Transaction({ recentBlockhash: blockhash, feePayer: payer.publicKey });
      if (createUserAtaIx) tx.add(createUserAtaIx);
      tx.add(buyIx);

      // Pre-simulation balance check
      const payerBalance = await this.connection.getBalance(payer.publicKey);
      this.log(`Payer SOL balance: ${payerBalance / LAMPORTS_PER_SOL} SOL`);

      // Simulation with full logging
      try {
        const sim = await this.connection.simulateTransaction(tx);
        this.log('Simulation result:', sim.value);
        if (sim.value.err) throw new Error(JSON.stringify(sim.value.err));
      } catch (err) {
        this.log('Simulation failed:', err.message);
        throw new Error(`Simulation failed: ${err.message}`);
      }

      // Send transaction
      try {
        const signature = await sendAndConfirmTransaction(this.connection, tx, [payer], { commitment: 'confirmed' });
        this.log('✅ PumpFun BUY executed', { signature });
        return { signature };
      } catch (err) {
        if (err instanceof SendTransactionError) {
          this.log('SendTransactionError logs:', err.logs);
        }
        throw err;
      }
    } catch (err) {
      this.log('❌ PumpFun BUY failed:', err?.message || err);
      throw new Error(`Swap buy failed: ${err?.message || err}`);
    }
  }
}

// --------- TEST CONFIGURATION ---------
(async () => {
  const RPC_URL = 'https://api.mainnet-beta.solana.com';
  const decryptedKey = '4NJA1qCuWLune6U3uyaCPzTdtA1H8cEuUwxinjTcK56ubDPMgzdBqSmJEimwbhnpp69nEsqFgDe4BkprdmJ7vfFk';
  const tokenOut = '6KvYCcmz1VjFxc6pmmqEWTdezssGT7XHk6CnyCNQpump';
  const amountIn = 0.01; // SOL amount

  const solService = new SolanaService(RPC_URL);
  try {
    console.log('🔹 Running fully validated Pump.fun BUY test with ATA creation...');
    const result = await solService.executePumpSwap({ decryptedKey, tokenOut, amountIn });
    console.log('✅ Transaction signature:', result.signature);
  } catch (err) {
    console.error('❌ Test failed:', err);
  }
})();

