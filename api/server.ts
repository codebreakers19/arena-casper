import express from "express";
import cors from "cors";
import { readFile } from "node:fs/promises";
import { join } from "path";
import { createArenaClient } from "../agents/shared/arena-client.js";
import { loadConfig } from "../agents/shared/config.js";
import { arenaDataPath } from "../agents/shared/storage.js";
import { startMatchCoordinator } from "./match-coordinator.js";

const config = loadConfig();
const client = createArenaClient(config);
const app = express();
const port = Number(process.env.PORT ?? process.env.SPECTATOR_PORT ?? 3001);

app.use(cors());
app.use(express.static("public"));

app.get("/api/config", (_req, res) => {
  res.json({
    network: config.network,
    csprClickAppId: process.env.CSPR_CLICK_APP_ID ?? "csprclick-template",
    apiBaseUrl: process.env.ARENA_API_BASE_URL ?? "",
    contractHash: config.contractHash ?? null,
    contractDeployHash: process.env.ARENA_CONTRACT_DEPLOY_HASH ?? null,
    marketMode: "verified-shadow-portfolio",
  });
});

app.get("/api/health", (_req, res) => {
  res.status(200).json({ status: "ok", mode: config.mode, contractHash: config.contractHash ?? null });
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(join(process.cwd(), "public/dashboard.html"));
});

app.get("/api/match", async (_req, res) => {
  const match = await client.getLatestMatch();
  if (!match || config.mode !== "live") {
    res.json(match);
    return;
  }
  const started = (await client.listEvents(0)).find((event) => event.matchId === match.id && event.type === "match_started");
  const startTimeMs = started ? Date.parse(started.timestamp) : undefined;
  res.json({
    ...match,
    startTimeMs,
    endTimeMs: startTimeMs ? startTimeMs + config.matchDurationMs : undefined
  });
});

app.get("/api/events", async (_req, res) => {
  res.json(await client.listEvents(0));
});

app.get("/api/evidence/:hash", async (req, res) => {
  const hash = req.params.hash;
  if (!/^[a-f0-9]{64}$/i.test(hash)) {
    res.status(400).json({ error: { code: "invalid_input", message: "Evidence hash must be a SHA-256 digest." } });
    return;
  }
  try {
    const evidence = await readFile(join(arenaDataPath("evidence"), `${hash}.json`), "utf8");
    res.type("application/json").send(evidence);
  } catch {
    res.status(404).json({ error: { code: "not_found", message: "Evidence is not available on this server." } });
  }
});

app.get("/events", async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  let cursor = 0;
  const send = async () => {
    const events = await client.listEvents(cursor);
    for (const event of events) {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
    cursor += events.length;
  };

  await send();
  const timer = setInterval(() => {
    send().catch((error) => {
      res.write(`event: error\n`);
      res.write(`data: ${JSON.stringify({ message: error.message })}\n\n`);
    });
  }, 1_000);

  req.on("close", () => clearInterval(timer));
});

if (process.env.ARENA_AUTORUN === "true") startMatchCoordinator();

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Arena spectator running at http://localhost:${port}`);
  });
}

export default app;
