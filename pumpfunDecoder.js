import { Connection } from '@solana/web3.js';
import { logger } from './logger.js';

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

/**
 * Extract mint address from postTokenBalances or log messages.
 */
function extractMintAddress({ accounts, meta }, logs) {
  const post = meta?.postTokenBalances || [];
  const pre = meta?.preTokenBalances || [];

  const newAccounts = post.filter(
    postBalance => !pre.some(preBalance => preBalance.accountIndex === postBalance.accountIndex)
  );

  if (newAccounts.length > 0) {
    const mintIndex = newAccounts[0]?.accountIndex;
    return accounts[mintIndex] || null;
  }

  for (const log of logs) {
    const match = log.match(/mint:\s*([A-Za-z0-9]{32,44})/i);
    if (match) return match[1];
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

    // Log structure of fetched txn
    logger.info('📦 Raw txn keys:', txn && Object.keys(txn));
    logger.info('📦 txn.transaction keys:', txn?.transaction && Object.keys(txn.transaction));
    logger.info('📦 txn.message keys:', txn?.transaction?.message && Object.keys(txn.transaction.message));

    if (!txn) {
      throw new Error(`Transaction not found for signature: ${signature}`);
    }

    if (!txn.transaction) {
      logger.error('❌ txn.transaction is missing');
      throw new Error(`Malformed transaction: txn.transaction is missing`);
    }

    if (!txn.transaction.message) {
      logger.error('❌ txn.transaction.message is missing');
      throw new Error(`Malformed transaction: txn.transaction.message is missing`);
    }

    if (!txn.transaction.message.accountKeys) {
      logger.error('❌ txn.transaction.message.accountKeys is missing');
      throw new Error(`Malformed transaction: txn.transaction.message.accountKeys is missing`);
    }

    const { slot, blockTime, meta } = txn;
    const tx = txn.transaction;
    const logs = meta?.logMessages || [];
    const accounts = tx.message.accountKeys.map(key => key.toString());

    const transactionInfo = {
      slot,
      blockTime,
      meta,
      accounts,
      signature,
    };

    const mintAddress = extractMintAddress(transactionInfo, logs);
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
