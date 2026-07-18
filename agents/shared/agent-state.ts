import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { arenaDataPath } from "./storage.js";
import type { AgentId, Portfolio, PricePoint } from "./types.js";

interface AgentState {
  history: PricePoint[];
  portfolio: Portfolio;
  updatedAt: string;
}

const STATE_DIR = arenaDataPath("agent-state");
const MAX_HISTORY = 60;

export async function loadAgentState(
  contractHash: string | undefined,
  matchId: number,
  agentId: AgentId,
  initialPortfolio: Portfolio,
): Promise<AgentState> {
  const path = statePath(contractHash, matchId, agentId);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as AgentState;
    if (!Array.isArray(parsed.history) || !isPortfolio(parsed.portfolio)) throw new Error("Invalid agent state");
    return { history: parsed.history.slice(-MAX_HISTORY), portfolio: parsed.portfolio, updatedAt: parsed.updatedAt };
  } catch {
    return { history: [], portfolio: initialPortfolio, updatedAt: new Date(0).toISOString() };
  }
}

export async function saveAgentState(
  contractHash: string | undefined,
  matchId: number,
  agentId: AgentId,
  state: AgentState,
): Promise<void> {
  const path = statePath(contractHash, matchId, agentId);
  await mkdir(STATE_DIR, { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const payload: AgentState = { ...state, history: state.history.slice(-MAX_HISTORY), updatedAt: new Date().toISOString() };
  await writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

function statePath(contractHash: string | undefined, matchId: number, agentId: AgentId): string {
  const contract = (contractHash ?? "mock").replace(/^contract-/, "").replace(/[^a-zA-Z0-9_-]/g, "");
  return join(STATE_DIR, `${contract}-match-${matchId}-${agentId}.json`);
}

function isPortfolio(value: unknown): value is Portfolio {
  if (!value || typeof value !== "object") return false;
  const portfolio = value as Portfolio;
  return [portfolio.cash, portfolio.asset, portfolio.lastPrice].every((item) => typeof item === "number" && Number.isFinite(item));
}
