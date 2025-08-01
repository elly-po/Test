// pumpfunDecoder.js

import { Connection } from '@solana/web3.js';
import { logger } from './logger.js';

// RPC connection
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

/**
 * Extract actual token mint address from instructions.
 */
function extractMintAddress({ meta, transaction }) {
  const knownNonMints = [
    'So11111111111111111111111111111111111111112',
    '11111111111111111111111111111111',
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ];

  const message = transaction.message;
  const allInstructions = [
    ...(message.compiledInstructions || []),
    ...(meta?.innerInstructions?.flatMap(i => i.instructions) || [])
  ];

  for (const ix of allInstructions) {
    const programIdIndex = ix.programIdIndex;
    const programId = message.accountKeys[programIdIndex]?.toString();

    if (programId !== 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') continue;

    const mintAccountIndex = ix.accounts?.[0];
    const mintAddress = message.accountKeys[mintAccountIndex]?.toString();

    if (mintAddress && !knownNonMints.includes(mintAddress)) {
      return mintAddress;
    }
  }

  return null;
}

/**
 * Extract pool address and liquidity from logs.
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
 * Extract token name and symbol from logs.
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
 * Main function to decode a pump.fun transaction.
 */
export async function decodePumpfun(signature) {
  try {
    logger.info(`🔍 Fetching transaction for signature: ${signature}`);

    const txn = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (!txn) throw new Error(`Transaction not found for signature: ${signature}`);

    const { slot, blockTime, meta, transaction } = txn;

    if (!transaction?.message?.accountKeys && !transaction?.message?.staticAccountKeys) {
      throw new Error(`Malformed transaction: txn.transaction.message.accountKeys is missing`);
    }

    const message = transaction.message;
    const accountKeys = message.staticAccountKeys || message.accountKeys || [];

    logger.info('📦 Raw txn keys:', Object.keys(txn));
    logger.info('📦 txn.transaction keys:', Object.keys(transaction));
    logger.info('📦 txn.message keys:', Object.keys(message));

    const logs = meta?.logMessages || [];
    const accounts = accountKeys.map(key => key.toString());

    const transactionInfo = {
      slot,
      blockTime,
      meta,
      accounts,
      signature,
    };

    const mintAddress = extractMintAddress({ meta, transaction });
    const poolData = extractPoolData(logs);
    const tokenMetadata = extractTokenMetadata(logs);

    const result = {
      mintAddress,
      poolData,
      tokenMetadata,
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
