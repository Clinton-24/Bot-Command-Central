import app from "./app";
import { logger } from "./lib/logger";
import { getBotInstance } from "./bot/index";
import { registerBatteryWebhook } from "./bot/handlers/battery";
import { webhookCallback } from "grammy";
import { Pool } from "pg";
import nodemailer from "nodemailer";
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

// ── Daily DB health report ────────────────────────────────────────────────────

const dbPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: true })
  : null;

async function runDatabaseHealthCheck(): Promise<void> {
  if (!dbPool) return;
  try {
    const client = await dbPool.connect();
    const res = await client.query(`
      SELECT pg_size_pretty(pg_database_size(current_database())) as size,
             pg_database_size(current_database())::float / (1024*1024*1024) as size_gb
    `);
    client.release();

    const size = res.rows[0].size;
    const sizeGb = parseFloat(res.rows[0].size_gb ?? 0);
    const report =
      `🗄️ *Daily Database Report* — ${new Date().toDateString()}\n\n` +
      `📊 Storage: ${size} (${sizeGb.toFixed(2)} GB)\n` +
      `${sizeGb > 8 ? "⚠️ WARNING: Storage getting full!" : "✅ Storage looks healthy"}`;

    const ownerIdStr = process.env.BOT_OWNER_ID;
    if (ownerIdStr) {
      await bot.api.sendMessage(ownerIdStr, report, { parse_mode: "Markdown" }).catch(() => {});
    }

    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST ?? "smtp.atomicmail.com",
        port: Number(process.env.EMAIL_PORT ?? 587),
        secure: false,
        auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      });
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: "nullryns@atomicmail.io",
        subject: `📊 Database Report — ${new Date().toDateString()}`,
        text: report,
      }).catch(() => {});
    }

    logger.info("Daily database report sent");
  } catch (err) {
    logger.error({ err }, "Database health check failed");
  }
}

// ── Cron jobs ─────────────────────────────────────────────────────────────────

cron.schedule("0 8 * * *", runDatabaseHealthCheck, { timezone: "Africa/Nairobi" });

const ownerId = process.env.BOT_OWNER_ID ? Number(process.env.BOT_OWNER_ID) : NaN;
if (!isNaN(ownerId)) {
  logger.info("Harmony DB health checks scheduled every 6 hours");
  cron.schedule("0 */6 * * *", () => runExternalDbChecks(bot, ownerId), { timezone: "Africa/Nairobi" });
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
      // silent — just a ping
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

  // 4. Run DB health check after 10s on startup
  setTimeout(runDatabaseHealthCheck, 10_000);
});
