import EventEmitter from 'events';
import { Connection, PublicKey } from '@solana/web3.js';
import { RateLimiter } from 'limiter';
import { telemetry } from './utils/telemetry.js';
import config from './config/index.js';
import solanaLogListener from './solanaLogListener.js';
import { logger } from './utils/logger.js';

//pumpfun is first decoded directly from tagged logs (pumpfun_create) like in this snippet bellow, copy the idea
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
      if (fixedMint.toLowerCase().endsWith('pump')) {
        return {
          tag: 'pumpfun_create',
          mint: fixedMint,
          confidence: 0.94
        };
      }
    } catch {}

    for (let offset = 0; offset <= buffer.length - 32; offset++) {
      try {
        const candidateMint = new PublicKey(buffer.slice(offset, offset + 32)).toString();
        if (candidateMint.toLowerCase().endsWith('pump')) {
          return {
            tag: 'pumpfun_create',
            mint: candidateMint,
            confidence: 0.94
          };
        }
      } catch {}
    }
  }

  return null;
}

function extractMintAddress({ meta, transaction }) {
  const knownNonMints = new Set([
    'So11111111111111111111111111111111111111112',
    '11111111111111111111111111111111',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ]);

  const message = transaction.message;

  const allAccountKeys = [
    ...(message.staticAccountKeys || []),
    ...(message.loadedAddresses?.writable || []),
    ...(message.loadedAddresses?.readonly || [])
  ].map(k => k.toString());

  const allInstructions = [
    ...(message.compiledInstructions || []),
    ...(meta?.innerInstructions?.flatMap(i => i.instructions) || [])
  ];

  for (const ix of allInstructions) {
    const programId = allAccountKeys[ix.programIdIndex];
    if (programId !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') continue;

    const possibleMintIndex = ix.accounts?.[0];
    const possibleMint = allAccountKeys[possibleMintIndex];

    if (possibleMint && !knownNonMints.has(possibleMint)) {
      return possibleMint;
    }
  }

  return null;
}

export async function decodePumpfun(signature) {
  try {
    logger.info(`🔍 Fetching transaction for signature: ${signature}`);

    const txn = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (!txn) throw new Error(`Transaction not found for signature: ${signature}`);

    const keys = Object.keys(txn);
    logger.info('📦 Raw txn keys:', keys);

    const message = txn.transaction?.message;
    if (!message) throw new Error(`Missing transaction.message`);

    logger.info('📦 txn.transaction keys:', Object.keys(txn.transaction));
    logger.info('📦 txn.message keys:', Object.keys(message));

    const logs = txn.meta?.logMessages || [];

    const allAccountKeys = [
      ...(message.staticAccountKeys || []),
      ...(message.loadedAddresses?.writable || []),
      ...(message.loadedAddresses?.readonly || [])
    ].map(k => k.toString());

    if (!allAccountKeys || allAccountKeys.length === 0) {
      logger.error('❌ txn.transaction.message.accountKeys is missing');
      throw new Error('Malformed transaction: txn.transaction.message.accountKeys is missing');
    }

    const transactionInfo = {
      slot: txn.slot,
      blockTime: txn.blockTime,
      meta: txn.meta,
      accounts: allAccountKeys,
      signature,
    };

    const mintAddress = extractMintAddress(txn);
        const result = {
      mintAddress,
      transactionInfo,
      platform: 'pump.fun',
      createdAt: new Date().toISOString()
    };

    logger.info('✅ Successfully decoded pump.fun transaction:', result);
    return result;

  } catch (err) {
    logger.error('❌ Failed to decode pump.fun transaction:', err.message);
    throw err;
  }
}

function extractRaydiumMintAddress({ meta }) {
  if (!meta?.postTokenBalances || meta.postTokenBalances.length === 0) {
    return null;
  }

  for (const token of meta.postTokenBalances) {
    const amt = token.uiTokenAmount?.uiAmount;
    if (amt && amt > 0) {
      return token.mint;
    }
  }

  return null;
}

export async function decodeRaydium(signature) {
  try {
    logger.info(`🔍 Fetching transaction for signature: ${signature}`);

    const txn = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (!txn) throw new Error(`Transaction not found for signature: ${signature}`);

    const message = txn.transaction?.message;
    if (!message) throw new Error(`Missing transaction.message`);

    logger.info('📦 txn.transaction keys:', Object.keys(txn.transaction));
    logger.info('📦 txn.message keys:', Object.keys(message));

    const logs = txn.meta?.logMessages || [];

    const allAccountKeys = [
      ...(message.staticAccountKeys || []),
      ...(message.loadedAddresses?.writable || []),
      ...(message.loadedAddresses?.readonly || [])
    ].map(k => k.toString());

    if (!allAccountKeys || allAccountKeys.length === 0) {
      logger.error('❌ txn.transaction.message.accountKeys is missing');
      throw new Error('Malformed transaction: txn.transaction.message.accountKeys is missing');
    }

    const transactionInfo = {
      slot: txn.slot,
      blockTime: txn.blockTime,
      meta: txn.meta,
      accounts: allAccountKeys,
      signature,
    };
    const mintAddress = extractRaydiumMintAddress(txn);

    const result = {
      mintAddress,
      transactionInfo,
      platform: 'raydium',
      createdAt: new Date().toISOString()
    };

    logger.info('✅ Successfully decoded Raydium transaction:', result);
    return result;

  } catch (err) {
    logger.error('❌ Failed to decode Raydium transaction:', err.message);
    throw new Error(`Raydium Decode Error: ${err.message}`);
  }
}

function extractMeteoraMintAddress({ meta }) {
  if (!meta?.postTokenBalances) return null;

  for (const balance of meta.postTokenBalances) {
    const amount = balance.uiTokenAmount?.uiAmount;
    if (amount && amount > 0) {
      return balance.mint;
    }
  }

  return null;
}
export async function decodeMeteora(signature) {
  try {
    logger.info(`🔍 Fetching transaction for signature: ${signature}`);

    const txn = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (!txn) throw new Error(`Transaction not found for signature: ${signature}`);

    const message = txn.transaction?.message;
    if (!message) throw new Error(`Missing transaction.message`);

    logger.info('📦 txn.transaction keys:', Object.keys(txn.transaction));
    logger.info('📦 txn.message keys:', Object.keys(message));

    const logs = txn.meta?.logMessages || [];

    const allAccountKeys = [
      ...(message.staticAccountKeys || []),
      ...(message.loadedAddresses?.writable || []),
      ...(message.loadedAddresses?.readonly || [])
    ].map(k => k.toString());

    if (!allAccountKeys.length) {
      throw new Error('Missing account keys from transaction');
    }

    const transactionInfo = {
      slot: txn.slot,
      blockTime: txn.blockTime,
      meta: txn.meta,
      accounts: allAccountKeys,
      signature,
    };

    const mintAddress = extractMeteoraMintAddress(txn);

    const result = {
      mintAddress,
      transactionInfo,
      platform: 'meteora',
      createdAt: new Date().toISOString()
    };

    logger.info('✅ Successfully decoded Meteora transaction:', result);
    return result;

  } catch (err) {
    logger.error('❌ Failed to decode Meteora transaction:', err.message);
    throw new Error(`Meteora Decode Error: ${err.message}`);
  }
}
