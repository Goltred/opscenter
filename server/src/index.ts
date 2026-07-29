import fs from "node:fs";
import path from "node:path";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import { config, listenPort } from "./config.js";
import { openDb } from "./db.js";
import { bootstrap } from "./bootstrap.js";
import { authRouter } from "./routes/auth.js";
import { apiRouter } from "./routes/api.js";
import { parseAgentPort, startAgentGateway } from "./agent/gateway.js";
import { getSecretsKey } from "./secrets.js";

async function main() {
  openDb();
  getSecretsKey(); // ensure encryption key exists early (env or auto file)
  await bootstrap();

  const app = express();
  app.set("trust proxy", 1);
  app.use(cookieParser());
  app.use(express.json({ limit: "2mb" }));

  if (config.devMode) {
    app.use(
      cors({
        origin: [config.webOrigin, "http://localhost:5173", "http://127.0.0.1:5173"],
        credentials: true,
      }),
    );
  }

  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/metrics", (_req, res) => res.type("text/plain").send("# OpsCenter node kickstart\n"));

  app.use("/api/auth", authRouter);
  app.use("/api", apiRouter);

  const webDir = path.resolve(config.webDir);
  if (fs.existsSync(webDir)) {
    app.use(express.static(webDir));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/metrics") || req.path.startsWith("/agent")) return next();
      res.sendFile(path.join(webDir, "index.html"));
    });
  }

  const port = listenPort();
  app.listen(port, () => {
    console.log(`OpsCenter (Node) listening on http://localhost:${port}`);
    console.log(`devMode=${config.devMode} db=${config.databaseUrl}`);
    console.log(
      config.bootstrapOwners
        ? `sign in via OAuth; bootstrap owners: ${config.bootstrapOwners}`
        : "sign in via OAuth; set OC_BOOTSTRAP_OWNERS to seed the first Owner",
    );
  });

  startAgentGateway(parseAgentPort(config.agentAddr));
  const { startScheduleRunner } = await import("./schedules/runner.js");
  startScheduleRunner();
  const { startDiscordBot } = await import("./discord/bot.js");
  void startDiscordBot();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
