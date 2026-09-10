import app from "./app";
import { logger } from "./lib/logger";
import { getBotInstance } from "./bot/index";
import { registerBatteryWebhook } from "./bot/handlers/battery";
import { webhookCallback } from "grammy";
import cron from "node-cron";
import { runExternalDbChecks } from "./bot/handlers/extdblogs";
import { runMigrations } from "./lib/migrate";
import { createCryptoBotRouter } from "./bot/handlers/cryptobot";

// ── Port ──────────────────────────────────────────────────────────────────────

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required");
const port = Number(rawPort);

// ── Bot & routes ──────────────────────────────────────────────────────────────

const bot = getBotInstance();
registerBatteryWebhook(app, bot);
app.post("/bot", webhookCallback(bot, "express"));
// CryptoBot webhook
app.use("/api", createCryptoBotRouter(bot));

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

// Quick AI test endpoint — GET /test-ai to verify OpenRouter is working
app.get("/test-ai", async (_req, res) => {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    return res.json({ ok: false, error: "OPENROUTER_API_KEY not set" });
  }
  const models = [
    "google/gemini-2.0-flash-exp:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "google/gemma-3-27b-it:free",
  ];
  const results: Record<string, string> = {};
  for (const model of models) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://bot-command-central-1.onrender.com",
        },
        body: JSON.stringify({
          model,
          max_tokens: 20,
          messages: [{ role: "user", content: "Reply with just: OK" }],
        }),
      });
      if (!r.ok) {
        results[model] = `HTTP ${r.status}`;
        continue;
      }
      const d = await r.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message: string } };
      results[model] = d.error ? `error: ${d.error.message}` : (d.choices?.[0]?.message?.content ?? "empty") + " ✅";
    } catch (err) {
      results[model] = `exception: ${err instanceof Error ? err.message : "unknown"}`;
    }
  }
  return res.json({ ok: true, key: key.slice(0, 12) + "...", results });
});

// ── Cron jobs ─────────────────────────────────────────────────────────────────

const ownerId = process.env.BOT_OWNER_ID ? Number(process.env.BOT_OWNER_ID) : NaN;

if (!isNaN(ownerId)) {
  // Harmony DB checks every 6 hours
  // Harmony DB health checks run silently every 6 hours — no Telegram notifications
  // Notifications only go out if there is a FAILURE or WARNING — not on success
  cron.schedule("0 */6 * * *", async () => {
    try {
      await runExternalDbChecks(bot, ownerId, { silentOnSuccess: true });
    } catch (err) {
      logger.error({ err }, "Harmony DB check cron error");
    }
  }, { timezone: "Africa/Nairobi" });
  logger.info("Harmony DB health checks scheduled (silent success, notify on failure only)");
} else {
  logger.warn("BOT_OWNER_ID not set — Harmony DB checks disabled");
}

// ── Keep-alive (prevents Render free tier from sleeping) ──────────────────────

function startKeepAlive(): void {
  const renderUrl = process.env.RENDER_EXTERNAL_URL?.replace(/\/$/, "");
  if (!renderUrl) {
    logger.warn("RENDER_EXTERNAL_URL not set — keep-alive disabled");
    return;
  }
  const pingUrl = `${renderUrl}/health`;
  logger.info({ pingUrl }, "Keep-alive pinger started (every 4 min)");
  setInterval(async () => {
    try {
      await fetch(pingUrl, { signal: AbortSignal.timeout(10_000) });
    } catch {
      // silent
    }
  }, 4 * 60 * 1000);
}

// ── Server start ──────────────────────────────────────────────────────────────

app.listen(port, async (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error starting server");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // 1. Run DB migrations
  try {
    await runMigrations();
  } catch (err) {
    logger.error({ err }, "Startup migrations failed — continuing anyway");
  }

  // 2. Set Telegram webhook
  const webhookUrl = process.env.RENDER_EXTERNAL_URL
    ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "")}/bot`
    : `http://localhost:${port}/bot`;

  try {
    await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true });
    logger.info({ url: webhookUrl }, "Telegram webhook set");
  } catch (err) {
    logger.error({ err }, "Failed to set Telegram webhook");
  }

  // 3. Start keep-alive pinger
  startKeepAlive();
});
