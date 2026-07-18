import type { AgentDecision, Portfolio, StrategyDecision, TradeAction } from "./types.js";

const MAX_ALLOCATION_BPS = 2_500;

export function guardDecision(decision: AgentDecision, portfolio: Portfolio, price: number): StrategyDecision {
  const action: TradeAction = decision.action;
  if (decision.allocationBps < 0 || decision.allocationBps > MAX_ALLOCATION_BPS || decision.confidence < 35) {
    return { action: "HOLD", amount: 0, reasoning: `${decision.thesis} Risk guard: confidence or allocation limit rejected.` };
  }
  if (action === "BUY") return { action, amount: Math.floor(portfolio.cash * (decision.allocationBps / 10_000)), reasoning: decision.thesis };
  if (action === "SELL") return { action, amount: Math.floor(portfolio.asset * price * (decision.allocationBps / 10_000)), reasoning: decision.thesis };
  return { action: "HOLD", amount: 0, reasoning: decision.thesis };
}
