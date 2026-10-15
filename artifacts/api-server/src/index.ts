import app from "./app";
import { logger } from "./lib/logger";
import { getBotInstance } from "./bot/index";
import { registerBatteryWebhook } from "./bot/handlers/battery";
import { webhookCallback } from "grammy";
import { runMigrations } from "./lib/migrate";
import { createCryptoBotRouter } from "./bot/handlers/cryptobot";
import { getKillStatus } from "./bot/handlers/kill";
import { isGmailOAuthAppConfigured, exchangeCodeAndSave, verifyOAuthState } from "./lib/gmail";
import { pool } from "@workspace/db";
import type { Request, Response, NextFunction } from "express";

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required");
const port = Number(rawPort);

const bot = getBotInstance();
registerBatteryWebhook(app, bot);

// Grammy webhook — never return 500 to Telegram (retries storm); log and ack
const handleUpdate = webhookCallback(bot, "express");
app.post("/bot", async (req: Request, res: Response, next: NextFunction) => {
  try {
    await handleUpdate(req, res, next);
  } catch (err) {
    logger.error({ err }, "webhook handler crashed");
    if (!res.headersSent) {
      res.status(200).json({ ok: true });
    }
  }
});

app.use("/api", createCryptoBotRouter(bot));

app.get("/", (_req, res) => {
  const kill = getKillStatus();
  res.status(200).json({
    service: "Crescent",
    status: kill.killed ? "killed" : "ok",
    health: "/health",
    uptime: process.uptime(),
  });
});

app.get("/health", async (_req, res) => {
  const kill = getKillStatus();
  let dbOk = false;
  let dbError: string | undefined;
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("db timeout")), 3_000)),
    ]);
    dbOk = true;
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }

  res.status(200).json({
    status: kill.killed ? "killed" : dbOk ? "ok" : "degraded",
    uptime: process.uptime(),
    kill,
    database: dbOk ? "ok" : "error",
    ...(dbError ? { databaseError: dbError } : {}),
    gmailOAuthConfigured: isGmailOAuthAppConfigured(),
    timestamp: new Date().toISOString(),
  });
});
app.get("/healthz", (_req, res) => {
  res.status(200).send("ok");
});

app.get("/test-ai", async (_req, res) => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return res.json({ ok: false, error: "OPENROUTER_API_KEY not set" });
  }
  const models = [
    "openrouter/free",
    "google/gemma-4-26b-a4b-it:free",
    "openai/gpt-4o-mini",
  ];
  const results: Record<string, string> = {};
  for (const model of models) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "Reply with OK only" }],
          max_tokens: 8,
        }),
      });
      const j = (await r.json()) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } };
      results[model] = r.ok
        ? (j.choices?.[0]?.message?.content ?? "ok").slice(0, 80)
        : `ERR ${r.status}: ${j.error?.message ?? r.statusText}`;
    } catch (e) {
      results[model] = e instanceof Error ? e.message : String(e);
    }
  }
  res.json({ ok: true, results });
});

app.get("/auth/gmail/callback", async (req, res) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const userId = verifyOAuthState(state);
    if (!userId || !code) {
      res.status(400).send("<h2>Invalid or expired link</h2><p>Go back to Telegram and run /connect_gmail again.</p>");
      return;
    }

    const { email } = await exchangeCodeAndSave(userId, code);

    try {
      await bot.api.sendMessage(
        userId,
        `✅ Gmail connected\n━━━━━━━━━━━━━━━━━━\n\n` +
          (email ? `📬 ${email}\n\n` : "") +
          `Your inbox will appear in:\n• /inbox\n• /digest\n• Daily 10:00 Nairobi briefing\n\n/disconnect_gmail to remove access.`,
      );
    } catch (notifyErr) {
      logger.warn({ notifyErr, userId }, "Could not notify user after Gmail connect");
    }

    res
      .status(200)
      .send(
        `<html><body style="font-family:system-ui;padding:2rem">` +
          `<h2>✅ Gmail connected</h2>` +
          `<p>${email ? `Account: <b>${email}</b>` : "Your inbox is linked."}</p>` +
          `<p>Return to Telegram — you're done.</p>` +
          `</body></html>`,
      );
  } catch (e) {
    logger.error({ err: e }, "Gmail OAuth callback failed");
    res
      .status(500)
      .send(
        `<h2>Connection failed</h2><p>${e instanceof Error ? e.message : "Unknown error"}</p>` +
          `<p>Try /connect_gmail again in Telegram.</p>`,
      );
  }
});

function startKeepAlive(): void {
  const renderUrl = process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, "");
  if (!renderUrl) {
    logger.warn("RENDER_EXTERNAL_URL not set — keep-alive disabled");
    return;
  }
  const pingUrl = `${renderUrl}/health`;
  logger.info({ pingUrl }, "Keep-alive pinger started (every 2 min)");
  setInterval(async () => {
    try {
      await fetch(pingUrl, { signal: AbortSignal.timeout(10_000) });
    } catch {
      // silent
    }
  }, 2 * 60 * 1000);
}

app.listen(port, async (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error starting server");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  try {
    await runMigrations();
  } catch (err) {
    logger.error({ err }, "Startup migrations failed — continuing anyway");
  }

  const webhookUrl = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "")}/bot`
    : `http://localhost:${port}/bot`;

  try {
    await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true });
    logger.info({ url: webhookUrl }, "Telegram webhook set");
  } catch (err) {
    logger.error({ err }, "Failed to set Telegram webhook");
  }

  startKeepAlive();
});
