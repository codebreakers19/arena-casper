import { createArenaClient } from "../agents/shared/arena-client.js";
import { agentAccount, loadConfig } from "../agents/shared/config.js";

const config = loadConfig();
if (config.mode !== "live") throw new Error("Set ARENA_MODE=live before running live scripts.");
if (!process.env.MATCH_ID || !Number.isSafeInteger(Number(process.env.MATCH_ID)) || Number(process.env.MATCH_ID) < 1) {
  throw new Error("MATCH_ID must be the next on-chain match ID for this contract. Use 1 for a newly deployed contract.");
}

const client = createArenaClient(config);
const match = await client.createMatch({
  creator: agentAccount("creator"),
  agentA: agentAccount("alpha"),
  agentB: agentAccount("beta"),
  verifier: agentAccount("verifier"),
  durationBlocks: config.matchDurationMs,
  startBudget: config.matchStartBudget
});

console.log(`MATCH_ID=${match.id}`);
console.log(`CREATE_DEPLOY=${match.createDeployHash}`);
console.log(`CREATE_URL=${config.csprLiveBaseUrl}/${match.createDeployHash}`);
