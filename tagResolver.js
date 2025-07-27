// tagResolver.js
import chalk from 'chalk';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { decodeInstruction as decodeSPLInstruction } from '@solana/spl-token';
import config from '../config/index.js';
import { heliusLimiter } from '../utils/limiter.js';
import { withBackoff } from '../utils/backoff.js';
import { PROGRAM_IDS } from './programs.js';
import { calculateSignalScore } from './heliusSocketClient.js';
import fetch from 'node-fetch';

function throttleLimiter() {
  return new Promise((resolve, reject) => {
    heliusLimiter.removeTokens(1, err => err ? reject(err) : resolve());
  });
}
// Fingerprint definitions
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
    instructions: ['Create', 'MintTo', 'SetAuthority', 'CreatePool', 'InitializeImmutableOwner'],
    programs: ['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA'],
    confidence: 0.94,
    logic: 'FUZZY',
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
    const { instructions: expected, logic, programs, minScore = 0 } = fp;
    const normalizedExpected = expected.map(i => i.toLowerCase());
    const matchCount = normalizedExpected
      .filter(instr => normalized.includes(instr) || logText.includes(instr))
      .length;
    const programMatched = programs.some(
      prog =>
        prog.toLowerCase() === programId.toLowerCase() ||
        logText.includes(prog.toLowerCase())
    );
    const score = matchCount + (programMatched ? 1 : 0);

    if (score < minScore) continue;
    if (!programMatched) continue;

    const passes =
      (logic === 'AND' && matchCount === normalizedExpected.length && programMatched) ||
      (logic === 'OR' && (matchCount > 0 || programMatched)) ||
      (logic === 'FUZZY' && matchCount >= Math.ceil(normalizedExpected.length / 2));

    if (passes) return { tag, confidence: fp.confidence, score };
  }

  return null;
}
export async function resolveTag(ix, logs = [], connection) {
  const context = logs.join(' ');
  const rawScore = calculateSignalScore(logs, context);
  const programId = ix?.programId?.toString() || 'unknown';
  const fingerprintMatch = matchFingerprint(logs, [], programId);

  // 🧠 Universal decoder logic — handles both synthetic and live flows
  if (
    fingerprintMatch?.tag === 'pumpfun_create' &&
    logs.some(l => l.includes('Program data:'))
  ) {
    const parsed = await decodePumpFunCreate(logs);
    console.log('[Decode] pumpfun_create parser triggered:', parsed);

    const decodedMint = typeof parsed === 'string' ? parsed : parsed?.mint;
    const confidence = parsed?.confidence || 0.94;
    const tag = parsed?.tag || 'pumpfun_create';

    if (decodedMint) {
      const valid = await isValidMint(decodedMint);
      if (valid) {
        console.log(`✅ Mint confirmed: ${decodedMint}`);
      } else {
        console.warn(`⚠️ Mint ${decodedMint} failed validation — using anyway`);
      }
      return buildTag(tag, confidence, decodedMint, 'decoder');
    }
  }

  // 🧪 Synthetic fallback path (if ix is null and fingerprint didn't match)
  if (!ix && !fingerprintMatch) {
    if (rawScore >= config.SCORE_THRESHOLD) {
      console.log('⚠️ Score-only fallback triggered');
      return buildTag('score_only_fallback', rawScore, 'unknown');
    }
    return null;
  }

  // 🧯 Fingerprint match fallback
  if (fingerprintMatch) {
    console.log(`🔖 Fingerprint matched: ${fingerprintMatch.tag} | Confidence: ${fingerprintMatch.confidence}`);
    return buildTag(fingerprintMatch.tag, fingerprintMatch.confidence, 'unknown', 'main');
  }

  // 🔎 Instruction-level decoding
  try {
    const pid = programId;
    const accounts = ix?.accounts?.map(a => new PublicKey(a)) || [];
    const mint = accounts.find(pk => PublicKey.isOnCurve(pk.toString()))?.toString();
    const data = ix?.data ? bs58.decode(ix.data) : null;

    if ([PROGRAM_IDS.pumpfunLegacy, PROGRAM_IDS.pumpfunVault].includes(pid)) {
      return buildTag('pumpfun_launch', 0.95, mint || 'unknown');
    }

    if ([PROGRAM_IDS.raydiumCPMM, PROGRAM_IDS.launchLab].includes(pid)) {
      await throttleLimiter();
      const raydium = await import('@raydium-io/raydium-sdk-v2').catch(() => null);
      if (raydium?.Liquidity) {
        const decoded = raydium.Liquidity.decodeInstruction({
          programId: new PublicKey(pid),
          keys: accounts,
          data
        });
        if (decoded?.type === 'initializePool') {
          return buildTag('raydium_initPool', 0.98, mint || 'unknown');
        }
      }
    }

    if (pid === PROGRAM_IDS.meteora && logs.some(l => /mint|vault|init/i.test(l))) {
      return buildTag('meteora_initPool', 0.89, mint || 'unknown');
    }

    if (pid === PROGRAM_IDS.splToken) {
      await throttleLimiter();
      const decoded = await withBackoff(
        () => decodeSPLInstruction({ programId: new PublicKey(pid), keys: accounts, data }),
        5,
        'decodeSPLInstruction'
      );
      if (decoded?.instruction === 'InitializeMint') {
        return buildTag('spl_mint_init', 0.96, mint || 'unknown');
      }
    }

    const decodedInstr = data ? await tryDecodeInstruction(pid, accounts, data) : null;
    const matched = matchFingerprint(logs, [decodedInstr], pid);
    if (matched) {
      return buildTag(matched.tag, matched.confidence, mint || 'unknown');
    }

    if (rawScore >= config.SCORE_THRESHOLD) {
      return buildTag('score_only_fallback', rawScore, mint || 'unknown');
    }
  } catch (err) {
    console.error(chalk.red('❌ Resolver error:'), err.message);
  }

  return null;
}
async function tryDecodeInstruction(pid, accounts, data) {
  await throttleLimiter();
  if (pid === PROGRAM_IDS.splToken) {
    try {
      const decoded = await withBackoff(
        () => decodeSPLInstruction({ programId: new PublicKey(pid), keys: accounts, data }),
        5,
        'tryDecodeInstruction'
      );
      return decoded?.instruction;
    } catch {
      return null;
    }
  }
  return null;
}

export async function decodePumpFunCreate(logs = []) {
  const dataLogs = logs.filter(l => l.includes('Program data:'));
  if (dataLogs.length === 0) return null;

  for (const line of dataLogs) {
    const parts = line.split('Program data:');
    if (parts.length < 2) continue;
    const encoded = parts[1].trim();

    let buffer;
    try {
      buffer = Buffer.from(encoded, 'base64');
    } catch {
      continue;
    }

    if (buffer.length >= 340) {
      try {
        const mint = new PublicKey(buffer.slice(244, 276)).toString();
        const confirmed = await isMintOnChain(mint);
        if (confirmed) {
          console.log(`✅ Confirmed mint at fixed offset: ${mint}`);
          return {
            tag: 'pumpfun_create',
            mint,
            confidence: 0.94
          };
        }
      } catch {}
    }

    // Fallback scan
    for (let offset = 0; offset <= buffer.length - 32; offset += 4) {
      if (offset !== 8 && offset !== 244) continue;

      try {
        const candidate = new PublicKey(buffer.slice(offset, offset + 32)).toString();
        const confirmed = await isMintOnChain(candidate);
        if (confirmed) {
          console.log(`✅ Confirmed mint at fallback offset ${offset}: ${candidate}`);
          return candidate;
        }
      } catch (e) {
        console.warn(`⚠️ Error scanning offset ${offset}: ${e.message}`);
      }
    }
  }

  console.warn('❌ No valid mint found');
  return null;
}

// 🚨 Direct RPC validation bypassing SDK
async function isMintOnChain(pubkey) {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "getAccountInfo",
    params: [pubkey, { encoding: "jsonParsed" }]
  };

  try {
    const res = await fetch("https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const result = await res.json();
    const info = result?.result?.value;

    return (
      info?.owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' &&
      info?.data?.parsed?.type === 'mint'
    );
  } catch (e) {
    console.warn(`RPC validation failed: ${e.message}`);
    return false;
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

function buildTag(tag, confidence, mint, source = 'main') {
  const override = source === 'decoder' && mint !== 'unknown';
  if (!override && confidence < config.CONFIDENCE_THRESHOLD) return null;
  return { tag, confidence, mint, source };
}