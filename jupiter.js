import axios from 'axios';
import { PublicKey } from '@solana/web3.js';
import { telemetry } from '../utils/telemetry.js';
import { withBackoff } from '../utils/backoff.js';

const JUPITER_API = 'https://quote-api.jup.ag/v6';

/**
 * Fetches best swap quote from Jupiter API
 * Detects fallback via Pump.fun even on quote failure
 * @returns {Promise<JupiterQuote | FallbackQuote | null>}
 */
export async function getQuote(
  inputMint,
  outputMint,
  amount,
  { slippage = 0.5, userPublicKey, signalConfidence = null } = {}
) {
  try {
    const inputKey = new PublicKey(inputMint);
    const outputKey = new PublicKey(outputMint);

    const params = new URLSearchParams({
      inputMint: inputKey.toBase58(),
      outputMint: outputKey.toBase58(),
      amount: amount.toString(),
      slippageBps: Math.floor(slippage * 100).toString(),
      ...(userPublicKey && { userPublicKey })
    });

    const { data } = await withBackoff(() =>
      axios.get(`${JUPITER_API}/quote?${params}`)
    );

    console.log('🩻 Raw Jupiter response:', JSON.stringify(data, null, 2));

    const platformLabels =
      data?.routePlan?.map(p => p.swapInfo?.label || 'Unknown') || [];

    // 🧩 Fallback from valid response body
    if (!data?.route || data.route.length === 0) {
      const swapInfo = data?.routePlan?.[0]?.swapInfo;
      const label = swapInfo?.label;

      if (label === 'Pump.fun') {
        console.warn('🚨 Jupiter has no route — falling back to Pump.fun swapInfo');

        telemetry.logFailure({
          source: 'jupiter',
          inputMint,
          outputMint,
          amount,
          error: 'No route — fallback to Pump.fun',
          suggestedPlatforms: [label]
        });

        return {
          fallback: true,
          swapInfo
        };
      }

      console.warn('⚠️ Jupiter quote missing route');

      telemetry.logFailure({
        source: 'jupiter',
        inputMint,
        outputMint,
        amount,
        error: 'No usable route',
        suggestedPlatforms: platformLabels
      });

      return null;
    }

    const dexesUsed = data.route[0].marketInfos.map(
      i => i.marketMeta?.marketName || 'Unknown DEX'
    );

    telemetry.logSuccess({
      source: 'jupiter',
      inputMint,
      outputMint,
      amount,
      dexesUsed,
      routeLength: data.route[0].marketInfos.length,
      signalConfidence,
      slippage,
      timestamp: Date.now()
    });

    console.log('✅ JUPITER_QUOTE_SUCCESS', {
      inputMint,
      outputMint,
      amount,
      routeLength: data.route[0].marketInfos.length
    });

    return {
      inputAmount: data.inAmount,
      outputAmount: data.outAmount,
      route: data.route,
      dexesUsed,
      slippage,
      timestamp: Date.now()
    };
  } catch (error) {
    const status = error?.response?.status;
    const errorBody = error?.response?.data;

    console.error('❌ JUPITER_QUOTE_FAILED', {
      inputMint,
      outputMint,
      amount,
      status,
      error: error.message
    });

    // 🧪 Debug: Print entire error body if available
    if (errorBody) {
      console.log('🧪 Jupiter error response body:', JSON.stringify(errorBody, null, 2));
    }

    // 🔁 Scan for fallback swapInfo even in error cases
    const fallbackSwapInfo = errorBody?.routePlan?.[0]?.swapInfo;
    const label = fallbackSwapInfo?.label;

    if (status === 400 && label === 'Pump.fun') {
      console.warn('🚨 Jupiter 400 — extracting fallback swapInfo from error');

      telemetry.logFailure({
        source: 'jupiter',
        inputMint,
        outputMint,
        amount,
        error: 'Jupiter 400 — Pump.fun fallback',
        suggestedPlatforms: [label]
      });

      return {
        fallback: true,
        swapInfo: fallbackSwapInfo
      };
    }

    telemetry.logFailure({
      source: 'jupiter',
      inputMint,
      outputMint,
      amount,
      error: error.message
    });

    return null;
  }
}