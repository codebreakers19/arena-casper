import "../agents/shared/env.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const sdk = await import("casper-js-sdk");

const accounts = [
  { role: "alpha", keyPath: process.env.ARENA_ALPHA_SECRET_KEY ?? process.env.AGENT_ALPHA_KEY_PATH, publicKey: process.env.ARENA_ALPHA_ACCOUNT },
  { role: "beta", keyPath: process.env.ARENA_BETA_SECRET_KEY ?? process.env.AGENT_BETA_KEY_PATH, publicKey: process.env.ARENA_BETA_ACCOUNT },
  { role: "verifier", keyPath: process.env.ARENA_VERIFIER_SECRET_KEY ?? process.env.VERIFIER_KEY_PATH, publicKey: process.env.ARENA_VERIFIER_ACCOUNT },
];

const wasmPath = resolve("contracts/arena/wasm/ArenaContractModule.wasm");
if (!existsSync(wasmPath)) throw new Error(`Missing contract WASM: ${wasmPath}`);
console.log(`WASM_OK=${wasmPath}`);

for (const account of accounts) {
  if (!account.keyPath) throw new Error(`Missing key path for ${account.role}`);
  if (!account.publicKey) throw new Error(`Missing public key for ${account.role}`);
  const key = loadPrivateKey(account.keyPath);
  const actual = key.publicKey.toHex();
  if (actual !== account.publicKey) {
    throw new Error(`${account.role} key mismatch. env=${account.publicKey} pem=${actual}`);
  }
  console.log(`${account.role.toUpperCase()}_KEY_OK=${actual}`);
}

const rpcUrl = process.env.ARENA_RPC_URL ?? process.env.TESTNET_RPC ?? "https://rpc.testnet.casperlabs.io/rpc";
const rpc = new sdk.RpcClient(new sdk.HttpHandler(rpcUrl));
for (const account of accounts) {
  const publicKey = sdk.PublicKey.fromHex(account.publicKey!);
  const info = await rpc.getAccountInfo(null, { publicKey });
  const mainPurse = (info as any).account?.mainPurse ?? (info as any).rawJSON?.account?.main_purse ?? "unknown";
  console.log(`${account.role.toUpperCase()}_ACCOUNT_FOUND=${mainPurse}`);
}

function loadPrivateKey(path: string): any {
  const content = readFileSync(path, "utf8").trim();
  const privatePem = content.match(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/)?.[0];
  const rawHex = content.replace(/^0x/, "");
  const candidates = [
    () => sdk.PrivateKey.fromPem(privatePem ?? content, sdk.KeyAlgorithm.ED25519),
    () => sdk.PrivateKey.fromPem(privatePem ?? content, sdk.KeyAlgorithm.SECP256K1),
    () => sdk.PrivateKey.fromHex(rawHex, sdk.KeyAlgorithm.ED25519),
    () => sdk.PrivateKey.fromHex(rawHex, sdk.KeyAlgorithm.SECP256K1),
  ];
  for (const candidate of candidates) {
    try {
      return candidate();
    } catch {
      // Try next format.
    }
  }
  throw new Error(`Could not load key from ${path}`);
}
