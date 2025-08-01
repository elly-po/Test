// pumpfunDecoder.js
import { Connection } from '@solana/web3.js';
import { logger } from './logger.js';

// RPC connection to Solana Mainnet
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

/**
 * Extract the true token mint address from postTokenBalances.
 */
function extractMintAddress(meta) {
  const postTokenBalances = meta?.postTokenBalances || [];
  const preTokenBalances = meta?.preTokenBalances || [];

  const newTokenAccounts = postTokenBalances.filter(
    post => !preTokenBalances.some(pre => pre.accountIndex === post.accountIndex)
  );

  // ✅ Extract mint field directly
  if (newTokenAccounts.length > 0) {
    return newTokenAccounts[0].mint || null;
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

    if (!txn) {
      throw new Error(`Transaction not found for signature: ${signature}`);
    }

    logger.info('📦 Raw txn keys:', Object.keys(txn));
    logger.info('📦 txn.transaction keys:', Object.keys(txn.transaction || {}));
    logger.info('📦 txn.message keys:', Object.keys(txn.transaction?.message || {}));

    const { slot, blockTime, meta } = txn;
    const tx = txn.transaction;
    const logs = meta?.logMessages || [];

    const accountKeys = tx.message?.accountKeys || tx.message?.staticAccountKeys;

    if (!accountKeys) {
      logger.error('❌ txn.transaction.message.accountKeys is missing');
      throw new Error('Malformed transaction: txn.transaction.message.accountKeys is missing');
    }

    const accounts = accountKeys.map(key => key.toString());

    const transactionInfo = {
      slot,
      blockTime,
      meta,
      accounts,
      signature,
    };

    const mintAddress = extractMintAddress(meta);
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
