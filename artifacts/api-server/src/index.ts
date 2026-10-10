import app from "./app";
import { logger } from "./lib/logger";
import { getBotInstance } from "./bot/index";
import { registerBatteryWebhook } from "./bot/handlers/battery";
import { webhookCallback } from "grammy";
import { runMigrations } from "./lib/migrate";
import { createCryptoBotRouter } from "./bot/handlers/cryptobot";
import {
  exchangeCodeAndSave,
  verifyOAuthState,
} from "./lib/gmail";

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

// ── Gmail OAuth callback (per-user connect) ───────────────────────────────────

app.get("/oauth/google/callback", async (req, res) => {
  try {
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const err = typeof req.query.error === "string" ? req.query.error : "";

    if (err) {
      res.status(400).send(`<h2>Gmail connect cancelled</h2><p>${err}</p><p>You can close this tab and return to Telegram.</p>`);
      return;
    }

    const userId = verifyOAuthState(state);
    if (!userId || !code) {
      res.status(400).send("<h2>Invalid or expired link</h2><p>Go back to Telegram and run /connect_gmail again.</p>");
      return;
    }

    const { email } = await exchangeCodeAndSave(userId, code);

    try {
      await bot.api.sendMessage(
        userId,
        `✅ *Gmail connected*\n━━━━━━━━━━━━━━━━━━\n\n` +
          (email ? `📬 ${email}\n\n` : "") +
          `Your inbox will appear in:\n• /inbox\n• /digest\n• Daily 10:00 Nairobi briefing\n\n/disconnect_gmail to remove access.`,
        { parse_mode: "Markdown" },
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
