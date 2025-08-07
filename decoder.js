// decoder-router.js
import EventEmitter from 'events';
import { Connection, PublicKey } from '@solana/web3.js';
import { RateLimiter } from 'limiter';
import { telemetry } from './utils/telemetry.js';
import config from './config/index.js';
import solanaLogListener from './solanaLogListener.js';
import { logger } from './utils/logger.js';

// Enhanced Solana RPC connection with rate limiting and telemetry
class RateLimitedConnection {
  constructor(rpcUrl, options = {}) {
    this.connection = new Connection(rpcUrl, 'confirmed');
    this.rpcUrl = rpcUrl;
    this.limiter = new RateLimiter({
      tokensPerInterval: options.requestsPerSecond || 30,
      interval: 'second'
    });
    this.maxRetries = options.maxRetries || 3;
    this.retryDelay = options.retryDelay || 1000;
    this.rpcRequestCount = 0;
    this.rpcErrorCount = 0;
    this.rpcRateLimitedCount = 0;
  }

  async _executeWithRateLimit(fnName, ...args) {
    const startTime = Date.now();
    let attempt = 0;
    let lastError = null;

    telemetry.counter('rpc_request_attempt', 1, { method: fnName });
    this.rpcRequestCount++;

    while (attempt < this.maxRetries) {
      attempt++;
      try {
        const remainingRequests = await this.limiter.removeTokens(1);
        telemetry.gauge('rpc_remaining_tokens', remainingRequests);

        const result = await this.connection[fnName](...args);

        const duration = Date.now() - startTime;
        telemetry.counter('rpc_request_success', 1, { method: fnName });
        telemetry.histogram('rpc_request_duration', duration, { 
          method: fnName,
          attempt
        });

        return result;
      } catch (error) {
        lastError = error;
        this.rpcErrorCount++;

        if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
          this.rpcRateLimitedCount++;
          telemetry.counter('rpc_rate_limited', 1, { 
            method: fnName,
            attempt
          });
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }

        telemetry.counter('rpc_request_error', 1, { 
          method: fnName,
          error: error.message,
          attempt
        });

        if (!error.message.includes('timeout') && !error.message.includes('gateway')) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, this.retryDelay));
      }
    }
    throw lastError || new Error(`RPC request failed after ${attempt} attempts`);
  }

  async getTransaction(signature, options) {
    return this._executeWithRateLimit('getTransaction', signature, options);
  }

  async getAccountInfo(publicKey, options) {
    return this._executeWithRateLimit('getAccountInfo', publicKey, options);
  }

  getRpcMetrics() {
    return {
      totalRequests: this.rpcRequestCount,
      errors: this.rpcErrorCount,
      rateLimited: this.rpcRateLimitedCount,
      currentRateLimit: this.limiter.getTokensRemaining(),
      config: {
        requestsPerSecond: this.limiter.tokensPerInterval,
        maxRetries: this.maxRetries
      }
    };
  }
}

// Initialize rate-limited connection
const connection = new RateLimitedConnection(config.SOLANA_RPC_URL, {
  requestsPerSecond: config.RPC_RATE_LIMIT || 30,
  maxRetries: config.RPC_MAX_RETRIES || 3,
  retryDelay: config.RPC_RETRY_DELAY || 1000
});

/**
 * Base Decoder Class
 */
class BaseDecoder {
  constructor(tag) {
    this.tag = tag;
    this.setupMetrics();
  }

  setupMetrics() {
    this.metrics = {
      processed: 0,
      errors: 0,
      mintAddressesFound: 0,
      rpcRequests: 0,
      rpcErrors: 0,
      rpcRateLimited: 0
    };
  }

  async decode(taggedLog) {
    throw new Error('decode() must be implemented by subclass');
  }

  async getTransactionInfo(signature) {
    try {
      telemetry.counter('transaction_fetch_attempt', 1, { decoder: this.tag });
      this.metrics.rpcRequests++;

      const startTime = Date.now();
      const transaction = await connection.getTransaction(signature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });

      if (!transaction) {
        throw new Error(`Transaction not found: ${signature}`);
      }

      const duration = Date.now() - startTime;
      telemetry.counter('transaction_fetch_success', 1, { decoder: this.tag });
      telemetry.histogram('transaction_fetch_duration', duration, { 
        decoder: this.tag,
        slot: transaction.slot
      });

      return {
        transaction,
        slot: transaction.slot,
        blockTime: transaction.blockTime,
        meta: transaction.meta,
        accounts: [
          ...(transaction.transaction.message.staticAccountKeys || []),
          ...(transaction.transaction.message.loadedAddresses?.writable || []),
          ...(transaction.transaction.message.loadedAddresses?.readonly || [])
        ].map(key => key.toString())
      };
    } catch (error) {
      this.metrics.rpcErrors++;
      if (error.message.includes('429') || error.message.includes('Too Many Requests')) {
        this.metrics.rpcRateLimited++;
      }
      telemetry.counter('transaction_fetch_error', 1, { 
        decoder: this.tag,
        error: error.message 
      });
      throw error;
    }
  }

  async process(taggedLog) {
    const startTime = Date.now();
    try {
      this.metrics.processed++;
      const decodedData = await this.decode(taggedLog);
      const processingTime = Date.now() - startTime;

      telemetry.histogram('decoder_processing_time', processingTime, {
        decoder: this.tag,
        success: true
      });

      if (decodedData.mintAddress) {
        this.metrics.mintAddressesFound++;
        telemetry.counter('mint_address_found', 1, { 
          decoder: this.tag,
          mint: decodedData.mintAddress 
        });
      }
      return decodedData;
    } catch (error) {
      this.metrics.errors++;
      telemetry.counter('decoder_error', 1, {
        decoder: this.tag,
        error: error.message
      });
      telemetry.histogram('decoder_processing_time', Date.now() - startTime, {
        decoder: this.tag,
        success: false
      });
      throw error;
    }
  }

  getMetrics() {
    return { 
      ...this.metrics,
      rpcMetrics: connection.getRpcMetrics()
    };
  }
}

/**
 * Pump.fun Decoder
 */
class PumpfunDecoder extends BaseDecoder {
  constructor() {
    super('pumpfun_create');
  }

  async decode(taggedLog) {
    // First try direct log decoding
    const directResult = await this.decodePumpFunCreate(taggedLog.logs);
    if (directResult) {
      const transactionInfo = await this.getTransactionInfo(taggedLog.signature);
      return {
        mintAddress: directResult.mint,
        transactionInfo,
        platform: 'pump.fun',
        createdAt: Date.now()
      };
    }

    // Fallback to transaction decoding
    const transactionInfo = await this.getTransactionInfo(taggedLog.signature);
    const mintAddress = this.extractMintAddress(transactionInfo);
    
    return {
      mintAddress,
      transactionInfo,
      platform: 'pump.fun',
      createdAt: Date.now()
    };
  }

  async decodePumpFunCreate(taggedLog = []) {
    const dataLogs = taggedLog.filter(taggedLog => taggedLog.toLowerCase().includes('program data:'));
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

  extractMintAddress({ meta, transaction }) {
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
  
class RaydiumDecoder extends BaseDecoder {
  constructor() {
    super('raydium_initPool');
  }

  async decode(taggedLog) {
    const transactionInfo = await this.getTransactionInfo(taggedLog.signature);
    const mintAddress = this.extractRaydiumMintAddress(transactionInfo);
    const poolInfo = this.extractPoolData(taggedLog.logs);
    const tokenMetadata = this.extractTokenMetadata(taggedLog.logs);

    return {
      mintAddress,
      transactionInfo,
      platform: 'raydium',
      createdAt: Date.now()
    };
  }

  extractRaydiumMintAddress({ meta }) {
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

class MeteoraDecoder extends BaseDecoder {
  constructor() {
    super('meteora_initPool');
  }

  async decode(taggedLog) {
    const transactionInfo = await this.getTransactionInfo(taggedLog.signature);
    const mintAddress = this.extractMeteoraMintAddress(transactionInfo);
    
    return {
      mintAddress,
      transactionInfo,
      platform: 'meteora',
      createdAt: Date.now()
    };
  }

  extractMeteoraMintAddress({ meta }) {
    if (!meta?.postTokenBalances) return null;

    for (const balance of meta.postTokenBalances) {
      const amount = balance.uiTokenAmount?.uiAmount;
      if (amount && amount > 0) {
        return balance.mint;
      }
    }
    return null;
  }

class DecoderRouter extends EventEmitter {
  constructor() {
    super();
    this.decoders = new Map();
    this.metrics = {
      totalProcessed: 0,
      successfulDecodes: 0,
      errors: 0,
      mintAddressesExtracted: 0,
      rpcRequests: 0,
      rpcErrors: 0
    };
    this.initializeDecoders();
    this.setupEventListeners();
  }

  initializeDecoders() {
    this.decoders.set('pumpfun_create', new PumpfunDecoder());
    this.decoders.set('raydium_initPool', new RaydiumDecoder());
    this.decoders.set('meteora_initPool', new MeteoraDecoder());
    telemetry.counter('decoders_initialized', this.decoders.size);
  }

  setupEventListeners() {
    for (const [tag, decoder] of this.decoders) {
      solanaLogListener.on(`decoder:${tag}`, async (taggedLog))=> {
        await this.processTaggedLog(tag, taggedLog);
      });
    }

    solanaLogListener.on('processed_log', (processedLog) => {
      this.handleProcessedLog(processedLog);
    });
  }

  async processTaggedLog(tag, taggedLog) {
    const decoder = this.decoders.get(tag);
    if (!decoder) return;

    try {
      this.metrics.totalProcessed++;
      const decodedData = await decoder.process(taggedLog);

      const decoderMetrics = decoder.getMetrics();
      this.metrics.rpcRequests += decoderMetrics.rpcRequests;
      this.metrics.rpcErrors += decoderMetrics.rpcErrors;

      if (taggedLog.callback) {
        await taggedLog.callback(decodedData);
      }

      this.metrics.successfulDecodes++;
      if (decodedData.mintAddress) {
        this.metrics.mintAddressesExtracted++;
      }
    } catch (error) {
      this.metrics.errors++;
      telemetry.counter('decoder_processing_error', 1, {
        tag,
        error: error.message
      });

      if (taggedLog.callback) {
        await taggedLog.callback({
          error: error.message,
          mintAddress: null,
          transactionInfo: null
        });
      }
    }
  }

  handleProcessedLog(processedLog) {
    this.emit('new_token_detected', {
      tag: processedLog.tag,
      mintAddress: processedLog.mintAddress,
      platform: processedLog.decodedData.platform,
      timestamp: processedLog.timestamp,
      confidence: processedLog.confidence,
      transactionSignature: processedLog.signature
    });
  }

  getMetrics() {
    const decoderMetrics = {};
    for (const [tag, decoder] of this.decoders) {
      decoderMetrics[tag] = decoder.getMetrics();
    }

    return {
      overall: this.metrics,
      decoders: decoderMetrics,
      listenerMetrics: solanaLogListener.getMetrics(),
      rpcMetrics: connection.getRpcMetrics()
    };
  }
}

// Create and export singleton instance
const decoderRouter = new DecoderRouter();
export { BaseDecoder, DecoderRouter, decoderRouter, RateLimitedConnection };
export default decoderRouter;
