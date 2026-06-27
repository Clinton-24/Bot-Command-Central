import app from "./app";
import { logger } from "./lib/logger";
import { getBotInstance } from "./bot/index";
import { registerBatteryWebhook } from "./bot/handlers/battery";
import { webhookCallback } from "grammy";
import { Pool } from 'pg';
import nodemailer from 'nodemailer';
import cron from 'node-cron';

const rawPort = process.env["PORT"];
if (!rawPort) throw new Error("PORT environment variable is required");
const port = Number(rawPort);

const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL ? new Pool({ 
  connectionString: DATABASE_URL, 
  ssl: true 
}) : null;

const transporter = nodemailer.createTransport({
  host: "smtp.atomicmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const bot = getBotInstance();
registerBatteryWebhook(app, bot);
app.post("/bot", webhookCallback(bot, "express"));

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

async function runDatabaseHealthCheck() {
  if (!pool) {
    logger.warn("Database monitoring skipped - no DATABASE_URL");
    return;
  }

  try {
    const client = await pool.connect();
    const sizeRes = await client.query(`
      SELECT pg_size_pretty(pg_database_size(current_database())) as size,
             pg_database_size(current_database())::float / (1024*1024*1024) as size_gb
    `);

    const size = sizeRes.rows[0].size;
    const sizeGb = parseFloat(sizeRes.rows[0].size_gb || 0);
    client.release();

    const report = `🗄️ **Daily Database Report** — ${new Date().toDateString()}

📊 Storage Used: ${size} (${sizeGb.toFixed(2)} GB)
${sizeGb > 8 ? '⚠️ WARNING: Database storage is getting full!' : '✅ Storage looks healthy'}

🔍 More checks coming soon...`;

    await bot.api.sendMessage("8600917448", report);

    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: "Nullryns@atomicmail.com",
        subject: `📊 Database Report - ${new Date().toDateString()}`,
        text: report,
      });
    }

    logger.info("✅ Daily database report sent");
  } catch (err) {
    logger.error({ err }, "❌ Database health check failed");
  }
}

cron.schedule('0 8 * * *', runDatabaseHealthCheck, { timezone: "Africa/Nairobi" });

setInterval(() => {
  fetch(`http://localhost:${port}/health`).catch(() => {});
}, 5 * 60 * 1000);

app.listen(port, async (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  const webhookUrl = process.env.RENDER_EXTERNAL_URL 
    ? `${process.env.RENDER_EXTERNAL_URL.replace(/\/$/, '')}/bot`
    : `http://localhost:${port}/bot`;

  try {
    await bot.api.setWebhook(webhookUrl, { drop_pending_updates: true });
    logger.info({ url: webhookUrl }, "Telegram webhook set");
  } catch (err) {
    logger.error({ err }, "Failed to set Telegram webhook");
  }

  setTimeout(runDatabaseHealthCheck, 10000);
});
