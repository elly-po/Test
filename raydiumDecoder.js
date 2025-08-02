// raydiumDecoder.js

import { Connection } from '@solana/web3.js';
import { logger } from './logger.js';

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

// Raydium Program IDs (AMM v4, etc.)
const RAYDIUM_PROGRAM_IDS = new Set([
  'RVKd61ztZW9GdKzH9v5zEShkwX4q7yTGceo7nTzjRZV',
  'EhhTKzYrFaz4XBs1YDe2MFNURnwrjqcmnbnxxLBnH7Lh',
  'EUqojwWA2rd19FZrzeBncJsm38Jm1hEhE3zsmX3bRc2o',
]);

/**
 * Extracts mint address heuristically from Raydium transaction.
 */
function extractMintAddress({ meta, transaction }) {
  const knownNonMints = new Set([
    '11111111111111111111111111111111',
    'So11111111111111111111111111111111111111112',
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
    if (!RAYDIUM_PROGRAM_IDS.has(programId)) continue;

    for (const acctIdx of ix.accounts || []) {
      const addr = allAccountKeys[acctIdx];
      if (addr && !knownNonMints.has(addr)) {
        return addr;
      }
    }
  }

  return null;
}

/**
 * Attempts to parse pool address from log messages or known account positions.
 */
function extractPoolData(logs = []) {
  const data = {};

  for (const log of logs) {
    const poolMatch = log.match(/pool:\s*([A-Za-z0-9]{32,44})/i);
    if (poolMatch) {
      data.poolAddress = poolMatch[1];
    }
  }

  return data;
}

/**
 * Basic Raydium log inspection for token metadata hints.
 */
function extractTokenMetadata(logs = []) {
  const meta = {};

  for (const log of logs) {
    const nameMatch = log.match(/name:\s*"([^"]+)"/i);
    if (nameMatch) meta.name = nameMatch[1];

    const symbolMatch = log.match(/symbol:\s*"([^"]+)"/i);
    if (symbolMatch) meta.symbol = symbolMatch[1];
  }

  return meta;
}

/**
 * Checks if any instruction in the tx is a Raydium instruction.
 */
function isRaydiumTransaction({ transaction }) {
  const message = transaction.message;
  const staticKeys = message.staticAccountKeys?.map(k => k.toString()) || [];

  return message.compiledInstructions.some(ix => {
    const programId = staticKeys[ix.programIdIndex];
    return RAYDIUM_PROGRAM_IDS.has(programId);
  });
}

/**
 * Decodes a Raydium transaction by signature.
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

    if (!isRaydiumTransaction(txn)) {
      throw new Error('Not a Raydium transaction');
    }

    const mintAddress = extractMintAddress(txn);
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
    throw err;
  }
}
