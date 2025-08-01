import { Connection } from '@solana/web3.js';
import { logger } from './logger.js';

// RPC connection
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

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

export async function decodePumpfun(signature) {
  try {
    logger.info(`🔍 Fetching transaction for signature: ${signature}`);

    const txn = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (!txn) throw new Error(`Transaction not found for signature: ${signature}`);
    if (!txn.transaction || !txn.transaction.message || !txn.transaction.message.accountKeys) {
      throw new Error(`Malformed transaction data structure.`);
    }

    logger.info('📦 Raw transaction object:', JSON.stringify(txn, null, 2));

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
