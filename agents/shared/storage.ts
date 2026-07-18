import { join } from "node:path";

export function arenaDataPath(...segments: string[]): string {
  return join(process.env.ARENA_DATA_DIR?.trim() || ".arena", ...segments);
}
