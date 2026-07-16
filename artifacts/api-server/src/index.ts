import app from "./app";
import { logger } from "./lib/logger";
import { getBotInstance } from "./bot/index";
import { registerBatteryWebhook } from "./bot/handlers/battery";
import { webhookCallback } from "grammy";
import cron from "node-cron";
import { runExternalDbChecks } from "./bot/handlers/extdblogs";
import { runMigrations } from "./lib/migrate";

// ── Port ──────────────────────────────────────────────────────────────────────

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required");
const port = Number(rawPort);

// ── Bot & routes ──────────────────────────────────────────────────────────────

const bot = getBotInstance();
registerBatteryWebhook(app, bot);
app.post("/bot", webhookCallback(bot, "express"));
app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

// ── Cron jobs ─────────────────────────────────────────────────────────────────

const ownerId = process.env.BOT_OWNER_ID ? Number(process.env.BOT_OWNER_ID) : NaN;

if (!isNaN(ownerId)) {
  // Harmony DB checks every 6 hours
  cron.schedule("0 */6 * * *", () => runExternalDbChecks(bot, ownerId), { timezone: "Africa/Nairobi" });
  logger.info("Harmony DB health checks scheduled every 6 hours");
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
