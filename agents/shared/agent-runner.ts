import { createArenaClient } from "./arena-client.js";
import { requestAgentDecision } from "./ai-client.js";
import { loadAgentState, saveAgentState } from "./agent-state.js";
import { agentAccount, loadConfig } from "./config.js";
import { writeEvidence } from "./evidence-store.js";
import { sha256 } from "./hash.js";
import { applyTrade, initialPortfolio, portfolioValue } from "./portfolio.js";
import { PriceFeed } from "./price-feed.js";
import { guardDecision } from "./risk-guard.js";
import type { AgentDecision, AgentId, Portfolio, PricePoint } from "./types.js";

export interface RunAgentOptions {
  agentId: AgentId;
  iterations?: number;
  matchId?: number;
}

export async function runAgent(options: RunAgentOptions): Promise<void> {
  const config = loadConfig();
  const client = createArenaClient(config);
  const match = options.matchId
    ? await client.getMatch(options.matchId)
    : await client.getLatestMatch();
  if (!match) throw new Error("No match found. Run scripts/run-demo.ts or create a match first.");
  if (match.status !== "active") throw new Error(`Match ${match.id} is ${match.status}, not active.`);

  const agent = options.agentId === "alpha" ? match.agentA : match.agentB;
  const feed = new PriceFeed();
  const stored = await loadAgentState(
    config.contractHash,
    match.id,
    options.agentId,
    initialPortfolio(
    options.agentId === "alpha" ? match.valueA : match.valueB,
    0,
    ),
  );
  const history: PricePoint[] = stored.history;
  let portfolio: Portfolio = stored.portfolio;
  const iterations = options.iterations ?? 4;

  for (let i = 0; i < iterations; i += 1) {
    let price: PricePoint;
    try {
      price = await feed.nextPrice();
    } catch (error) {
      console.warn(`[${options.agentId}] skipped tick: ${error instanceof Error ? error.message : String(error)}`);
      if (i < iterations - 1) await sleep(config.tickMs);
      continue;
    }
    history.push(price);
    const portfolioBefore = { ...portfolio };
    const aiDecision = await requestAgentDecision(options.agentId, history, portfolio);
    const strategyDecision = applyStrategyRule(options.agentId, history, portfolio, aiDecision);
    const decision = guardDecision(strategyDecision, portfolio, price.price);
    portfolio = applyTrade(portfolio, decision.action, decision.amount, price.price);
    const value = portfolioValue(portfolio, price.price);
    const evidence = await writeEvidence({
      createdAt: new Date().toISOString(),
      matchId: match.id,
      agentId: options.agentId,
      source: price.source,
      market: price,
      decision: {
        action: strategyDecision.action,
        allocationBps: strategyDecision.allocationBps,
        confidence: strategyDecision.confidence,
        thesis: strategyDecision.thesis,
        riskFlags: strategyDecision.riskFlags,
      },
      rawModelResponse: aiDecision.rawResponse,
      portfolioBefore,
    });
    const record = await client.recordTrade({
      matchId: match.id,
      agent,
      agentId: options.agentId,
      action: decision.action,
      pair: "CSPR/USD",
      amount: decision.amount,
      price: Math.round(price.price * 1_000_000_000),
      portfolioValue: value,
      reasoning: decision.reasoning,
      reasoningHash: sha256(aiDecision.rawResponse || decision.reasoning),
      evidenceHash: evidence.hash,
      evidenceUrl: evidence.url,
      source: price.source,
      confidence: strategyDecision.confidence,
    });
    await saveAgentState(config.contractHash, match.id, options.agentId, { history, portfolio, updatedAt: new Date().toISOString() });
    console.log(
      `[${options.agentId}] ${record.action} value=${record.portfolioValue} deploy=${record.deployHash}`
    );
    if (i < iterations - 1) {
      await sleep(config.tickMs);
    }
  }
}

function applyStrategyRule(agentId: AgentId, history: PricePoint[], portfolio: Portfolio, aiDecision: AgentDecision): AgentDecision {
  if (history.length < 5) {
    return {
      ...aiDecision,
      action: "HOLD" as const,
      allocationBps: 0,
      thesis: `${agentId === "alpha" ? "Momentum" : "Mean-reversion"} warm-up: five verified quotes are required before a position can be opened. ${aiDecision.thesis}`,
      riskFlags: [...aiDecision.riskFlags, "INSUFFICIENT_HISTORY"],
    };
  }

  const prices = history.map((point) => point.price);
  const last = prices.at(-1) ?? 0;
  if (agentId === "alpha") {
    const shortAverage = average(prices.slice(-3));
    const longAverage = average(prices.slice(-5));
    if (shortAverage > longAverage) return { ...aiDecision, action: "BUY" as const, thesis: `Momentum confirmation: SMA(3) ${shortAverage.toFixed(6)} exceeds SMA(5) ${longAverage.toFixed(6)}. ${aiDecision.thesis}` };
    if (shortAverage < longAverage && portfolio.asset > 0) return { ...aiDecision, action: "SELL" as const, thesis: `Momentum exit: SMA(3) ${shortAverage.toFixed(6)} is below SMA(5) ${longAverage.toFixed(6)}. ${aiDecision.thesis}` };
    return { ...aiDecision, action: "HOLD" as const, allocationBps: 0, thesis: `Momentum has no confirmed entry. ${aiDecision.thesis}` };
  }

  const recent = prices.slice(-5);
  const recentHigh = Math.max(...recent);
  const recentLow = Math.min(...recent);
  const drawdown = recentHigh > 0 ? (recentHigh - last) / recentHigh : 0;
  const recovery = recentLow > 0 ? (last - recentLow) / recentLow : 0;
  if (drawdown >= 0.03) return { ...aiDecision, action: "BUY" as const, thesis: `Mean-reversion entry: ${Math.round(drawdown * 100)}% drawdown from the recent high. ${aiDecision.thesis}` };
  if (recovery >= 0.02 && portfolio.asset > 0) return { ...aiDecision, action: "SELL" as const, thesis: `Mean-reversion exit: ${Math.round(recovery * 100)}% recovery from the recent low. ${aiDecision.thesis}` };
  return { ...aiDecision, action: "HOLD" as const, allocationBps: 0, thesis: `Mean-reversion threshold has not triggered. ${aiDecision.thesis}` };
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export async function createAndStartDemoMatch(): Promise<number> {
  const config = loadConfig();
  const client = createArenaClient(config);
  const creator = agentAccount("creator");
  const match = await client.createMatch({
    creator,
    agentA: agentAccount("alpha"),
    agentB: agentAccount("beta"),
      verifier: agentAccount("verifier"),
      durationBlocks: config.matchDurationMs,
      startBudget: config.matchStartBudget
  });
  console.log(`[match] created id=${match.id} deploy=${match.createDeployHash ?? "live"}`);
  const started = await client.startMatch(match.id, creator);
  console.log(`[match] started id=${started.id} deploy=${started.startDeployHash ?? "live"}`);
  return started.id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
