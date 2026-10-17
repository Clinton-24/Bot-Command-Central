import { InlineKeyboard } from "grammy";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  productsTable,
  ordersTable,
  paymentSettingsTable,
} from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";
import { getProductPriceLimit, subscriptionPlansKeyboard } from "./access";
import { createCryptoBotInvoice, CRYPTOBOT_ASSETS, type CryptoBotAsset } from "./cryptobot";

const CATEGORY_EMOJIS: Record<string, string> = {
  general: "📦",
  streaming: "📺",
  gaming: "🎮",
  vpn: "🛡️",
  giftcard: "🎁",
  social: "📱",
  cards: "💳",
  other: "🌐",
};

const COIN_INFO: Record<string, { emoji: string; network: string }> = {
  "USDT-BEP20": { emoji: "💛", network: "BEP20 (BSC)" },
  BNB: { emoji: "🟡", network: "BSC" },
  "USDT-TRC20": { emoji: "🟢", network: "TRC20 (Tron)" },
  BTC: { emoji: "🟠", network: "Bitcoin" },
  ETH: { emoji: "⬜", network: "Ethereum" },
};

function catEmoji(cat: string): string {
  return CATEGORY_EMOJIS[cat] ?? "📦";
}

function escapeMd(s: string): string {
  return (s || "").replace(/([_*`\[\]])/g, "\\$1");
}

async function safeEdit(
  ctx: BotContext,
  text: string,
  extra?: { reply_markup?: InlineKeyboard; parse_mode?: "Markdown" },
): Promise<void> {
  try {
    await ctx.editMessageText(text, {
      parse_mode: extra?.parse_mode ?? "Markdown",
      reply_markup: extra?.reply_markup,
    });
  } catch {
    try {
      await ctx.editMessageText(text.replace(/[*_`]/g, ""), {
        reply_markup: extra?.reply_markup,
      });
    } catch {
      await ctx.reply(text.replace(/[*_`]/g, ""), {
        reply_markup: extra?.reply_markup,
      }).catch(() => {});
    }
  }
}

function getOwnerId(): number {
  return parseInt(process.env["BOT_OWNER_ID"] ?? "0", 10);
}

SEE_FULL_FILE_IN_REPO_RESTORE
