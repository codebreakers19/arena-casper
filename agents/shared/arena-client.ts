import { readFileSync } from "node:fs";
import type { ArenaConfig, ArenaEvent, MatchState, TradeRecord } from "./types.js";
import { deployHash, sha256 } from "./hash.js";
import { MockLedger, type MockLedgerData } from "./mock-ledger.js";
import { arenaDataPath } from "./storage.js";

export interface ArenaClient {
  createMatch(args: {
    creator: string;
    agentA: string;
    agentB: string;
    verifier: string;
    durationBlocks: number;
    startBudget: number;
  }): Promise<MatchState>;
  startMatch(matchId: number, caller: string): Promise<MatchState>;
  recordTrade(trade: Omit<TradeRecord, "deployHash" | "blockTime">): Promise<TradeRecord>;
  settleMatch(args: {
    matchId: number;
    caller: string;
    finalValueA: number;
    finalValueB: number;
    settlementHash: string;
  }): Promise<MatchState>;
  getLatestMatch(): Promise<MatchState | undefined>;
  getMatch(matchId: number): Promise<MatchState | undefined>;
  listEvents(afterIndex?: number): Promise<ArenaEvent[]>;
}

export function createArenaClient(config: ArenaConfig): ArenaClient {
  if (config.mode === "live") return new LiveArenaClient(config);
  return new MockArenaClient(config);
}

export class MockArenaClient implements ArenaClient {
  private ledger = new MockLedger();

  constructor(private readonly config: ArenaConfig) {}

  async createMatch(args: {
    creator: string;
    agentA: string;
    agentB: string;
    verifier: string;
    durationBlocks: number;
    startBudget: number;
  }): Promise<MatchState> {
    return this.ledger.mutate((data) => {
      const id = data.nextMatchId++;
      const hash = deployHash("create-match");
      const match: MatchState = {
        id,
        creator: args.creator,
        agentA: args.agentA,
        agentB: args.agentB,
        verifier: args.verifier,
        startBlock: data.block,
        endBlock: data.block + args.durationBlocks,
        startBudget: args.startBudget,
        status: "pending",
        valueA: args.startBudget,
        valueB: args.startBudget,
        tradeCount: 0,
        createDeployHash: hash
      };
      data.matches.push(match);
      data.events.push(event(hash, "match_created", id, match));
      return match;
    });
  }

  async startMatch(matchId: number, caller: string): Promise<MatchState> {
    return this.ledger.mutate((data) => {
      const match = mustFindMatch(data.matches, matchId);
      if (caller !== match.creator && caller !== match.verifier) throw new Error("Unauthorized start_match caller");
      if (match.status !== "pending") throw new Error("Match is not pending");
      const duration = match.endBlock - match.startBlock;
      data.block += 1;
      const hash = deployHash("start-match");
      match.status = "active";
      match.startBlock = data.block;
      match.endBlock = data.block + duration;
      match.startDeployHash = hash;
      data.events.push(event(hash, "match_started", matchId, match));
      return match;
    });
  }

  async recordTrade(trade: Omit<TradeRecord, "deployHash" | "blockTime">): Promise<TradeRecord> {
    return this.ledger.mutate((data) => {
      const match = mustFindMatch(data.matches, trade.matchId);
      if (match.status !== "active") throw new Error("Match is not active");
      if (trade.agent !== match.agentA && trade.agent !== match.agentB) throw new Error("Unauthorized agent");
      data.block += 1;
      const deploy = deployHash(`record-${trade.agentId}`);
      const record: TradeRecord = {
        ...trade,
        deployHash: deploy,
        blockTime: data.block
      };
      data.trades.push(record);
      match.tradeCount += 1;
      if (trade.agent === match.agentA) match.valueA = trade.portfolioValue;
      if (trade.agent === match.agentB) match.valueB = trade.portfolioValue;
      data.events.push(event(deploy, "trade_recorded", trade.matchId, record));
      return record;
    });
  }

  async settleMatch(args: {
    matchId: number;
    caller: string;
    finalValueA: number;
    finalValueB: number;
    settlementHash: string;
  }): Promise<MatchState> {
    return this.ledger.mutate((data) => {
      const match = mustFindMatch(data.matches, args.matchId);
      if (args.caller !== match.verifier) throw new Error("Unauthorized settle_match caller");
      if (match.status !== "active") throw new Error("Match is not active");
      data.block = Math.max(data.block + 1, match.endBlock);
      const hash = deployHash("settle-match");
      match.valueA = args.finalValueA;
      match.valueB = args.finalValueB;
      match.status = "settled";
      match.winner = args.finalValueA === args.finalValueB
        ? undefined
        : args.finalValueA > args.finalValueB ? match.agentA : match.agentB;
      match.settlementHash = args.settlementHash;
      match.settleDeployHash = hash;
      data.events.push(event(hash, "match_settled", args.matchId, match));
      return match;
    });
  }

  async getLatestMatch(): Promise<MatchState | undefined> {
    const data = await this.ledger.read();
    return data.matches.at(-1);
  }

  async getMatch(matchId: number): Promise<MatchState | undefined> {
    const data = await this.ledger.read();
    return data.matches.find((match) => match.id === matchId);
  }

  async listEvents(afterIndex = 0): Promise<ArenaEvent[]> {
    const data = await this.ledger.read();
    return data.events.slice(afterIndex);
  }
}

class LiveArenaClient implements ArenaClient {
  private readonly ledger: MockLedger;

  constructor(private readonly config: ArenaConfig) {
    // A live dashboard cache is only a projection of successful deploys. Keep it
    // separate for each contract so an earlier deployment can never pollute it.
    this.ledger = new MockLedger(arenaDataPath(`live-ledger-${ledgerContractId(config.contractHash)}.json`));
  }

  async createMatch(args: {
    creator: string;
    agentA: string;
    agentB: string;
    verifier: string;
    durationBlocks: number;
    startBudget: number;
  }): Promise<MatchState> {
    const data = await this.ledger.read();
    const deploy = await this.callContract("create_match", await this.args({
      agent_a: ["key", args.agentA],
      agent_b: ["key", args.agentB],
      verifier: ["key", args.verifier],
      duration_ms: ["u64", args.durationBlocks],
      start_budget: ["u512", args.startBudget],
      market_id: ["string", "CSPR/sCSPR/TREASURY"],
      rules_hash: ["string", sha256("arena-v2:virtual-portfolio:max-allocation-2500")]
    }), "creator");

    return this.ledger.mutate((data) => {
      const configuredId = positiveIntegerEnv("MATCH_ID");
      const id = data.matches.length === 0 ? (configuredId ?? data.nextMatchId) : data.nextMatchId;
      if (data.matches.some((match) => match.id === id)) {
        throw new Error(`Match ${id} already exists in this contract cache. Set MATCH_ID to the next on-chain match ID.`);
      }
      data.nextMatchId = Math.max(data.nextMatchId, id + 1);
      const match: MatchState = {
        id,
        creator: args.creator,
        agentA: args.agentA,
        agentB: args.agentB,
        verifier: args.verifier,
        startBlock: data.block,
        endBlock: data.block + args.durationBlocks,
        startBudget: args.startBudget,
        status: "pending",
        valueA: args.startBudget,
        valueB: args.startBudget,
        tradeCount: 0,
        createDeployHash: deploy.hash
      };
      data.matches.push(match);
      data.events.push(event(deploy.hash, "match_created", id, { ...match, csprLiveUrl: deploy.url }));
      return match;
    });
  }

  async startMatch(matchId: number, caller: string): Promise<MatchState> {
    const data = await this.ledger.read();
    const deploy = await this.callContract("start_match", await this.args({
      match_id: ["u64", matchId],
    }), roleForCaller(this.config, caller));

    return this.ledger.mutate((data) => {
      const match = mustFindMatch(data.matches, matchId);
      const duration = match.endBlock - match.startBlock;
      data.block += 1;
      match.status = "active";
      match.startBlock = data.block;
      match.endBlock = data.block + duration;
      match.startDeployHash = deploy.hash;
      data.events.push(event(deploy.hash, "match_started", matchId, { ...match, csprLiveUrl: deploy.url }));
      return match;
    });
  }

  async recordTrade(trade: Omit<TradeRecord, "deployHash" | "blockTime">): Promise<TradeRecord> {
    const data = await this.ledger.read();
    const deploy = await this.callContract("record_trade", await this.args({
      match_id: ["u64", trade.matchId],
      action: ["string", trade.action],
      amount: ["u512", trade.amount],
      price: ["u512", trade.price],
      portfolio_value: ["u512", trade.portfolioValue],
      reasoning_hash: ["string", trade.reasoningHash],
      evidence_hash: ["string", trade.evidenceHash]
    }), trade.agentId);

    return this.ledger.mutate((data) => {
      const match = mustFindMatch(data.matches, trade.matchId);
      data.block += 1;
      const record: TradeRecord = { ...trade, deployHash: deploy.hash, blockTime: data.block };
      data.trades.push(record);
      match.tradeCount += 1;
      if (trade.agent === match.agentA) match.valueA = trade.portfolioValue;
      if (trade.agent === match.agentB) match.valueB = trade.portfolioValue;
      data.events.push(event(deploy.hash, "trade_recorded", trade.matchId, { ...record, csprLiveUrl: deploy.url }));
      return record;
    });
  }

  async settleMatch(args: {
    matchId: number;
    caller: string;
    finalValueA: number;
    finalValueB: number;
    settlementHash: string;
  }): Promise<MatchState> {
    const data = await this.ledger.read();
    mustFindMatch(data.matches, args.matchId);
    const deploy = await this.callContract("settle_match", await this.args({
      match_id: ["u64", args.matchId],
      settlement_hash: ["string", args.settlementHash]
    }), "verifier");

    return this.ledger.mutate((data) => {
      const match = mustFindMatch(data.matches, args.matchId);
      data.block = Math.max(data.block + 1, match.endBlock);
      match.valueA = args.finalValueA;
      match.valueB = args.finalValueB;
      match.status = "settled";
      match.winner = args.finalValueA === args.finalValueB
        ? undefined
        : args.finalValueA > args.finalValueB ? match.agentA : match.agentB;
      match.settlementHash = args.settlementHash;
      match.settleDeployHash = deploy.hash;
      data.events.push(event(deploy.hash, "match_settled", args.matchId, { ...match, csprLiveUrl: deploy.url }));
      return match;
    });
  }

  async getLatestMatch(): Promise<MatchState | undefined> {
    const data = await this.ledger.read();
    return data.matches.at(-1);
  }

  async getMatch(matchId: number): Promise<MatchState | undefined> {
    const data = await this.ledger.read();
    return data.matches.find((match) => match.id === matchId);
  }

  async listEvents(afterIndex = 0): Promise<ArenaEvent[]> {
    const data = await this.ledger.read();
    return data.events.slice(afterIndex);
  }

  private async args(values: Record<string, ["string" | "u64" | "u512" | "key", string | number]>): Promise<any> {
    const sdk = await casperSdk();
    const mapped: Record<string, any> = {};
    for (const [key, [type, value]] of Object.entries(values)) {
      if (type === "string") mapped[key] = sdk.CLValue.newCLString(String(value));
      if (type === "u64") mapped[key] = sdk.CLValue.newCLUint64(toWholeString(value));
      if (type === "u512") mapped[key] = sdk.CLValue.newCLUInt512(toWholeString(value));
      if (type === "key") mapped[key] = sdk.CLValue.newCLPublicKey(sdk.PublicKey.fromHex(String(value)));
    }
    return sdk.Args.fromMap(mapped);
  }

  private async callContract(entryPoint: string, args: any, role: "creator" | "alpha" | "beta" | "verifier"): Promise<{ hash: string; url: string }> {
    if (!this.config.contractHash) throw new Error("ARENA_CONTRACT_HASH is required for ARENA_MODE=live.");
    const sdk = await casperSdk();
    const rpc = new sdk.RpcClient(new sdk.HttpHandler(this.config.rpcUrl));
    const key = loadPrivateKey(sdk, this.keyPath(role), this.keyAlgorithm(sdk));
    const session = new sdk.ExecutableDeployItem();
    session.storedContractByHash = new sdk.StoredContractByHash(
      sdk.ContractHash.newContract(stripHashPrefix(this.config.contractHash)),
      entryPoint,
      args
    );

    const header = sdk.DeployHeader.default();
    header.account = key.publicKey;
    header.chainName = this.config.chainName;
    const payment = sdk.ExecutableDeployItem.standardPayment(
      process.env.PAYMENT_MOTES ?? process.env.ARENA_PAYMENT_MOTES ?? "50000000000",
    );
    const deploy = sdk.Deploy.makeDeploy(header, payment, session);
    deploy.sign(key);

    const result = await putDeployWithRetry(rpc, deploy);
    const hash = hashToHex(result.deployHash ?? deploy.hash);
    await rpc.waitForDeploy(deploy, numberEnv("DEPLOY_TIMEOUT_MS", numberEnv("ARENA_DEPLOY_TIMEOUT_MS", 90_000)));
    const deployResult = await rpc.getDeploy(hash);
    const executionError = findExecutionError((deployResult as any).rawJSON ?? deployResult);
    if (executionError) {
      throw new Error(`Deploy ${hash} finalized but ${entryPoint} failed: ${executionError}`);
    }
    const url = `${this.config.csprLiveBaseUrl}/${hash}`;
    console.log(`[live:${entryPoint}] deploy=${hash} url=${url}`);
    return { hash, url };
  }

  private keyPath(role: "creator" | "alpha" | "beta" | "verifier"): string {
    const path = {
      creator: this.config.creatorKeyPath,
      alpha: this.config.alphaKeyPath,
      beta: this.config.betaKeyPath,
      verifier: this.config.verifierKeyPath
    }[role];
    if (!path) throw new Error(`ARENA_${role.toUpperCase()}_SECRET_KEY is required for live deploys.`);
    return path;
  }

  private keyAlgorithm(sdk: any): any {
    return process.env.ARENA_KEY_ALGORITHM === "secp256k1" ? sdk.KeyAlgorithm.SECP256K1 : sdk.KeyAlgorithm.ED25519;
  }
}

function ledgerContractId(contractHash: string | undefined): string {
  return (contractHash ?? "unconfigured").replace(/^contract-/, "").replace(/[^a-zA-Z0-9_-]/g, "");
}

function positiveIntegerEnv(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function casperSdk(): Promise<any> {
  const mod = await import("casper-js-sdk");
  return (mod as any).default ?? mod;
}

function loadPrivateKey(sdk: any, path: string, algorithm: any): any {
  const content = readFileSync(path, "utf8").trim();
  const privatePem = content.match(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/)?.[0];
  const rawHex = content.replace(/^0x/, "");
  const candidates = [
    () => sdk.PrivateKey.fromPem(privatePem ?? content, algorithm),
    () => sdk.PrivateKey.fromPem(privatePem ?? content, sdk.KeyAlgorithm.ED25519),
    () => sdk.PrivateKey.fromPem(privatePem ?? content, sdk.KeyAlgorithm.SECP256K1),
    () => sdk.PrivateKey.fromHex(rawHex, algorithm),
    () => sdk.PrivateKey.fromHex(rawHex, sdk.KeyAlgorithm.ED25519),
    () => sdk.PrivateKey.fromHex(rawHex, sdk.KeyAlgorithm.SECP256K1)
  ];
  for (const candidate of candidates) {
    try {
      return candidate();
    } catch {
      // Try the next supported Casper wallet export shape.
    }
  }
  throw new Error(`Could not load Casper private key from ${path}. Expected secret_key.pem, private_key.pem, or raw hex.`);
}

async function putDeployWithRetry(rpc: any, deploy: any): Promise<any> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await rpc.putDeploy(deploy);
    } catch (error) {
      lastError = error;
      if (attempt === 2 || !isNetworkError(error)) break;
      await sleep(5_000);
    }
  }
  throw lastError;
}

function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return ["network", "timeout", "econnreset", "econnrefused", "fetch", "socket", "temporarily"].some((token) => message.includes(token));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toWholeString(value: string | number): string {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`Invalid unsigned integer value: ${value}`);
  return Math.floor(parsed).toString();
}

function numberEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stripHashPrefix(hash: string): string {
  return hash.replace(/^hash-/, "").replace(/^contract-/, "");
}

function hashToHex(hash: unknown): string {
  if (typeof hash === "string") return hash;
  if (hash && typeof (hash as { toHex?: unknown }).toHex === "function") {
    return String((hash as { toHex: () => string }).toHex());
  }
  return String(hash);
}

function findExecutionError(value: unknown): string | undefined {
  let found: string | undefined;
  const visit = (node: unknown): void => {
    if (found || !node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (/error_message/i.test(key) && typeof child === "string" && child.trim()) {
        found = child;
        return;
      }
      visit(child);
    }
  };
  visit(value);
  return found;
}

function roleForCaller(config: ArenaConfig, caller: string): "creator" | "alpha" | "beta" | "verifier" {
  const data = readLiveLedger();
  const latest = data.matches.at(-1);
  if (latest?.agentA === caller) return "alpha";
  if (latest?.agentB === caller) return "beta";
  if (latest?.verifier === caller) return "verifier";
  if (config.verifierKeyPath && caller.includes("verifier")) return "verifier";
  return "creator";
}

function readLiveLedger(): MockLedgerData {
  try {
    return JSON.parse(readFileSync(".arena/live-ledger.json", "utf8")) as MockLedgerData;
  } catch {
    return { nextMatchId: 1, block: 1, matches: [], trades: [], events: [] };
  }
}

function mustFindMatch(matches: MatchState[], id: number): MatchState {
  const match = matches.find((candidate) => candidate.id === id);
  if (!match) throw new Error(`Match ${id} not found`);
  return match;
}

function event(
  deployHashValue: string,
  type: ArenaEvent["type"],
  matchId: number,
  payload: object
): ArenaEvent {
  return {
    id: sha256(`${deployHashValue}:${type}:${Date.now()}`),
    type,
    timestamp: new Date().toISOString(),
    deployHash: deployHashValue,
    matchId,
    payload: payload as Record<string, unknown>
  };
}
