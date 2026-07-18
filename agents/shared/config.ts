import "./env.js";
import type { ArenaConfig } from "./types.js";

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(): ArenaConfig {
  const mode = process.env.ARENA_MODE === "live" ? "live" : "mock";
  return {
    mode,
    network: process.env.ARENA_NETWORK ?? "testnet",
    chainName: process.env.ARENA_CHAIN_NAME ?? "casper-test",
    packageHash: process.env.ARENA_PACKAGE_HASH,
    contractHash: process.env.ARENA_CONTRACT_HASH,
    rpcUrl: process.env.ARENA_RPC_URL ?? process.env.TESTNET_RPC ?? "https://rpc.testnet.casperlabs.io/rpc",
    csprLiveBaseUrl: process.env.CSPR_LIVE_BASE_URL ?? "https://testnet.cspr.live/deploy",
    creatorKeyPath: process.env.ARENA_CREATOR_SECRET_KEY ?? process.env.VERIFIER_KEY_PATH,
    alphaKeyPath: process.env.ARENA_ALPHA_SECRET_KEY ?? process.env.AGENT_ALPHA_KEY_PATH,
    betaKeyPath: process.env.ARENA_BETA_SECRET_KEY ?? process.env.AGENT_BETA_KEY_PATH,
    verifierKeyPath: process.env.ARENA_VERIFIER_SECRET_KEY ?? process.env.VERIFIER_KEY_PATH,
    matchDurationMs: numberEnv("MATCH_DURATION_MS", 600_000),
    matchStartBudget: numberEnv("MATCH_START_BUDGET", 1_000_000_000_000),
    matchPollMs: numberEnv("MATCH_POLL_MS", 5_000),
    tickMs: numberEnv("TICK_MS", mode === "live" ? 120_000 : 750)
  };
}

export function agentAccount(agent: "alpha" | "beta" | "verifier" | "creator"): string {
  return process.env[`ARENA_${agent.toUpperCase()}_ACCOUNT`] ?? `account-${agent}`;
}
