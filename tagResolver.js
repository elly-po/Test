// tagResolver.js
import chalk from 'chalk';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import config from '../config/index.js';
import { heliusLimiter } from '../utils/limiter.js';
import { withBackoff } from '../utils/backoff.js';
import { PROGRAM_IDS } from './programs.js';
import { calculateSignalScore } from './heliusSocketClient.js';
import fetch from 'node-fetch';

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

export async function resolveTag(logs = []) {
  const context = logs.join(' ');
  const rawScore = calculateSignalScore(logs, context);
  const programLogLine = logs.find(l => l.includes('Program log:'));
  const programId = programLogLine?.split('Program log:')[1]?.trim() || 'unknown';

  const fingerprintMatch = matchFingerprint(logs, [], programId);

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
      const valid = await validateMintCandidate(decodedMint);
      if (valid) {
        console.log(`✅ Mint confirmed: ${decodedMint}`);
      } else {
        console.warn(`⚠️ Mint ${decodedMint} failed validation — using anyway`);
      }
      return buildTag(tag, confidence, decodedMint, 'decoder');
    }
  }

  if (!fingerprintMatch && rawScore >= config.SCORE_THRESHOLD) {
    console.log('⚠️ Score-only fallback triggered');
    return buildTag('score_only_fallback', rawScore, 'unknown');
  }

  if (fingerprintMatch) {
    console.log(`🔖 Fingerprint matched: ${fingerprintMatch.tag} | Confidence: ${fingerprintMatch.confidence}`);
    return buildTag(fingerprintMatch.tag, fingerprintMatch.confidence, 'unknown', 'main');
  }

  return null;
}

export async function decodePumpFunCreate(logs = []) {
  const dataLogs = logs.filter(log => log.toLowerCase().includes('program data:'));
  if (dataLogs.length === 0) return null;

  for (const line of dataLogs) {
    const match = line.split(/program data:/i);
    if (match.length < 2) continue;

    const encoded = match[1].trim();
    if (!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      continue;
    }

    let buffer;
    try {
      buffer = Buffer.from(encoded, 'base64');
    } catch {
      continue;
    }

    try {
      const fixedOffset = 8;
      const fixedMint = new PublicKey(buffer.slice(fixedOffset, fixedOffset + 32)).toString();
      const confirmed = await validateMintCandidate(fixedMint);
      if (confirmed) {
        return {
          tag: 'pumpfun_create',
          mint: fixedMint,
          confidence: 0.94
        };
      }
    } catch {}

    const offsetTelemetry = [];
    let failureCount = 0;

    for (let offset = 0; offset <= buffer.length - 32; offset++) {
      try {
        const candidateMint = new PublicKey(buffer.slice(offset, offset + 32)).toString();
        const confirmed = await validateMintCandidate(candidateMint);
        offsetTelemetry.push({ offset, candidateMint, confirmed });

        if (confirmed) {
          return {
            tag: 'pumpfun_create',
            mint: candidateMint,
            confidence: 0.94
          };
        } else {
          failureCount++;
          if (failureCount > 20) break;
        }
      } catch (e) {
        offsetTelemetry.push({ offset, error: e.message });
      }
    }
  }

  return null;
}

const checkedMints = new Map();

export async function validateMintCandidate(pubkeyStr) {
  if (checkedMints.has(pubkeyStr)) return checkedMints.get(pubkeyStr);

  await new Promise((resolve, reject) => {
    heliusLimiter.removeTokens(1, err => {
      if (err) return reject(err);
      resolve();
    });
  });

  const result = await withBackoff(async () => {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "getAccountInfo",
      params: [pubkeyStr, { encoding: "jsonParsed" }]
    };

    const res = await fetch("https://api.mainnet-beta.solana.com", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const info = await res.json();
    const data = info?.result?.value?.data;

    const isValid =
      info?.result?.value?.owner === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' &&
      data?.parsed?.type === 'mint';

    checkedMints.set(pubkeyStr, isValid);
    return isValid;
  });

  return result;
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