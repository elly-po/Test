import chalk from 'chalk';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { decodeInstruction as decodeSPLInstruction } from '@solana/spl-token';
import config from '../config/index.js';
import { heliusLimiter } from '../utils/limiter.js';
import { withBackoff } from '../utils/backoff.js';

export const PROGRAM_IDS = {
  raydium: 'RVKd61ztZW9C8W2kacWp7QKUhM8GzPz4FdWYJzX4pGz',
  pumpfun: 'G2z5vKbW6xVyJzv5bwVAoHa5bkkpKjKmtk5iPDSdZkW3',
  splToken: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  meteora: 'METL6oTzvWjVSkWsUXQ3Q8Lv8H9Cdn6C6z8DrZgPKyq',
  ataProgram: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
};

function throttleLimiter() {
  return new Promise((resolve, reject) => {
    heliusLimiter.removeTokens(1, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// Cache for Raydium SDK to prevent repeated imports
let Liquidity;
let raydiumImportPromise;

async function loadRaydiumSDK() {
  if (!raydiumImportPromise) {
    await throttleLimiter();
    raydiumImportPromise = import('@raydium-io/raydium-sdk-v2')
      .then(raydium => {
        Liquidity = raydium.Liquidity;
        console.log(chalk.gray('🧪 Raydium SDK loaded'));
        return true;
      })
      .catch(err => {
        console.error(chalk.redBright('❌ Failed to load Raydium SDK:'), err.message);
        return false;
      });
  }
  return raydiumImportPromise;
}

// Cache for SPL token decodes to reduce RPC calls
const splTokenCache = new Map();
const CACHE_TTL = 5000;

export async function resolveTag(ix, logs = [], connection) {
  const context = logs.join(' ').toLowerCase();

  if (!ix) {
    if (context.includes('initializemint')) {
      return buildTag('spl_mint_init', 0.96, 'unknown', logs);
    }
    if (context.includes('instruction: create') && context.includes('program data')) {
      return decodePumpFunCreate(logs);
    }
    if (/initializepool|pool created/.test(context)) {
      return buildTag('raydium_initPool', 0.92, 'unknown', logs);
    }
    if (/vault|mint|init/.test(context)) {
      return buildTag('meteora_initPool', 0.89, 'unknown', logs);
    }
    return null;
  }

  try {
    const pid = ix.programId.toString();
    const accounts = ix.accounts?.map(a => new PublicKey(a)) || [];
    const mint = accounts.find(pk => PublicKey.isOnCurve(pk.toString()))?.toString();
    const data = ix.data ? bs58.decode(ix.data) : null;
    const cacheKey = `${pid}:${mint}:${data?.toString()}`;

    if (splTokenCache.has(cacheKey)) {
      const cached = splTokenCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL) return cached.value;
    }

    if (pid === PROGRAM_IDS.pumpfun) {
      const tag = buildTag('pumpfun_launch', 0.95, mint || 'unknown', logs);
      splTokenCache.set(cacheKey, { value: tag, timestamp: Date.now() });
      return tag;
    }

    if (pid === PROGRAM_IDS.raydium) {
      await loadRaydiumSDK();
      if (Liquidity) {
        const decoded = Liquidity.decodeInstruction({
          programId: new PublicKey(pid),
          keys: accounts,
          data
        });
        if (decoded?.type === 'initializePool') {
          const tag = buildTag('raydium_initPool', 0.98, mint || 'unknown', logs);
          splTokenCache.set(cacheKey, { value: tag, timestamp: Date.now() });
          return tag;
        }
      }
    }

    if (pid === PROGRAM_IDS.meteora && logs.some(l => /mint|vault|init/i.test(l))) {
      const tag = buildTag('meteora_initPool', 0.89, mint || 'unknown', logs);
      splTokenCache.set(cacheKey, { value: tag, timestamp: Date.now() });
      return tag;
    }

    if (pid === PROGRAM_IDS.splToken) {
      if (!heliusLimiter.tryRemoveTokens(1, true)) {
        console.warn(chalk.yellow('⚠️ SPL decode rate limited'));
        return null;
      }
      const decoded = await withBackoff(() =>
        decodeSPLInstruction({ programId: new PublicKey(pid), keys: accounts, data })
      );
      if (decoded?.instruction === 'InitializeMint') {
        const tag = buildTag('spl_mint_init', 0.96, mint || 'unknown', logs);
        splTokenCache.set(cacheKey, { value: tag, timestamp: Date.now() });
        return tag;
      }
    }
  } catch (err) {
    console.log(chalk.redBright('Instruction resolver failed:'), err.message);
  }

  return null;
}

export function getDexForTag(tag) {
  const map = {
    raydium_initPool: 'raydium',
    pumpfun_launch: 'raydium',
    pumpfun_create: 'raydium',
    meteora_initPool: 'meteora',
    spl_mint_init: 'raydium'
  };
  const preferred = config.DEX_PRIORITY.find(d => d.toLowerCase() === map[tag]);
  return preferred || map[tag] || 'raydium';
}

function buildTag(tag, confidence, mint, logs) {
  if (confidence < config.CONFIDENCE_THRESHOLD) return null;
  return {
    tag,
    confidence,
    mint,
    logs: logs?.slice(0, 5) || []
  };
}

export function decodePumpFunCreate(logs) {
  if (!heliusLimiter.tryRemoveTokens(1, true)) {
    console.warn(chalk.yellow('⚠️ Pump.fun decode throttled'));
    return null;
  }

  const createLog = logs.find(l => l.includes('Instruction: Create'));
  const dataLog = logs.find(l => l.includes('Program data:'));
  if (!createLog || !dataLog) return null;

  try {
    const encoded = dataLog.split('Program data:')[1].trim();
    const buffer = Buffer.from(encoded, 'base64');

    const name = buffer.slice(0, 32).toString().replace(/\0/g, '');
    const symbol = buffer.slice(32, 36).toString().replace(/\0/g, '');
    const uri = buffer.slice(36, 236).toString().replace(/\0/g, '');
    const mint = new PublicKey(buffer.slice(236, 268));
    const curve = new PublicKey(buffer.slice(268, 300));
    const user = new PublicKey(buffer.slice(300, 332));

    const [assocCurve] = PublicKey.findProgramAddressSync(
      [curve.toBuffer(), new PublicKey(PROGRAM_IDS.splToken).toBuffer(), mint.toBuffer()],
      new PublicKey(PROGRAM_IDS.ataProgram)
    );

    return {
      tag: 'pumpfun_create',
      name,
      symbol,
      uri,
      mint: mint.toString(),
      user: user.toString(),
      bondingCurve: curve.toString(),
      associatedBondingCurve: assocCurve.toString(),
      confidence: 0.97
    };
  } catch (err) {
    console.error('Pump.fun decode error:', err.message);
    return null;
  }
}
