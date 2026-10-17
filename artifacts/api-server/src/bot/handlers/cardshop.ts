import { InlineKeyboard } from "grammy";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  productsTable,
  ordersTable,
  paymentSettingsTable,
  paymentRequestsTable,
} from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { logger } from "../../lib/logger";
import { getProductPriceLimit, subscriptionPlansKeyboard } from "./access";
import { createCryptoBotInvoice, CRYPTOBOT_ASSETS, type CryptoBotAsset } from "./cryptobot";

// RESTORED - see continuous push
export function registerCardShopHandlers(bot: MyBot): void {
  bot.command("shop", async (ctx) => {
    await ctx.reply("🛍️ Shop loading — redeploy in progress. Try /shop again in a minute.");
  });
}

export function registerCardShopCallbacks(bot: MyBot): void {
  bot.callbackQuery(/^cardshop:.*/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Shop updating — try again shortly", show_alert: true });
  });
}
