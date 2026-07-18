import "../agents/shared/env.js";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const WASM_PATH = resolve("contracts/arena/wasm/ArenaContractModule.wasm");
const RAW_DEPLOY_PATH = resolve(".arena/live-contract-deploy.json");

const rpcUrl = process.env.ARENA_RPC_URL ?? process.env.TESTNET_RPC ?? "https://rpc.testnet.casperlabs.io/rpc";
const chainName = process.env.ARENA_CHAIN_NAME ?? "casper-test";
const keyPath = process.env.ARENA_VERIFIER_SECRET_KEY ?? process.env.VERIFIER_KEY_PATH ?? "./keys/verifier.pem";
const paymentMotes = process.env.CONTRACT_DEPLOY_PAYMENT_MOTES ?? "500000000000";
const timeoutMs = numberEnv("DEPLOY_TIMEOUT_MS", 180_000);
const csprLiveBaseUrl = process.env.CSPR_LIVE_BASE_URL ?? "https://testnet.cspr.live/deploy";

const sdk = await import("casper-js-sdk");
const rpc = new sdk.RpcClient(new sdk.HttpHandler(rpcUrl));
const key = loadPrivateKey(keyPath);

optimizeWasmIfPossible(WASM_PATH);
assertNoBulkMemoryOps(WASM_PATH);
const wasm = readFileSync(WASM_PATH);

const odraPackageKey = process.env.ARENA_PACKAGE_KEY_NAME ?? "arena_contract_package_hash";
const session = sdk.ExecutableDeployItem.newModuleBytes(
  wasm,
  sdk.Args.fromMap({
    odra_cfg_package_hash_key_name: sdk.CLValue.newCLString(odraPackageKey),
    odra_cfg_allow_key_override: sdk.CLValue.newCLValueBool(true),
    odra_cfg_is_upgradable: sdk.CLValue.newCLValueBool(true),
    odra_cfg_is_upgrade: sdk.CLValue.newCLValueBool(false),
    odra_cfg_create_upgrade_group: sdk.CLValue.newCLValueBool(false),
  })
);
const payment = sdk.ExecutableDeployItem.standardPayment(paymentMotes);
const header = sdk.DeployHeader.default();
header.account = key.publicKey;
header.chainName = chainName;

const deploy = sdk.Deploy.makeDeploy(header, payment, session);
deploy.sign(key);

console.log(`[deploy] wasm=${WASM_PATH}`);
console.log(`[deploy] account=${key.publicKey.toHex()}`);
console.log(`[deploy] rpc=${rpcUrl}`);
console.log(`[deploy] payment_motes=${paymentMotes}`);
console.log(`[deploy] odra_package_key=${odraPackageKey}`);

const putResult = await putDeployWithRetry(rpc, deploy);
const deployHash = hashToHex(putResult.deployHash ?? deploy.hash);
console.log(`DEPLOY_HASH=${deployHash}`);
console.log(`DEPLOY_URL=${csprLiveBaseUrl}/${deployHash}`);

await rpc.waitForDeploy(deploy, timeoutMs);
const deployResult = await rpc.getDeploy(deployHash);
mkdirSync(dirname(RAW_DEPLOY_PATH), { recursive: true });
writeFileSync(RAW_DEPLOY_PATH, JSON.stringify((deployResult as any).rawJSON ?? deployResult, null, 2));

const raw = (deployResult as any).rawJSON ?? deployResult;
const executionError = findExecutionError(raw);
if (executionError) {
  throw new Error(`Deploy finalized but execution failed: ${executionError}. Inspect ${RAW_DEPLOY_PATH}.`);
}
const contractHash = findContractHash(raw);
const packageHash = findPackageHash(raw);
if (!contractHash) {
  const candidates = [...new Set(JSON.stringify(raw).match(/(?:contract-|contract-package-|hash-)[0-9a-fA-F]{64}/g) ?? [])];
  console.log(`HASH_CANDIDATES=${candidates.join(",")}`);
  throw new Error(`Deploy finalized but contract hash was not parsed. Inspect ${RAW_DEPLOY_PATH}.`);
}

updateEnv("ARENA_MODE", "live");
updateEnv("ARENA_CONTRACT_HASH", contractHash);
updateEnv("ARENA_PACKAGE_HASH", packageHash ?? process.env.ARENA_PACKAGE_HASH ?? "");
updateEnv("CONTRACT_DEPLOY_HASH", deployHash);

console.log(`ARENA_CONTRACT_HASH=${contractHash}`);
if (packageHash) console.log(`ARENA_PACKAGE_HASH=${packageHash}`);
console.log(`[deploy] raw result saved to ${RAW_DEPLOY_PATH}`);

function optimizeWasmIfPossible(wasmPath: string): void {
  const binaryenWasmOpt = resolve("node_modules/binaryen/bin/wasm-opt");
  const localWasmOpt = process.platform === "win32"
    ? resolve("node_modules/.bin/wasm-opt.cmd")
    : resolve("node_modules/.bin/wasm-opt");
  const command = existsSync(binaryenWasmOpt) ? process.execPath : localWasmOpt;
  const prefixArgs = existsSync(binaryenWasmOpt) ? [binaryenWasmOpt] : [];
  if (!existsSync(localWasmOpt)) {
    console.warn("[deploy] npm binaryen wasm-opt not found; skipping automatic wasm optimization");
    return;
  }
  execFileSync(command, [
    ...prefixArgs,
    "--signext-lowering",
    "--llvm-memory-copy-fill-lowering",
    "--disable-bulk-memory",
    wasmPath,
    "-o",
    wasmPath,
  ], { stdio: "inherit" });
}

function assertNoBulkMemoryOps(wasmPath: string): void {
  const wasmDis = resolve("node_modules/binaryen/bin/wasm-dis");
  if (!existsSync(wasmDis)) {
    console.warn("[deploy] wasm-dis is unavailable; skipping textual bulk-memory validation");
    return;
  }
  const disassembly = execFileSync(process.execPath, [wasmDis, wasmPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (/memory\.(copy|fill)/.test(disassembly)) {
    throw new Error("WASM still contains unsupported bulk-memory instructions.");
  }
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
      // Try the next supported Casper wallet export shape.
    }
  }
  throw new Error(`Could not load verifier key from ${path}.`);
}

async function putDeployWithRetry(rpcClient: any, signedDeploy: any): Promise<any> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await rpcClient.putDeploy(signedDeploy);
    } catch (error) {
      lastError = error;
      if (attempt === 2 || !isNetworkError(error)) break;
      await new Promise((resolveRetry) => setTimeout(resolveRetry, 5_000));
    }
  }
  throw lastError;
}

function isNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return ["network", "timeout", "econnreset", "econnrefused", "fetch", "socket", "temporarily"].some((token) => message.includes(token));
}

function findContractHash(value: unknown): string | undefined {
  const hits = collectHashHits(value);
  const versionHash = hits.find((hit) => /contract_hash/i.test(hit.keyPath) && /^contract-[0-9a-fA-F]{64}$/.test(hit.value));
  if (versionHash) return versionHash.value;

  const contractWrite = hits.find((hit) => /kind\.Write\.Contract|Write\.Contract/i.test(hit.keyPath) && /^(?:hash-|contract-)[0-9a-fA-F]{64}$/.test(hit.value));
  if (contractWrite) return contractWrite.value.replace(/^hash-/, "contract-");

  return hits.find((hit) => /^contract-[0-9a-fA-F]{64}$/.test(hit.value))?.value;
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

function findPackageHash(value: unknown): string | undefined {
  const hits = collectHashHits(value);
  const namedPackageKey = hits.find((hit) => /arena_contract_package_hash/i.test(hit.keyPath) && /^hash-[0-9a-fA-F]{64}$/.test(hit.value));
  if (namedPackageKey) return namedPackageKey.value;

  const packageWrite = hits.find((hit) => /kind\.Write\.ContractPackage|Write\.ContractPackage/i.test(hit.keyPath) && /^hash-[0-9a-fA-F]{64}$/.test(hit.value));
  return packageWrite?.value;
}

function collectHashHits(value: unknown): Array<{ keyPath: string; value: string }> {
  const hits: Array<{ keyPath: string; value: string }> = [];
  walk(value, [], hits);
  return hits;
}

function walk(value: unknown, path: Array<string | number>, hits: Array<{ keyPath: string; value: string }>): void {
  if (typeof value === "string") {
    if (/^(?:hash-|contract-|contract-package-)[0-9a-fA-F]{64}$/.test(value)) {
      hits.push({ keyPath: path.join("."), value });
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    walk(child, [...path, key], hits);
  }
}

function updateEnv(name: string, value: string): void {
  const envPath = resolve(".env");
  let content = "";
  try {
    content = readFileSync(envPath, "utf8");
  } catch {
    // Create a new env file.
  }
  const line = `${name}=${value}`;
  if (new RegExp(`^${name}=.*$`, "m").test(content)) {
    content = content.replace(new RegExp(`^${name}=.*$`, "m"), line);
  } else {
    content = `${content.trimEnd()}\n${line}\n`;
  }
  writeFileSync(envPath, content);
}

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hashToHex(hash: unknown): string {
  if (typeof hash === "string") return hash;
  if (hash && typeof (hash as { toHex?: unknown }).toHex === "function") {
    return String((hash as { toHex: () => string }).toHex());
  }
  return String(hash);
}
