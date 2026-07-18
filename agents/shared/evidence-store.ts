import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256 } from "./hash.js";
import { arenaDataPath } from "./storage.js";
import type { EvidenceRecord } from "./types.js";

const EVIDENCE_DIR = arenaDataPath("evidence");

export async function writeEvidence(record: Omit<EvidenceRecord, "hash">): Promise<{ hash: string; url: string }> {
  const canonical = JSON.stringify(record);
  const hash = sha256(canonical);
  const path = join(EVIDENCE_DIR, `${hash}.json`);
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify({ hash, ...record }, null, 2)}\n`, "utf8");
  await rename(temp, path);
  return { hash, url: `/api/evidence/${hash}` };
}
