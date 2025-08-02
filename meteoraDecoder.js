// meteoraDecoder.js

import { Connection } from '@solana/web3.js';
import { logger } from './logger.js';

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

/**
 * Extracts the mint address from postTokenBalances for Meteora.
 */
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

/**
 * Parses logs to find vault, pool, or launchpad-specific hints.
 */
function extractMeteoraPoolData(logs) {
  const data = {};

  for (const log of logs) {
    const poolMatch = log.match(/vault|pool:\s*([A-Za-z0-9]{32,44})/i);
    if (poolMatch) {
      data.vaultAddress = poolMatch[1];
    }

    const liqMatch = log.match(/liquidity:\s*(\d+)/i);
    if (liqMatch) {
      data.initialLiquidity = parseInt(liqMatch[1], 10);
    }
  }

  return data;
}

/**
 * Parses logs to find token metadata (name, symbol).
 */
function extractTokenMetadata(logs) {
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
 * Main decoder for Meteora transactions.
 */
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
    const poolData = extractMeteoraPoolData(logs);
    const tokenMetadata = extractTokenMetadata(logs);

    const result = {
      mintAddress,
      poolData,
      tokenMetadata,
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
