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
import { registerHexagonHandlers, registerHexagonCallbacks } from "./handlers/hexagon";
import { registerReminderHandlers, startDailyDigestScheduler, startTwoHourPingScheduler } from "./handlers/reminders";
import { registerBatteryHandlers } from "./handlers/battery";
import { registerEmailHandlers, registerEmailCallbacks } from "./handlers/email";
import { registerHexHandlers, registerHexCallbacks } from "./handlers/hex";
import { registerAccessHandlers } from "./handlers/access";
import { registerSubscriptionHandlers } from "./handlers/subscription";
import { registerAIAgentHandlers } from "./handlers/ai_agents";
import { registerCardShopHandlers, registerCardShopCallbacks } from "./handlers/cardshop";
import { registerDbLogsHandlers, registerDbLogsCallbacks } from "./handlers/dblogs";
import { killSwitchMiddleware, registerKillHandlers, getKillStatus } from "./handlers/kill";
import { activityAlertMiddleware, registerActivityCommands } from "./handlers/activity";
import { createPgSessionStorage } from "../lib/session-store";
import { isGmailOAuthAppConfigured } from "../lib/gmail";
import { pool } from "@workspace/db";

export type MyBot = Bot<BotContext>;

let botInstance: MyBot | null = null;

/** Prevent Telegram button spinner hang if a handler forgets answerCallbackQuery */
function autoAnswerCallbacks() {
  return async (ctx: BotContext, next: () => Promise<void>) => {
    if (!ctx.callbackQuery) return next();

    let answered = false;
    const original = ctx.answerCallbackQuery.bind(ctx);
    ctx.answerCallbackQuery = async (params?: Parameters<typeof original>[0]) => {
      answered = true;
      return original(params as any);
    };

    const timer = setTimeout(() => {
      if (!answered) {
        original().catch(() => {});
        answered = true;
      }
    }, 2500);

    try {
      await next();
    } finally {
      clearTimeout(timer);
      if (!answered) {
        await original().catch(() => {});
      }
    }
  };
}

export function createBot(): MyBot {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

  const bot = new Bot<BotContext>(token);

  bot.use(
    session({
      initial: (): SessionData => ({}),
      storage: createPgSessionStorage<SessionData>(),
      getSessionKey: (ctx) => ctx.from?.id?.toString(),
    }),
  );

  // Kill switch MUST be first after session — blocks all non-owner traffic instantly
  bot.use(killSwitchMiddleware());
  bot.use(autoAnswerCallbacks());
  // Owner gets pinged when users become active (debounced)
  bot.use(activityAlertMiddleware(bot));
  registerKillHandlers(bot);
  registerActivityCommands(bot);

  // Telegram /health — not the HTTP route
  bot.command("health", async (ctx) => {
    const kill = getKillStatus();
    let dbOk = false;
    try {
      await pool.query("SELECT 1");
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const uptimeMin = Math.floor(process.uptime() / 60);
    await ctx.reply(
      `🩺 BOT HEALTH\n━━━━━━━━━━━━━━━━━━\n` +
        `Status: ${kill.killed ? "KILLED" : "ok"}\n` +
        `Database: ${dbOk ? "ok" : "error"}\n` +
        `Gmail OAuth: ${isGmailOAuthAppConfigured() ? "configured" : "missing"}\n` +
        `Uptime: ${uptimeMin} min\n` +
        `Time: ${new Date().toISOString()}`,
    );
  });

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

  // Hexagon AI
  registerHexagonHandlers(bot);
  registerHexagonCallbacks(bot);
  registerReminderHandlers(bot);
  registerBatteryHandlers(bot);
  registerEmailHandlers(bot);
  registerEmailCallbacks(bot);

  // Owner panel
  registerHexHandlers(bot);
  registerHexCallbacks(bot);
  registerAccessHandlers(bot);
  registerSubscriptionHandlers(bot);
  registerAIAgentHandlers(bot);
  registerOwnerHandlers(bot);
  registerDbLogsHandlers(bot);
  registerDbLogsCallbacks(bot);

  startDailyDigestScheduler(bot);
  startTwoHourPingScheduler(bot);

  bot.catch((err) => {
    const e = err.error as { error_code?: number; description?: string } | Error;
    const desc = "description" in e ? e.description : e instanceof Error ? e.message : String(e);
    const code = "error_code" in e ? e.error_code : 0;

    const ignored = [
      "message is not modified",
      "query is too old",
      "message to edit not found",
      "MESSAGE_ID_INVALID",
      "bot was blocked by the user",
    ];
    if (ignored.some((msg) => desc?.includes(msg))) return;

    logger.error({ err: err.error, update: err.ctx?.update?.update_id, code }, "Bot error");
  });

  return bot;
}

export function getBotInstance(): MyBot {
  if (!botInstance) botInstance = createBot();
  return botInstance;
}
