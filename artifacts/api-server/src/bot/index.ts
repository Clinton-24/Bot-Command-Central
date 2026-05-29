import { Bot, session } from "grammy";
import type { BotContext, SessionData } from "./context";
import { logger } from "../lib/logger";
import { registerMenuHandlers } from "./handlers/menu";
import { registerShopHandlers, registerShopCallbacks } from "./handlers/shop";
import { registerCardHandlers, registerCardCallbacks } from "./handlers/cards";
import { registerSocialHandlers, registerSocialCallbacks } from "./handlers/social";
import { registerAdminHandlers, registerAdminCallbacks } from "./handlers/admin";
import { registerOwnerHandlers } from "./handlers/owner";
import { registerWelcomeHandler } from "./handlers/welcome";
import { registerAntiSpamHandler } from "./handlers/antispam";

export type MyBot = Bot<BotContext>;

let botInstance: MyBot | null = null;

export function createBot(): MyBot {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const bot = new Bot<BotContext>(token);

  bot.use(
    session({
      initial: (): SessionData => ({}),
      getSessionKey: (ctx) => ctx.from?.id?.toString(),
    })
  );

  registerMenuHandlers(bot);
  registerAntiSpamHandler(bot);
  registerWelcomeHandler(bot);
  registerShopHandlers(bot);
  registerShopCallbacks(bot);
  registerCardHandlers(bot);
  registerCardCallbacks(bot);
  registerSocialHandlers(bot);
  registerSocialCallbacks(bot);
  registerAdminHandlers(bot);
  registerAdminCallbacks(bot);
  registerOwnerHandlers(bot);

  bot.catch((err) => {
    logger.error({ err: err.error, update: err.ctx?.update?.update_id }, "Bot error");
  });

  return bot;
}

export function getBotInstance(): MyBot {
  if (!botInstance) botInstance = createBot();
  return botInstance;
}
