import { Bot, session, type SessionFlavor, type Context } from "grammy";
import { logger } from "../lib/logger";
import { registerShopHandlers } from "./handlers/shop";
import { registerCardHandlers } from "./handlers/cards";
import { registerSocialHandlers } from "./handlers/social";
import { registerAdminHandlers } from "./handlers/admin";
import { registerOwnerHandlers } from "./handlers/owner";
import { registerWelcomeHandler } from "./handlers/welcome";
import { registerAntiSpamHandler } from "./handlers/antispam";

export interface SessionData {
  step?: string;
  cart?: { productId: number; quantity: number }[];
}

export type BotContext = Context & SessionFlavor<SessionData>;

let botInstance: Bot | null = null;

export function createBot(): Bot {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }

  const bot = new Bot(token);

  bot.use(
    session({
      initial: (): SessionData => ({ cart: [] }),
    })
  );

  registerWelcomeHandler(bot);
  registerAntiSpamHandler(bot);
  registerShopHandlers(bot);
  registerCardHandlers(bot);
  registerSocialHandlers(bot);
  registerAdminHandlers(bot);
  registerOwnerHandlers(bot);

  bot.catch((err) => {
    logger.error({ err: err.error, ctx: err.ctx?.update?.update_id }, "Bot error");
  });

  return bot;
}

export function getBotInstance(): Bot {
  if (!botInstance) {
    botInstance = createBot();
  }
  return botInstance;
}
