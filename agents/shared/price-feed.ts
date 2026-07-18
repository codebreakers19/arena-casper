import type { PricePoint } from "./types.js";

/**
 * A match may only act on a fetched quote. Deliberately no random walk, cache,
 * or last-known fallback is used because those values cannot be audited.
 */
export class PriceFeed {
  async nextPrice(): Promise<PricePoint> {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=casper-network&vs_currencies=usd",
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!res.ok) throw new Error(`Verified market quote unavailable (${res.status}).`);
    const evidence = await res.json() as { "casper-network"?: { usd?: number } };
    const price = evidence["casper-network"]?.usd;
    if (!price || price <= 0) throw new Error("Verified market quote did not contain a CSPR USD price.");
    return {
      price,
      source: "CoinGecko CSPR/USD",
      timestamp: new Date().toISOString(),
      evidence,
    };
  }
}
