import { WebSocket } from 'ws';
import dotenv from 'dotenv';
import chalk from 'chalk';
import { Connection } from '@solana/web3.js';
import config from '../config/index.js';
import { loadKeypair } from '../utils/keypairLoader.js';
import { SnipeEngine } from '../core/snipeEngine.js';
import { decodePumpFunCreate, resolveTag, getDexForTag } from './tagResolver.js';
import { heliusLimiter } from '../utils/limiter.js';
import { STRATEGIES, DEFAULT_STRATEGY } from '../config/strategies.js';
import { telemetry } from '../utils/telemetry.js';

dotenv.config();

const HELIUS_WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
const ACTIVE_STRATEGY = STRATEGIES[config.SNIPE_STRATEGY] || STRATEGIES[DEFAULT_STRATEGY];

const PROGRAM_IDS = [
  { label: 'Raydium CPMM', id: 201, key: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C' },
  { label: 'Pump.fun AMM', id: 202, key: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' },
  { label: 'Solana Token Program', id: 203, key: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
  { label: 'Raydium CLMM V4', id: 204, key: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8' }
];

const SIGNAL_WEIGHTS = {
  'Create_pool': 0.5,
  'InitializeMint': 0.4,
  'CreateMetadataAccountV3': 0.5,
  'SetAuthority': 0.5,
  'MintTo': 0.4,
  'AddLiquidity': 0.4,
  'Initialize2': 0.4,
  'CreateIdempotent': 0.3,
  'Initialize': 0.3,
  'InitializeAccount': 0.2,
  'CreateAccountWithSeed': 0.3,
  'Burn': 0.2,
  'InitializeImmutableOwner': 0.1,
  'TransferChecked': 0.05,
  'CloseAccount': 0.05,
  'Create': 0.05,
  'CreateAccount': 0.1,
  'SyncNative': 0.2,
  'InitializeAccount3': 0.1,
  'GetAccountDataSize': 0.05
};


const signalStats = {};
PROGRAM_IDS.forEach(({ label }) => {
  signalStats[label] = {
    matches: 0,
    failures: 0,
    unresolved: 0,
    received: 0
  };
});

let payerKeypair, snipeEngine;
try {
  payerKeypair = loadKeypair();
  snipeEngine = new SnipeEngine(connection, payerKeypair, ACTIVE_STRATEGY);
  console.log(chalk.green('✅ Snipe engine initialized'));
} catch (err) {
  console.error(chalk.redBright('❌ Engine init failed:'), err.message);
  process.exit(1);
}

async function throttle() {
  return new Promise((resolve, reject) => {
    heliusLimiter.removeTokens(1, err => {
      if (err) return reject(err);
      resolve();
    });
  });
}

let cachedSlot = { value: 0, lastUpdated: 0 };
async function getCachedSlot() {
  await throttle();
  const now = Date.now();
  if (now - cachedSlot.lastUpdated > 1000) {
    cachedSlot.value = await withBackoff(() => connection.getSlot(), 5, 'getSlot');
    cachedSlot.lastUpdated = now;
  }
  return cachedSlot.value;
}

export async function withBackoff(fn, maxRetries = 5, fnName = 'unknown') {
  let delay = 500;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err.message?.includes('429')) {
        console.warn(`[BACKOFF][${fnName}] Rate limit. Retrying in ${delay}ms...`);
        await new Promise(res => setTimeout(res, delay + Math.random() * 150));
        delay *= 2;
      } else throw err;
    }
  }
  throw new Error(`[${fnName}] Max retries reached.`);
}

function createWebSocket() {
  let reconnectDelay = 1000;
  let reconnectAttempts = 0;
  const processedSigs = new Map();

  const ws = new WebSocket(HELIUS_WS_URL);

  setInterval(() => {
    for (const [sig, timestamp] of processedSigs.entries()) {
      if (Date.now() - timestamp > 60000) {
        processedSigs.delete(sig);
      }
    }
  }, 10000);

  ws.on('open', () => {
    reconnectDelay = 1000;
    reconnectAttempts = 0;
    console.log(chalk.cyanBright('🔌 Connected to Helius WebSocket'));

    PROGRAM_IDS.forEach(({ id, key, label }, i) => {
      setTimeout(() => {
        try {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'logsSubscribe',
            params: [{ mentions: [key] }, { commitment: 'confirmed' }]
          }));
          console.log(chalk.gray(`📡 Subscribed to logs for ${label}`));
        } catch (err) {
          console.error(chalk.redBright(`❌ Subscription error for ${label}:`), err.message);
        }
      }, i * 500);
    });
  });

  ws.on('message', async msg => {
    let sourceLabel = 'Unknown';
    if (!heliusLimiter.tryRemoveTokens(1, true)) {
      console.warn(chalk.yellow('⚠️ Message rate limited'));
      return;
    }

    try {
      const parsed = JSON.parse(msg);
      const result = parsed?.params?.result;
      const logs = result?.value?.logs || [];
      const sig = result?.signature || `slot-${result?.context?.slot}`;
      const slot = result?.context?.slot || 0;
      const sourceId = parsed?.id;
      if (!sourceId) {
        console.log(`⚠️ [TRACE] Missing sourceId for incoming message`);
      }
      console.log(`🧠 TRACE | Slot: ${slot} | Logs: ${logs.length} | Sig: ${sig}`);

      const sourceLabel = PROGRAM_IDS.find(p => p.id === sourceId)?.label || 'Unknown';
      if (!signalStats[sourceLabel]) {
        signalStats[sourceLabel] = { matches: 0, failures: 0, unresolved: 0, received: 0 };
      }

      signalStats[sourceLabel].received++;
      if (processedSigs.has(sig)) return;
      processedSigs.set(sig, Date.now());

      const currentSlot = await getCachedSlot();
      const delta = currentSlot - slot;
      if (delta > config.STALE_SLOT_THRESHOLD) return;

      const joinedLogs = logs.join(' | ');
      console.log(`🔖 Full joined logs:\n${joinedLogs}`);

      const score = logs.reduce((acc, log) => {
        for (const key in SIGNAL_WEIGHTS) {
          if (log.includes(key)) acc += SIGNAL_WEIGHTS[key];
        }
        return acc;
      }, 0);

      const instructionRegex = /Instruction:\s+([a-zA-Z0-9_]+)/;
      const contributingLogs = logs
        .filter(log => instructionRegex.test(log))
        .map(log => {
          const matchedInstruction = instructionRegex.exec(log)?.[1];
          const weight = SIGNAL_WEIGHTS[matchedInstruction];
          const weightNote = weight ? `${matchedInstruction} [${weight}]` : '—';
          return `${chalk.white(log)} ${chalk.dim(`← ${weightNote}`)}`;
        });

      if (score >= config.CONFIDENCE_THRESHOLD) {
        console.log(chalk.yellowBright(`👀 Potential launch | Score: ${score.toFixed(2)} | Slot: ${slot}`));
        console.log(chalk.gray(`📎 Contributing logs:\n${contributingLogs.join('\n')}`));
      }

      let tagInfo = sourceLabel === 'Pump.fun AMM'
        ? decodePumpFunCreate(logs)
        : await withBackoff(() => resolveTag(null, logs, connection), 5, `resolveTag:${sig}`);

      if (!tagInfo || tagInfo.confidence < config.CONFIDENCE_THRESHOLD) {
        signalStats[sourceLabel].unresolved++;
        telemetry.logUnresolvedTag({ programId: sourceLabel, logs, slot, signature: sig });
        return;
      }

      signalStats[sourceLabel].matches++;
      telemetry.logSnipeAttempt({
        tag: tagInfo.tag,
        mint: tagInfo.mint,
        confidence: tagInfo.confidence,
        ACTIVE_STRATEGY,
        signature: sig
      });

      console.log(chalk.bold.cyan(`\n🔖 Launch Detected:`) +
        chalk.magenta(` [${tagInfo.tag}] `) +
        `Mint: ${chalk.blue(tagInfo.mint)} | Confidence: ${chalk.green(tagInfo.confidence.toFixed(2))}`);

      await withBackoff(() =>
        snipeEngine.executeSnipe({
          ...tagInfo,
          dex: getDexForTag(tagInfo.tag),
          amountInSol: config.AMOUNT_IN_SOL
        }), 5, `executeSnipe:${sig}`
      );
    } catch (err) {
      signalStats[sourceLabel].failures++;
      console.error(chalk.redBright('❌ Socket error:'), err.message);
    }
  });

  ws.on('error', err => {
    console.error(chalk.redBright('❌ WS Error:'), err.message);
  });

  ws.on('close', () => {
    reconnectAttempts++;
    reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    console.warn(chalk.yellowBright(
      `⚠️ WebSocket closed. Reconnecting in ${reconnectDelay}ms... (Attempt ${reconnectAttempts})`
    ));
    setTimeout(createWebSocket, reconnectDelay + Math.random() * 1000); // ⏱ Add jitter here
  });

  return ws;
}

const ws = createWebSocket();

setInterval(() => {
  const timestamp = new Date().toLocaleTimeString();
  console.log(chalk.gray(`💓 ${timestamp} | Telemetry:`));
  Object.entries(signalStats).forEach(([label, stats]) => {
    console.log(
      chalk.bold(label.padEnd(20)) +
      `→ Received: ${chalk.white(stats.received)} | Matched: ${chalk.green(stats.matches)} | Unresolved: ${chalk.yellow(stats.unresolved)} | Failures: ${chalk.red(stats.failures)}`
    );
  });
}, 10000);

process.on('SIGINT', () => {
  console.log(chalk.redBright('\n🛑 Graceful shutdown...'));
  ws.close();
  process.exit(0);
});
