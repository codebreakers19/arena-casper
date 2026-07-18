import type { AgentDecision, AgentId, Portfolio, PricePoint, TradeAction } from "./types.js";

const ALLOWED_ACTIONS = new Set<TradeAction>(["BUY", "SELL", "HOLD"]);

export async function requestAgentDecision(agentId: AgentId, history: PricePoint[], portfolio: Portfolio): Promise<AgentDecision> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey || apiKey === "sk-or-v1-") return hold("OpenRouter is not configured. The risk guard blocked autonomous execution.");

  const body = {
    temperature: 0.2,
    max_tokens: 280,
    messages: [
      { role: "system", content: `You are an autonomous virtual-portfolio agent in a public Casper benchmark. Your strategy is ${agentId === "alpha" ? "momentum and trend continuation" : "mean reversion after drawdowns"}. Return JSON only: action (BUY|SELL|HOLD), allocation_bps (0-2500), confidence (0-100), thesis (max 240 chars), risk_flags (string array). You never claim to execute a real swap.` },
      { role: "user", content: JSON.stringify({ agent: agentId, portfolio, market: history.slice(-8) }) }
    ]
  };
  const configuredModel = process.env.AI_MODEL?.trim() || "openrouter/free";
  let response = await requestCompletion(apiKey, configuredModel, body);
  if (response.status === 404 && configuredModel !== "openrouter/free") {
    response = await requestCompletion(apiKey, "openrouter/free", body);
  }

  if (!response.ok) return hold(`OpenRouter returned ${response.status}; no autonomous action was executed.`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string | null } }> };
  const rawResponse = payload.choices?.[0]?.message?.content?.trim() ?? "";
  try {
    const parsed = JSON.parse(extractJson(rawResponse)) as Record<string, unknown>;
    const action = String(parsed.action ?? "HOLD").toUpperCase() as TradeAction;
    const allocationBps = Number(parsed.allocation_bps ?? 0);
    const confidence = Number(parsed.confidence ?? 0);
    const thesis = String(parsed.thesis ?? "No thesis returned.").slice(0, 240);
    const riskFlags = Array.isArray(parsed.risk_flags) ? parsed.risk_flags.map(String).slice(0, 8) : [];
    if (!ALLOWED_ACTIONS.has(action) || !Number.isFinite(allocationBps) || !Number.isFinite(confidence)) return hold("The model response failed validation; the risk guard blocked execution.", rawResponse);
    return { action, allocationBps: Math.round(allocationBps), confidence: Math.round(confidence), thesis, riskFlags, rawResponse };
  } catch {
    return hold("The model returned invalid JSON; the risk guard blocked execution.", rawResponse);
  }
}

async function requestCompletion(apiKey: string, model: string, body: Record<string, unknown>): Promise<Response> {
  return fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.ARENA_PUBLIC_URL ?? "http://localhost:3001",
      "X-Title": "Arena - Casper Agent Treasury League"
    },
    body: JSON.stringify({
      model,
      ...body
    }),
    signal: AbortSignal.timeout(20_000)
  });
}

function extractJson(raw: string): string {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return start >= 0 && end > start ? raw.slice(start, end + 1) : raw;
}

function hold(thesis: string, rawResponse = ""): AgentDecision {
  return { action: "HOLD", allocationBps: 0, confidence: 0, thesis, riskFlags: ["AI_GUARD"], rawResponse };
}
