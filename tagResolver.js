import chalk from 'chalk';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { decodeInstruction as decodeSPLInstruction } from '@solana/spl-token';
import config from '../config/index.js';
import { heliusLimiter } from '../utils/limiter.js';
import { withBackoff } from '../utils/backoff.js';
import { PROGRAM_IDS } from './programs.js';
import { calculateSignalScore } from './heliusSocketClient.js';

// 🔒 Rate limit wrapper
function throttleLimiter() {
  return new Promise((resolve, reject) => {
    heliusLimiter.removeTokens(1, err => err ? reject(err) : resolve());
  });
}

// 🔍 Fingerprint definitions
export const FINGERPRINTS = {
  launch_mint_metadata: {
    instructions: ['MintTo', 'CreateMetadataAccountV3', 'Create', 'initializeMetadataPointer', 'initializeMint'],
    programs: ['splToken', 'tokenMetadata', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'],
    confidence: 0.96,
    minScore: 1.0,
    logic: 'AND',
    requireMetadata: true
  },
  pumpfun_create: {
    instructions: ['Create', 'MintTo', 'BuyExactIn'],
    programs: ['pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'],
    confidence: 0.94,
    logic: 'AND',
    minScore: 0.8
  },
  raydium_initPool: {
    instructions: ['Initialize', 'MintTo', 'BuyExactIn', 'InitializeAccount3'],
    programs: ['LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'],
    confidence: 0.92,
    minScore: 0.8,
    logic: 'AND'
  },
  meteora_initPool: {
    instructions: ['InitializeMint2','InitializeAccount3', 'SetAuthority', 'InitializeVirtualPoolWithSplToken'],
    programs: ['dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'],
    confidence: 1,
    minScore: 1.5,
    logic: 'FUZZY'
  }
};

function matchFingerprint(logs = [], instructions = [], programId = 'unknown') {
  const logText = logs.join(' ').toLowerCase();
  const normalized = instructions.map(i => i?.toLowerCase());

  for (const [tag, fp] of Object.entries(FINGERPRINTS)) {
    const {
      instructions: expected,
      logic,
      programs,
      minScore = 0,
      confidence = 0.9
    } = fp;

    const normalizedExpected = expected.map(i => i.toLowerCase());

    const matchCount = normalizedExpected.filter(instr =>
      normalized.includes(instr) || logText.includes(instr)
    ).length;

    const programMatched = programs.some(prog =>
      prog.toLowerCase() === programId.toLowerCase() || logText.includes(prog.toLowerCase())
    );

    const score = matchCount + (programMatched ? 1 : 0);
    if (score < minScore) continue;
    if (!programMatched) continue;

    const passes =
      (logic === 'AND' && matchCount === normalizedExpected.length && programMatched) ||
      (logic === 'OR' && (matchCount > 0 || programMatched)) ||
      (logic === 'FUZZY' && matchCount >= Math.ceil(normalizedExpected.length / 2));

    if (passes) return { tag, confidence, score };
  }

  return null;
}

// 🗃 Cache for instruction tags
const splTokenCache = new Map();
const CACHE_TTL = 5000;

// 🧪 Raydium SDK dynamic loader
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
        console.error(chalk.redBright('❌ SDK load error:'), err.message);
        return false;
      });
  }
  return raydiumImportPromise;
}

// 🧠 Core resolver
export async function resolveTag(ix, logs = [], connection) {

  const context = logs.join(' ');
  const rawScore = calculateSignalScore(logs, context);

  if (!ix) {
    const inferred = matchFingerprint(logs, [], 'unknown', rawScore);
    if (inferred) {
      console.log('🔖 Log-only fingerprint matched:', inferred.tag);
      return buildTag(inferred.tag, inferred.confidence, 'unknown', logs);
    }

    if (rawScore >= config.SCORE_THRESHOLD) {
      console.log('⚠️ Score-only fallback triggered');
      return buildTag('score_only_fallback', rawScore, 'unknown', logs);
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

    // Legacy pump.fun
    if ([PROGRAM_IDS.pumpfunLegacy, PROGRAM_IDS.pumpfunVault].includes(pid)) {
      const tag = buildTag('pumpfun_launch', 0.95, mint || 'unknown', logs);
      splTokenCache.set(cacheKey, { value: tag, timestamp: Date.now() });
      return tag;
    }

    // Raydium
    if ([PROGRAM_IDS.raydiumCPMM, PROGRAM_IDS.launchLab].includes(pid)) {
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

    // Meteora fuzzy logs
    if (pid === PROGRAM_IDS.meteora && logs.some(l => /mint|vault|init/i.test(l))) {
      const tag = buildTag('meteora_initPool', 0.89, mint || 'unknown', logs);
      splTokenCache.set(cacheKey, { value: tag, timestamp: Date.now() });
      return tag;
    }

    // SPL decode (withBackoff)
    if (pid === PROGRAM_IDS.splToken) {
      await throttleLimiter();
      const decoded = await withBackoff(() =>
        decodeSPLInstruction({ programId: new PublicKey(pid), keys: accounts, data }),
        5,
        'decodeSPLInstruction'
      );

      if (decoded?.instruction === 'InitializeMint') {
        const tag = buildTag('spl_mint_init', 0.96, mint || 'unknown', logs);
        splTokenCache.set(cacheKey, { value: tag, timestamp: Date.now() });
        return tag;
      }
    }

    // Fingerprint match
    const decodedInstr = data ? await tryDecodeInstruction(pid, accounts, data) : null;
    const matched = matchFingerprint(logs, [decodedInstr], pid, rawScore);
    if (matched) {
      const tag = buildTag(matched.tag, matched.confidence, mint || 'unknown', logs);
      splTokenCache.set(cacheKey, { value: tag, timestamp: Date.now() });
      return tag;
    }

    // Score-only fallback
    if (rawScore >= config.SCORE_THRESHOLD) {
      const tag = buildTag('score_only_fallback', rawScore, mint || 'unknown', logs);
      splTokenCache.set(cacheKey, { value: tag, timestamp: Date.now() });
      return tag;
    }
  } catch (err) {
    console.error(chalk.red('❌ Resolver error:'), err.message);
  }

  return null;
}

// 🔍 Safe instruction decoder
async function tryDecodeInstruction(pid, accounts, data) {
  await throttleLimiter();
  try {
    if (pid === PROGRAM_IDS.splToken) {
      const decoded = await withBackoff(() =>
        decodeSPLInstruction({ programId: new PublicKey(pid), keys: accounts, data }),
        5,
        'tryDecodeInstruction'
      );
      return decoded?.instruction;
    }
    return null;
  } catch {
    return null;
  }
}

// 🎯 Pump.fun metadata extractor
export function decodePumpFunCreate(logs) {
  if (!heliusLimiter.tryRemoveTokens(1, true)) return null;

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