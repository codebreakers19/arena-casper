import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { arenaDataPath } from "./storage.js";
import type { ArenaEvent, MatchState, TradeRecord } from "./types.js";

export interface MockLedgerData {
  nextMatchId: number;
  block: number;
  matches: MatchState[];
  trades: TradeRecord[];
  events: ArenaEvent[];
}

const defaultData: MockLedgerData = {
  nextMatchId: 1,
  block: 1,
  matches: [],
  trades: [],
  events: []
};

export class MockLedger {
  constructor(private readonly path = arenaDataPath("mock-ledger.json")) {}

  async read(): Promise<MockLedgerData> {
    try {
      return JSON.parse(await readFile(this.path, "utf8")) as MockLedgerData;
    } catch {
      return structuredClone(defaultData);
    }
  }

  async write(data: MockLedgerData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tempPath, this.path);
  }

  async mutate<T>(fn: (data: MockLedgerData) => T): Promise<T> {
    const data = await this.read();
    const result = fn(data);
    await this.write(data);
    return result;
  }
}
