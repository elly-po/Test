import { WebSocket } from 'ws';
import dotenv from 'dotenv';
import chalk from 'chalk';
import { Connection } from '@solana/web3.js';
import config from '../config/index.js';
import { loadKeypair } from '../utils/keypairLoader.js';
import { SnipeEngine } from '../core/snipeEngine.js';
import { resolveTag, decodePumpFunCreate, getDexForTag } from './tagResolver.js';
import { heliusLimiter } from '../utils/limiter.js';
import { STRATEGIES, DEFAULT_STRATEGY } from '../config/strategies.js';
import { telemetry } from '../utils/telemetry.js';
import { PROGRAM_IDS, SUBSCRIBED_PROGRAMS, getProgramAlias } from './programs.js';
import { withBackoff } from '../utils/backoff.js';
import { isValidMint } from '../utils/validation.js';

dotenv.config();

const HELIUS_WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${config.HELIUS_API_KEY}`;
const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');
const ACTIVE_STRATEGY = STRATEGIES[config.SNIPE_STRATEGY] || STRATEGIES[DEFAULT_STRATEGY];

export const SIGNAL_WEIGHTS = {
  CreatePool: 0.4,
  InitializeMint: 0.4,
  InitializeMint2: 0.3,
  InitializeMetadataPointer: 0.3,
  InitializeVirtualPoolWithSplToken: 0.5,
  UpdateMetadataAccountV2: 0.3,
  InitializeTokenMetadata: 0.3,
  CreateMetadataAccountV3: 0.4,
  OpenPositionV2: 0.3,
  MintTo: 0.4,
  SetAuthority: 0.3,
  AddLiquidity: 0.3,
  BuyExactIn: 0.2,
  Initialize2: 0.4,
  CreateIdempotent: 0.3,
  CreateAccountWithSeed: 0.3,
  Initialize: 0.3,
  InitializeAccount: 0.1,
  InitializeAccount3: 0.1,
  InitializeImmutableOwner: 0.1,
  SyncNative: 0.2,
  CreateAccount: 0.1,
  Burn: 0.2,
  CloseAccount: 0.05,
  TransferChecked: 0.05,
  Create: 1,
  LockCpLiquidity: 0.4,
  MigrateToCpswap: 0.4,
  GetAccountDataSize: 0.05
};
export async function injectLogString(rawLogString) {
  const logs = rawLogString
    .split('|')
    .map(l => l.trim())
    .filter(l => l.length > 0);

  const slot = await getCachedSlot();
  const fakeMessage = {
    params: {
      result: {
        context: { slot },
        value: {
          logs,
          programId: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'
        },
        signature: 'synthetic_' + Date.now() + '_' + Math.random()
      }
    }
  };

  ws.emit('message', JSON.stringify(fakeMessage));
  console.log(`🌀 Injected ${logs.length} logs at slot ${slot}`);
}

export function calculateSignalScore(logs = [], context = '') {
  const lowerContext = context.toLowerCase();

  return logs.reduce((acc, log) => {
    const lowerLog = log.toLowerCase();

    if (lowerLog.includes('buyexactin')) {
      acc += lowerContext.includes('mintto') || lowerContext.includes('initializemint') ? 0.6 : 0.2;
    }
    if (lowerLog.includes('mintto')) {
      acc += lowerContext.includes('Initializevirtualpoolwithspltoken') || lowerContext.includes('initializemint2') ? 0.7 : 0.4;
    }

    for (const key in SIGNAL_WEIGHTS) {
      if (lowerLog.includes(key.toLowerCase())) {
        acc += SIGNAL_WEIGHTS[key];
      }
    }

    return acc;
  }, 0);
}

const signalStats = {};
Object.entries(PROGRAM_IDS).forEach(([alias]) => {
  signalStats[alias] = { matches: 0, failures: 0, unresolved: 0, received: 0 };
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

function throttle() {
  return new Promise((resolve, reject) => {
    heliusLimiter.removeTokens(1, err => err ? reject(err) : resolve());
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

    SUBSCRIBED_PROGRAMS.forEach((key, id) => {
      setTimeout(() => {
        try {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'logsSubscribe',
            params: [{ mentions: [key] }, { commitment: 'confirmed' }]
          }));
          console.log(chalk.gray(`📡 Subscribed to logs for ${getProgramAlias(key)}`));
        } catch (err) {
          console.error(chalk.redBright(`❌ Subscription error for ${getProgramAlias(key)}:`), err.message);
        }
      }, id * 500);
    });
  });

  ws.on('message', async msg => {
    let sourceAlias = 'Unknown';
    if (!heliusLimiter.tryRemoveTokens(1, true)) {
      console.warn(chalk.yellow('⚠️ Message rate limited'));
      return;
    }

    try {
      const parsed = JSON.parse(msg);
      const result = parsed?.params?.result;
      const logs = result?.value?.logs || [];
      const errorRegex = /Program log: (Error|error):|failed:|panic|custom program error/i;
      const errorLogs = logs.filter(log => errorRegex.test(log));
      const cleanLogs = logs.filter(log => !errorRegex.test(log));
      const sig = result?.signature || `slot-${result?.context?.slot}`;
      const slot = result?.context?.slot || 0;
      const sourceKey = result?.value?.programId || 'unknown';
      sourceAlias = getProgramAlias(sourceKey);

      signalStats[sourceAlias] ||= { matches: 0, failures: 0, unresolved: 0, received: 0 };
      signalStats[sourceAlias].received++;

      if (processedSigs.has(sig)) return;
      processedSigs.set(sig, Date.now());

      const currentSlot = await getCachedSlot();
      if (currentSlot - slot > config.STALE_SLOT_THRESHOLD) return;

      const instructionRegex = /Instruction:\s+([\w]+)/;
      const joinedLogs = logs.join(' | ');
      console.log(`🧠 TRACE | Slot: ${slot} | Logs: ${logs.length} | Sig: ${sig}`);
      console.log(`🔖 Full joined logs:\n${joinedLogs}`);
      

      const contributingLogs = logs
        .filter(log => instructionRegex.test(log))
        .map(log => {
          const matched = instructionRegex.exec(log)?.[1];
          const weight = SIGNAL_WEIGHTS[matched];
          return `${chalk.white(log)} ${chalk.dim(`← ${matched || '—'} [${weight || '—'}]`)}`;
        });
      
      const context = cleanLogs.join(' '); 
      const score = calculateSignalScore(cleanLogs, context);
      if (score >= config.SCORE_THRESHOLD) {
        console.log(chalk.yellowBright(`👀 Potential launch | Score: ${score.toFixed(2)} | Slot: ${slot}`));
        console.log(chalk.gray(`📎 Contributing logs:\n${contributingLogs.join('\n')}`));
      }

      const tagInfo = await withBackoff(() => resolveTag(null, logs, connection), 5, `resolveTag:${sig}`);
      console.log('🔍 Tag resolution result:', tagInfo);

      if (!tagInfo || tagInfo.confidence < config.CONFIDENCE_THRESHOLD) {
        signalStats[sourceAlias].unresolved++;
        telemetry.logUnresolvedTag({ programId: sourceAlias, logs, slot, signature: sig });
        console.log('⛔ Skipping: Tag not confident enough.');
        return;
      }

      signalStats[sourceAlias].matches++;
      telemetry.logSnipeAttempt({
        tag: tagInfo.tag,
        mint: tagInfo.mint,
        confidence: Math.round(tagInfo.confidence * 100) / 100,
        ACTIVE_STRATEGY,
        signature: sig
      });

      console.log(chalk.bold.cyan(`\n🔖 Launch Detected:`) +
        chalk.magenta(` [${tagInfo.tag}] `) +
        `Mint: ${chalk.blue(tagInfo.mint)} | Confidence: ${chalk.green(tagInfo.confidence.toFixed(2))}`);
      console.log(`📡 Telemetry logged for tag: ${tagInfo.tag}`);

      
      if (!isValidMint(tagInfo.mint)) {
        console.warn(`❌ Invalid mint — skipping snipe. Mint: ${tagInfo.mint}`);
        return;
      }
      
      await withBackoff(() => snipeEngine.executeSnipe({
        ...tagInfo,
        dex: getDexForTag(tagInfo.tag),
        amountInSol: config.AMOUNT_IN_SOL
      }), 5, `executeSnipe:${sig}`); 
      console.log(chalk.greenBright(`🎯 Snipe triggered | Tag: ${tagInfo.tag} | Confidence: ${tagInfo.confidence}`));
    
    } catch (err) {
      signalStats[sourceAlias] ||= { matches: 0, failures: 0, unresolved: 0, received: 0 };
      signalStats[sourceAlias].failures++;
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
setTimeout(() => {
  injectLogString(`Program ComputeBudget111111111111111111111111111111 invoke [1] | Program ComputeBudget111111111111111111111111111111 success | Program ComputeBudget111111111111111111111111111111 invoke [1] | Program ComputeBudget111111111111111111111111111111 success | Program 11111111111111111111111111111111 invoke [1] | Program 11111111111111111111111111111111 success | Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1] | Program log: Instruction: Create | Program 11111111111111111111111111111111 invoke [2] | Program 11111111111111111111111111111111 success | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2] | Program log: Instruction: InitializeMint2 | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 2780 of 238374 compute units | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success | Program 11111111111111111111111111111111 invoke [2] | Program 11111111111111111111111111111111 success | Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL invoke [2] | Program log: Create | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [3] | Program log: Instruction: GetAccountDataSize | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 1595 of 217802 compute units | Program return: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA pQAAAAAAAAA= | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success | Program 11111111111111111111111111111111 invoke [3] | Program 11111111111111111111111111111111 success | Program log: Initialize the associated token account | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [3] | Program log: Instruction: InitializeImmutableOwner | Program log: Please upgrade to SPL Token 2022 for immutable owner support | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 1405 of 211189 compute units | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [3] | Program log: Instruction: InitializeAccount3 | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 4214 of 207305 compute units | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success | Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL consumed 20490 of 223277 compute units | Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL success | Program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s invoke [2] | Program log: IX: Create Metadata Accounts v3 | Program 11111111111111111111111111111111 invoke [3] | Program 11111111111111111111111111111111 success | Program log: Allocate space for the account | Program 11111111111111111111111111111111 invoke [3] | Program 11111111111111111111111111111111 success | Program log: Assign the account to the owning program | Program 11111111111111111111111111111111 invoke [3] | Program 11111111111111111111111111111111 success | Program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s consumed 38397 of 189747 compute units | Program metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s success | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2] | Program log: Instruction: MintTo | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 4492 of 148732 compute units | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2] | Program log: Instruction: SetAuthority | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 2911 of 142009 compute units | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success | Program data: G3KpTd7rY3YJAAAASGF3ayBUdWFoBQAAACRIQVdLQwAAAGh0dHBzOi8vaXBmcy5pby9pcGZzL1FtZXdVS1h5U21KdHFkaVlWS3VhWmEyOTZoSEV1c0NSRnA5dWl2VTlrQ3FvR1RIw6A0Ls+ejAFty+W3liPAPubySR95Ta0Afaw752NjD5eJAlE5CDi7/aafF+Nfr434eCxU63bzPvpkvBZaUBXAPaHBn2oHQGNMbcbcQO4l/0wkIiyIZGlIpXWcdJMW5VE9ocGfagdAY0xtxtxA7iX/TCQiLIhkaUildZx0kxblUVw+hWgAAAAAABDYR+PPAwAArCP8BgAAAAB4xftR0QIAAIDGpH6NAwA= | Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [2] | Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P consumed 2009 of 133176 compute units | Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success | Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P consumed 119246 of 249550 compute units | Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success | Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL invoke [1] | Program log: CreateIdempotent | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2] | Program log: Instruction: GetAccountDataSize | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 1569 of 124903 compute units | Program return: TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA pQAAAAAAAAA= | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success | Program 11111111111111111111111111111111 invoke [2] | Program 11111111111111111111111111111111 success | Program log: Initialize the associated token account | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2] | Program log: Instruction: InitializeImmutableOwner | Program log: Please upgrade to SPL Token 2022 for immutable owner support | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 1405 of 118316 compute units | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2] | Program log: Instruction: InitializeAccount3 | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 4188 of 114436 compute units | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success | Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL consumed 20339 of 130304 compute units | Program ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL success | Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1] | Program log: Instruction: Buy | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2] | Program log: Instruction: Transfer | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 4645 of 90310 compute units | Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success | Program 11111111111111111111111111111111 invoke [2] | Program 11111111111111111111111111111111 success | Program 11111111111111111111111111111111 invoke [2] | Program 11111111111111111111111111111111 success | Program 11111111111111111111111111111111 invoke [2] | Program 11111111111111111111111111111111 success | Program data: vdt/007mYe5Iw6A0Ls+ejAFty+W3liPAPubySR95Ta0Afaw752NjD4h2SwAAAAAAWGF3LSkAAAABPaHBn2oHQGNMbcbcQO4l/0wkIiyIZGlIpXWcdJMW5VFcPoVoAAAAAIgib/wGAAAAqK5gGrrPAwCIdksAAAAAAKgWTs4o0QIArRHmpPwpRKT6glG++BVCbhv7KMa2ZGZ3YHxq2fVmpkZfAAAAAAAAAIe3AAAAAAAAPaHBn2oHQGNMbcbcQO4l/0wkIiyIZGlIpXWcdJMW5VEFAAAAAAAAAKkJAAAAAAAA | Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [2] | Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P consumed 2009 of 74156 compute units | Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success | Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P consumed 38654 of 109965 compute units | Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P success`);
}, 5000); // wait 5 seconds for slot to sync

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
