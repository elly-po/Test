// raydiumDecoder.js

import { Connection } from '@solana/web3.js';
import { logger } from './logger.js';

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

/**
 * Extracts a mint address by scanning all instructions for token-related accounts.
 */
function extractRaydiumMintAddress({ meta, transaction }) {
  const knownNonMints = new Set([
    '11111111111111111111111111111111',
    'So11111111111111111111111111111111111111112',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    'SysvarRent111111111111111111111111111111111'
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
    for (const idx of ix.accounts || []) {
      const account = allAccountKeys[idx];
      if (account && !knownNonMints.has(account) && account.length === 44) {
        return account;
      }
    }
  }

  return null;
}

/**
 * Extracts pool data heuristically from logs.
 */
function extractPoolData(logs) {
  const data = {};

  for (const log of logs) {
    const poolMatch = log.match(/pool:\s*([A-Za-z0-9]{32,44})/i);
    if (poolMatch) {
      data.poolAddress = poolMatch[1];
    }

    const liquidityMatch = log.match(/liquidity:\s*(\d+)/i);
    if (liquidityMatch) {
      data.initialLiquidity = parseInt(liquidityMatch[1], 10);
    }
  }

  return data;
}

/**
 * Extracts name/symbol if logs contain them (rare for Raydium).
 */
function extractTokenMetadata(logs) {
  const meta = {};

  for (const log of logs) {
    const nameMatch = log.match(/name:\s*"([^"]+)"/i);
    if (nameMatch) {
      meta.name = nameMatch[1];
    }

    const symbolMatch = log.match(/symbol:\s*"([^"]+)"/i);
    if (symbolMatch) {
      meta.symbol = symbolMatch[1];
    }
  }

  return meta;
}

/**
 * Decodes a Raydium transaction from its signature.
 */
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
    const poolData = extractPoolData(logs);
    const tokenMetadata = extractTokenMetadata(logs);

    const result = {
      mintAddress,
      poolData,
      tokenMetadata,
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
