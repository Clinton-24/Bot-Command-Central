import app from "./app";
import { logger } from "./lib/logger";
import { getBotInstance } from "./bot/index";
import { registerBatteryWebhook } from "./bot/handlers/battery";
import { GrammyError } from "grammy";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const bot = getBotInstance();
registerBatteryWebhook(app, bot);

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});

// Start bot with automatic 409-conflict retry.
// A 409 means a previous instance is still holding the polling slot — wait for
// its 30-second getUpdates call to expire, then retry once.
async function startBot(attempt = 1): Promise<void> {
  try {
    await bot.start({
      onStart: (info) => {
        logger.info({ username: info.username }, "Telegram bot started");
      },
    });
  } catch (err) {
    if (
      err instanceof GrammyError &&
      err.error_code === 409 &&
      attempt <= 3
    ) {
      const delay = attempt * 35_000; // 35s, 70s, 105s
      logger.warn(
        { attempt, delaySec: delay / 1000 },
        "Telegram 409 conflict — another instance still polling. Retrying after delay…"
      );
      await new Promise((r) => setTimeout(r, delay));
      return startBot(attempt + 1);
    }
    logger.error({ err }, "Bot failed to start");
    process.exit(1);
  }
}

void startBot();
