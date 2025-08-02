// raydiumDecoder.js

import { Connection } from '@solana/web3.js';
import { logger } from './logger.js';

const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');

// Known Raydium programs
const raydiumPrograms = new Set([
  'RVKd61ztZW9GdKzS1JMeCwFhHcfN1pSgUxi6D9Zz4kQ', // Raydium Swap V2
  '2s6zNd57wEoHzE3wDCaCG8ct7SbFsU9jTuNFctKUL9du', // Raydium Router
  '22uTzDuaopAEa2F3FnYr3fCq99r46KYoZZ94uRMP1DgA', // Raydium Pool
  'EhhTK3gPZ1NRbVAKf5fRKUYMoLk92boabnZx1RM4y24N', // Raydium AMM V4
]);

function extractRaydiumMintAddress({ meta, transaction }) {
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
    if (raydiumPrograms.has(programId)) {
      for (const acctIdx of ix.accounts || []) {
        const addr = allAccountKeys[acctIdx];
        if (addr && addr.endsWith('pump') === false) return addr; // crude filter for mint
      }
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

    const transactionInfo = {
      slot: txn.slot,
      blockTime: txn.blockTime,
      meta: txn.meta,
      accounts: allAccountKeys,
      signature,
    };

    const mintAddress = extractRaydiumMintAddress(txn);

    if (!mintAddress) throw new Error('Not a Raydium transaction');

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
