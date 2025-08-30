// testPumpSwapFullValidation.js
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

class SolanaService {
  constructor(rpcUrl) {
    this.connection = new Connection(rpcUrl, 'confirmed');

    this.PUMP_PROGRAM_ID = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
    this.GLOBAL_FEE_VAULT = new PublicKey('CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM');
    this.CONFIG_AUTHORITY = new PublicKey('Ce6TQqeCH9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');

    this.BUY_DISCRIM_HEX = '66063d1201daebea';
  }

  log(...args) {
    console.log(new Date().toISOString(), ...args);
  }

  _validatePubkey(pubkey, label) {
    try {
      const pk = new PublicKey(pubkey);
      this.log(`${label} is valid:`, pk.toBase58());
      return pk;
    } catch (err) {
      throw new Error(`${label} is INVALID: ${err.message}`);
    }
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

  async executePumpSwap({ decryptedKey, tokenOut, amountIn }) {
    try {
      this.log('🔹 Decoding payer key...');
      const secretKey = bs58.decode(decryptedKey);
      if (secretKey.length !== 64) throw new Error('Secret key length invalid');
      const payer = Keypair.fromSecretKey(secretKey);
      this.log('Payer:', payer.publicKey.toBase58());

      // --- Token mint
      const mintPubkey = this._validatePubkey(tokenOut, 'Mint Pubkey');

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
      this._validatePubkey(globalPda, 'Global PDA');
      this._validatePubkey(bondingCurvePda, 'BondingCurve PDA');

      // --- ATAs
      const bondingCurveATA = await getAssociatedTokenAddress(mintPubkey, bondingCurvePda, true);
      this._validatePubkey(bondingCurveATA, 'BondingCurve ATA');

      const { ata: userATA, ix: createUserAtaIx } = await this._getOrCreateATAIx(payer.publicKey, mintPubkey, payer.publicKey);
      this._validatePubkey(userATA, 'User ATA');

      // --- Program accounts
      const accountList = [
        { label: 'Global PDA', key: globalPda },
        { label: 'Fee Vault', key: this.GLOBAL_FEE_VAULT },
        { label: 'Mint', key: mintPubkey },
        { label: 'BondingCurve PDA', key: bondingCurvePda },
        { label: 'BondingCurve ATA', key: bondingCurveATA },
        { label: 'User ATA', key: userATA },
        { label: 'Payer', key: payer.publicKey },
        { label: 'System Program', key: SystemProgram.programId },
        { label: 'Token Program', key: TOKEN_PROGRAM_ID },
        { label: 'Sysvar Rent', key: new PublicKey('SysvarRent11111111111111111111111111111111') },
        { label: 'Config Authority', key: this.CONFIG_AUTHORITY },
        { label: 'Pump Program', key: this.PUMP_PROGRAM_ID },
      ];

      accountList.forEach(({ label, key }) => this._validatePubkey(key, label));

      // --- Build transaction
      const keys = accountList.map(({ key }) => ({
        pubkey: key,
        isSigner: key.equals(payer.publicKey),
        isWritable: [this.GLOBAL_FEE_VAULT, bondingCurvePda, bondingCurveATA, userATA, payer.publicKey].some(k => k.equals(key)),
      }));

      const buyIx = { keys, programId: this.PUMP_PROGRAM_ID, data };

      const { blockhash } = await this.connection.getLatestBlockhash();
      const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash });
      if (createUserAtaIx) tx.add(createUserAtaIx);
      tx.add(buyIx);

      // --- Simulate
      const sim = await this.connection.simulateTransaction(tx);
      this.log('Simulation result:', sim.value);

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
  const tokenOut = '6KvYCcmz1VjFxc6pmmqEWTdezssGT7XHk6CnyCNQpump';
  const amountIn = 0.01;

  const solService = new SolanaService(RPC_URL);

  console.log('🔹 Running fully validated Pump.fun BUY test...');
  try {
    const result = await solService.executePumpSwap({ decryptedKey, tokenOut, amountIn });
    console.log('✅ Transaction signature:', result.signature);
  } catch (err) {
    console.error('❌ Test failed:', err);
  }
})();
