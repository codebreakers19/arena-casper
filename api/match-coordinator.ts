import { createArenaClient } from "../agents/shared/arena-client.js";
import { runAgent } from "../agents/shared/agent-runner.js";
import { agentAccount, loadConfig } from "../agents/shared/config.js";
import { sha256 } from "../agents/shared/hash.js";
import type { MatchState } from "../agents/shared/types.js";

export function startMatchCoordinator(): void {
  const config = loadConfig();
  if (config.mode !== "live") {
    console.warn("[arena] automated match coordinator is disabled outside live mode.");
    return;
  }

  const intervalMs = Number(process.env.ARENA_COORDINATOR_POLL_MS ?? Math.min(config.tickMs, 30_000));
  const autoRestart = process.env.ARENA_AUTO_RESTART === "true";
  let running = false;
  let lastAgentCycleAt = 0;

  const reconcile = async () => {
    if (running) return;
    running = true;
    try {
      const client = createArenaClient(config);
      let match = await client.getLatestMatch();
      if (!match || (match.status === "settled" && autoRestart)) {
        match = await client.createMatch({
          creator: agentAccount("creator"),
          agentA: agentAccount("alpha"),
          agentB: agentAccount("beta"),
          verifier: agentAccount("verifier"),
          durationBlocks: config.matchDurationMs,
          startBudget: config.matchStartBudget,
        });
        console.log(`[arena] created match ${match.id}: ${match.createDeployHash}`);
      }

      if (match.status === "settled") return;

      if (match.status === "pending") {
        match = await client.startMatch(match.id, agentAccount("creator"));
        console.log(`[arena] started match ${match.id}: ${match.startDeployHash}`);
      }

      if (await hasMatchEnded(client, match)) {
        const settled = await client.settleMatch({
          matchId: match.id,
          caller: agentAccount("verifier"),
          finalValueA: match.valueA,
          finalValueB: match.valueB,
          settlementHash: sha256(JSON.stringify({ matchId: match.id, valueA: match.valueA, valueB: match.valueB, settledAt: new Date().toISOString() })),
        });
        console.log(`[arena] settled match ${settled.id}: ${settled.settleDeployHash}`);
        return;
      }

      if (Date.now() - lastAgentCycleAt < config.tickMs) return;
      await runAgent({ agentId: "alpha", matchId: match.id, iterations: 1 });
      await runAgent({ agentId: "beta", matchId: match.id, iterations: 1 });
      lastAgentCycleAt = Date.now();
    } catch (error) {
      console.error("[arena] coordinator cycle failed:", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };

  void reconcile();
  setInterval(() => void reconcile(), Math.max(5_000, intervalMs));
}

async function hasMatchEnded(client: ReturnType<typeof createArenaClient>, match: MatchState): Promise<boolean> {
  const events = await client.listEvents(0);
  const started = [...events].reverse().find((event) => event.matchId === match.id && event.type === "match_started");
  const startTime = started ? Date.parse(started.timestamp) : Number.NaN;
  const durationMs = loadConfig().matchDurationMs;
  return Number.isFinite(startTime) && Date.now() >= startTime + durationMs;
}
