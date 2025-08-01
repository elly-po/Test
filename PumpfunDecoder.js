// pumpfunDecoder.js

import { Connection, PublicKey } from '@solana/web3.js';
import config from './config/index.js'; // Or hardcode RPC if needed
import { logger } from './utils/logger.js'; // Optional: replace with console if not available

// Connection to Solana RPC
const connection = new Connection(config.SOLANA_RPC_URL, 'confirmed');

// 🧠 Extract mint address from transaction
function extractPumpfunMintAddress(transactionInfo, logs) {
  const { accounts, meta } = transactionInfo;

  const newAccounts = meta?.postTokenBalances?.filter(balance =>
    !meta.preTokenBalances?.some(pre => pre.accountIndex === balance.accountIndex)
  ) || [];

  if (newAccounts.length > 0 && accounts[newAccounts[0].accountIndex]) {
    return accounts[newAccounts[0].accountIndex];
  }

  for (const log of logs) {
    const mintMatch = log.match(/mint:\s*([A-Za-z0-9]{32,44})/i);
    if (mintMatch) {
      return mintMatch[1];
    }
  }

  return null;
}

// 💧 Extract pool-related data
function extractPoolData(logs) {
  const poolData = {};

  for (const log of logs) {
    const poolMatch = log.match(/pool:\s*([A-Za-z0-9]{32,44})/i);
    if (poolMatch) {
      poolData.poolAddress = poolMatch[1];
    }

    const liquidityMatch = log.match(/liquidity:\s*(\d+)/i);
    if (liquidityMatch) {
      poolData.initialLiquidity = parseInt(liquidityMatch[1]);
    }
  }

  return poolData;
}

// 🏷️ Extract name and symbol
function extractTokenMetadata(logs) {
  const metadata = {};

  for (const log of logs) {
    const nameMatch = log.match(/name:\s*"([^"]+)"/i);
    if (nameMatch) {
      metadata.name = nameMatch[1];
    }

    const symbolMatch = log.match(/symbol:\s*"([^"]+)"/i);
    if (symbolMatch) {
      metadata.symbol = symbolMatch[1];
    }
  }

  return metadata;
}

// 🚀 Main function to call
export async function decodePumpfun(signature) {
  try {
    logger?.info?.(`🔍 Fetching transaction for signature: ${signature}`) || console.log(signature);

    const transaction = await connection.getTransaction(signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0
    });

    if (!transaction) {
      throw new Error(`Transaction not found for signature: ${signature}`);
    }

    const { slot, blockTime, meta, transaction: tx } = transaction;

    const logs = meta?.logMessages || [];
    const accounts = tx.message.accountKeys.map(key => key.toString());

    const transactionInfo = {
      transaction,
      slot,
      blockTime,
      meta,
      accounts
    };

    const mintAddress = extractPumpfunMintAddress(transactionInfo, logs);
    const poolData = extractPoolData(logs);
    const tokenMetadata = extractTokenMetadata(logs);

    const result = {
      mintAddress,
      transactionInfo,
      poolData,
      tokenMetadata,
      platform: 'pump.fun',
      createdAt: Date.now()
    };

    logger?.info?.(`✅ Decoded pump.fun transaction:`, result) || console.log(result);
    return result;

  } catch (error) {
    logger?.error?.('❌ Error decoding pumpfun transaction:', error) || console.error(error);
    throw error;
  }
}
