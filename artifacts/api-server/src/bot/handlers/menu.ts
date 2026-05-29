import { InlineKeyboard } from "grammy";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { processChk, processRzp, processBin, processGen } from "./cards";
import { processSocial } from "./social";
import { logger } from "../../lib/logger";

export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🛒 Shop", "menu:shop")
    .text("💳 Card Tools", "menu:cards")
    .row()
    .text("📥 Social Tools", "menu:social")
    .text("❓ Help", "menu:help");
}

export async function sendMainMenu(ctx: BotContext): Promise<void> {
  const text =
    `⚡ *BOT PANEL*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `Welcome! Select a service:`;
  const kb = mainMenuKeyboard();
  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
    await ctx.answerCallbackQuery();
  } else {
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  }
}

export function shopMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📦 Browse Products", "shop:browse")
    .row()
    .text("📋 My Orders", "shop:orders")
    .text("❌ Cancel Order", "shop:cancel")
    .row()
    .text("🔙 Main Menu", "menu:main");
}

export function cardMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ CHK Card", "cards:chk")
    .text("🏦 BIN Lookup", "cards:bin")
    .row()
    .text("🎰 Gen Cards", "cards:gen")
    .text("🔍 RZP Check", "cards:rzp")
    .row()
    .text("🔙 Main Menu", "menu:main");
}

export function socialMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📘 Facebook", "social:fb")
    .text("📸 Instagram", "social:insta")
    .row()
    .text("👻 Snapchat", "social:snap")
    .text("📌 Pinterest", "social:pin")
    .row()
    .text("🔙 Main Menu", "menu:main");
}

export function registerMenuHandlers(bot: MyBot): void {
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return next();

    const pending = ctx.session.pendingAction;
    if (!pending) return next();

    ctx.session.pendingAction = undefined;

    try {
      const [category, detail] = pending.split(":");

      if (category === "card") {
        if (detail === "chk") await processChk(ctx, text);
        else if (detail === "rzp") await processRzp(ctx, text);
        else if (detail === "bin") await processBin(ctx, text);
        else if (detail === "gen") await processGen(ctx, text);
      } else if (category === "social") {
        await processSocial(ctx, detail, text);
      }
    } catch (err) {
      logger.error({ err }, "input interceptor error");
      await ctx.reply("❌ Something went wrong. Please try again.");
    }
  });

  bot.callbackQuery("menu:main", async (ctx) => {
    await sendMainMenu(ctx);
  });

  bot.callbackQuery("menu:shop", async (ctx) => {
    await ctx.editMessageText(
      `🛒 *SHOP*\n━━━━━━━━━━━━━━━━━━\n\nBrowse products and manage your orders.`,
      { parse_mode: "Markdown", reply_markup: shopMenuKeyboard() }
    );
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("menu:cards", async (ctx) => {
    await ctx.editMessageText(
      `💳 *CARD TOOLS*\n━━━━━━━━━━━━━━━━━━\n\nFree card utilities and BIN lookup.`,
      { parse_mode: "Markdown", reply_markup: cardMenuKeyboard() }
    );
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("menu:social", async (ctx) => {
    const isPrivate = ctx.chat?.type === "private";
    const note = isPrivate ? "" : "\n\n⚠️ _Switch to DM with the bot to use these tools._";
    await ctx.editMessageText(
      `📥 *SOCIAL TOOLS*\n━━━━━━━━━━━━━━━━━━\n\nFetch metadata from social URLs.${note}`,
      { parse_mode: "Markdown", reply_markup: socialMenuKeyboard() }
    );
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("menu:help", async (ctx) => {
    const text =
      `❓ *COMMAND REFERENCE*\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `🛒 *Shop*\n` +
      `/buy · /order <id> · /orders · /cancelorder\n\n` +
      `💳 *Card Tools*\n` +
      `/chk CARD|MM|YY|CVV\n` +
      `/rzp CARD|MM|YY|CVV\n` +
      `/bin XXXXXX · /gen XXXXXX\n\n` +
      `📥 *Social (DM only)*\n` +
      `/fb /insta /snap /pin [URL]\n\n` +
      `👥 *Group Admin*\n` +
      `/warn · /ban · /mute · /unban · /unmute\n` +
      `/bl · /unbl · /bllist\n` +
      `/links · /forwards · /captcha · /antispam\n` +
      `/setwelcome · /pin · /unpin · /settings\n\n` +
      `📢 *Owner*\n` +
      `/broadcast · /stats`;
    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🔙 Main Menu", "menu:main"),
    });
    await ctx.answerCallbackQuery();
  });
}
