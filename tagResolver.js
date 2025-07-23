import chalk from 'chalk';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { decodeInstruction as decodeSPLInstruction } from '@solana/spl-token';
import config from '../config/index.js';
import { heliusLimiter } from '../utils/limiter.js';
import { withBackoff } from '../utils/backoff.js';
import { PROGRAM_IDS } from './programs.js';
import { SIGNAL_WEIGHTS } from './heliusSocketClient.js';

function throttleLimiter() {
  return new Promise((resolve, reject) => {
    heliusLimiter.removeTokens(1, err => err ? reject(err) : resolve());
  });
}

// Caching
const splTokenCache = new Map();
const CACHE_TTL = 5000;

// SDK loader cache
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

export async function resolveTag(ix, logs = [], connection) {
  const context = logs.join(' ').toLowerCase();

  if (!ix) {
    // 🧠 Log-only inference block
    console.log('🧪 Log-only resolver match context:', context);

    if (context.includes('initializemint')) {
      console.log('🔖 Log-only tag matched: spl_mint_init');
      return buildTag('spl_mint_init', 0.96, 'unknown', logs);
    }
    if (context.includes('instruction: create') && context.includes('program data')) {
      console.log('🔖 Log-only tag matched: pumpfun_create');
      return decodePumpFunCreate(logs);
    }
    if (/initializepool|pool created/.test(context)) {
      console.log('🔖 Log-only tag matched: raydium_initPool');
      return buildTag('raydium_initPool', 0.92, 'unknown', logs);
    }
    if (/vault|mint|init/.test(context)) {
      console.log('🔖 Log-only tag matched: meteora_initPool');
      return buildTag('meteora_initPool', 0.89, 'unknown', logs);
    }
    const rawScore = logs.reduce((acc, log) => {
      const lowerLog = log.toLowerCase();
      for (const key in SIGNAL_WEIGHTS) {
        if (lowerLog.includes(key.toLowerCase())) {
          acc += SIGNAL_WEIGHTS[key];
        }
      }
      return acc;
    }, 0);

    if (rawScore >= config.SCORE_THRESHOLD) {
      console.log('⚠️ High signal score detected, but no tag matched. Returning fallback.');
      return buildTag('score_only_fallback', rawScore, 'unknown', logs);
    }

    console.log('🛑 No log-only tag matched. Returning null.');
    return null;
  }

  try {
    // 🧬 Instruction parsing block
    const pid = ix.programId.toString();
    const accounts = ix.accounts?.map(a => new PublicKey(a)) || [];
    const mint = accounts.find(pk => PublicKey.isOnCurve(pk.toString()))?.toString();
    const data = ix.data ? bs58.decode(ix.data) : null;
    const cacheKey = `${pid}:${mint}:${data?.toString()}`;

    console.log('🔍 Instruction resolver → programId:', pid);
    console.log('🔍 Accounts:', accounts.map(pk => pk.toString()));
    console.log('🎯 Mint address extracted:', mint);

    // ✅ Cached result block
    if (splTokenCache.has(cacheKey)) {
      const cached = splTokenCache.get(cacheKey);
      if (Date.now() - cached.timestamp < CACHE_TTL) {
        console.log('💾 Returning cached tag for key:', cacheKey);
        return cached.value;
      }
    }

    // 🚀 Pump.fun block
    if ([PROGRAM_IDS.pumpfunLegacy, PROGRAM_IDS.pumpfunVault].includes(pid)) {
      const tag = buildTag('pumpfun_launch', 0.95, mint || 'unknown', logs);
      console.log('🚀 Pump.fun tag matched:', tag);
      splTokenCache.set(cacheKey, { value: tag, timestamp: Date.now() });
      return tag;
    }

    // 🧪 Raydium block
    if ([PROGRAM_IDS.raydiumCPMM, PROGRAM_IDS.raydiumCLMMv4].includes(pid)) {
      await loadRaydiumSDK();
      if (Liquidity) {
        const decoded = Liquidity.decodeInstruction({
          programId: new PublicKey(pid),
          keys: accounts,
          data
        });

        console.log('🧪 Raydium decoded instruction type:', decoded?.type);

        if (decoded?.type === 'initializePool') {
          const tag = buildTag('raydium_initPool', 0.98, mint || 'unknown', logs);
          console.log('📡 Raydium tag matched:', tag);
          splTokenCache.set(cacheKey, { value: tag, timestamp: Date.now() });
          return tag;
        }
      }
    }

    // 🏦 Meteora vault block
    if (pid === PROGRAM_IDS.meteora && logs.some(l => /mint|vault|init/i.test(l))) {
      const tag = buildTag('meteora_initPool', 0.89, mint || 'unknown', logs);
      console.log('🏦 Meteora tag matched:', tag);
      splTokenCache.set(cacheKey, { value: tag, timestamp: Date.now() });
      return tag;
    }

    // 💉 SPL Token block
    if (pid === PROGRAM_IDS.splToken) {
      if (!heliusLimiter.tryRemoveTokens(1, true)) {
        console.warn(chalk.yellow('⚠️ SPL decode rate limited'));
        return null;
      }

      const decoded = await withBackoff(() =>
        decodeSPLInstruction({ programId: new PublicKey(pid), keys: accounts, data })
      );

      console.log('🧪 SPL decode result:', decoded?.instruction);

      if (decoded?.instruction === 'InitializeMint') {
        const tag = buildTag('spl_mint_init', 0.96, mint || 'unknown', logs);
        console.log('💉 SPL tag matched:', tag);
        splTokenCache.set(cacheKey, { value: tag, timestamp: Date.now() });
        return tag;
      }
    }
  } catch (err) {
    console.log(chalk.redBright('❌ Instruction resolver failed:'), err.message);
  }

  // 🛑 No match fallback
  console.log('🛑 No resolver matched this trace. Returning null.');
  return null;
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