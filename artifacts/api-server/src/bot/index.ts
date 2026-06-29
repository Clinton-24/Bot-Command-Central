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
import { registerMeetingHandlers, registerMeetingCallbacks } from "./handlers/meetings";
import { registerJarvisHandlers, registerJarvisCallbacks } from "./handlers/jarvis";
import { registerReminderHandlers, startDailyDigestScheduler } from "./handlers/reminders";
import { registerBatteryHandlers } from "./handlers/battery";
import { registerEmailHandlers, registerEmailCallbacks } from "./handlers/email";
import { registerHexHandlers, registerHexCallbacks } from "./handlers/hex";
import { registerCardShopHandlers, registerCardShopCallbacks } from "./handlers/cardshop";
import { registerDbLogsHandlers, registerDbLogsCallbacks } from "./handlers/dblogs";

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

  // Core
  registerMenuHandlers(bot);
  registerAntiSpamHandler(bot);
  registerWelcomeHandler(bot);

  // Shop & payments
  registerCardShopHandlers(bot);
  registerCardShopCallbacks(bot);
  registerShopHandlers(bot);
  registerShopCallbacks(bot);

  // Card tools
  registerCardHandlers(bot);
  registerCardCallbacks(bot);

  // Social tools
  registerSocialHandlers(bot);
  registerSocialCallbacks(bot);

  // Group moderation
  registerAdminHandlers(bot);
  registerAdminCallbacks(bot);

  // Meetings
  registerMeetingHandlers(bot);
  registerMeetingCallbacks(bot);

  // Jarvis AI
  registerJarvisHandlers(bot);
  registerJarvisCallbacks(bot);
  registerReminderHandlers(bot);
  registerBatteryHandlers(bot);
  registerEmailHandlers(bot);
  registerEmailCallbacks(bot);

  // Owner panel
  registerHexHandlers(bot);
  registerHexCallbacks(bot);
  registerOwnerHandlers(bot);
  registerDbLogsHandlers(bot);
  registerDbLogsCallbacks(bot);

  startDailyDigestScheduler(bot);

  bot.catch((err) => {
    logger.error({ err: err.error, update: err.ctx?.update?.update_id }, "Bot error");
  });

  return bot;
}

export function getBotInstance(): MyBot {
  if (!botInstance) botInstance = createBot();
  return botInstance;
}
 