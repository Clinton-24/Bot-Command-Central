import app from "./app";
import { logger } from "./lib/logger";
import { getBotInstance } from "./bot/index";
import { registerBatteryWebhook } from "./bot/handlers/battery";
import { webhookCallback } from "grammy";

const rawPort = process.env["PORT"];
if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}
const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Improved webhook URL handling
const getWebhookUrl = (): string => {
  const webhookPath = "/bot";

  if (process.env.RENDER_EXTERNAL_URL) {
    // Render automatically provides the correct external URL
    const base = process.env.RENDER_EXTERNAL_URL.replace(/\/$/, "");
    return `${base}${webhookPath}`;
  }

  if (process.env.WEBHOOK_URL) {
    // Fallback / local development
    const base = process.env.WEBHOOK_URL.replace(/\/bot?$/, "").replace(/\/$/, "");
    return `${base}${webhookPath}`;
  }

  return `http://localhost:${port}${webhookPath}`;
};

const bot = getBotInstance();
registerBatteryWebhook(app, bot);
app.post("/bot", webhookCallback(bot, "express"));

app.listen(port, async (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  const webhookUrl = getWebhookUrl();
  logger.info({ url: webhookUrl }, "Setting Telegram webhook to");

  try {
    await bot.api.setWebhook(webhookUrl, {
      drop_pending_updates: true,
    });

    const info = await bot.api.getWebhookInfo();
    logger.info({ url: info.url }, "Telegram webhook set");
  } catch (err) {
    logger.error({ err }, "Failed to set Telegram webhook");
  }
});

// === Keep-alive to prevent Render hibernation ===
setInterval(() => {
  fetch(`http://localhost:${port}/`)
    .catch(() => {}); // silent fail
}, 5 * 60 * 1000); // every 5 minutes
