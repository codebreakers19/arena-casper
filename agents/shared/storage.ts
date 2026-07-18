import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function arenaDataPath(...segments: string[]): string {
  return join(process.env.ARENA_DATA_DIR?.trim() || ".arena", ...segments);
}

export async function assertArenaDataWritable(): Promise<void> {
  const directory = arenaDataPath();
  const probe = join(directory, `.arena-write-check-${process.pid}`);
  await mkdir(directory, { recursive: true });
  await writeFile(probe, "ok", "utf8");
  await rename(probe, `${probe}.verified`);
  await rm(`${probe}.verified`);
}
