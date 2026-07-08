import { InlineKeyboard } from "grammy";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { processChk, processRzp, processBin, processGen } from "./cards";
import { processSocial } from "./social";
import { processMeetingInput } from "./meetings";
import { handleHexagonMessage } from "./hexagon";
import { draftEmail } from "./email";
import { processHexInput } from "./hex";
import { logger } from "../../lib/logger";
import { isOwner } from "../helpers";

export function mainMenuKeyboard(userId?: number): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("🛍️ CardShop", "cardshop:main")
    .text("💳 Card Tools", "menu:cards")
    .row()
    .text("📥 Social Tools", "menu:social")
    .text("📅 Meetings", "menu:meetings")
    .row();

  if (userId && isOwner(userId)) {
    kb.text("🤖 Hexagon AI", "menu:hexagon")
      .text("🔮 Hex Panel", "hex:main")
      .row()
      .text("🗄️ Bank Logs", "dblogs:main")
      .row();
  }

  kb.text("❓ Help", "menu:help");
  return kb;
}

export async function sendMainMenu(ctx: BotContext): Promise<void> {
  const text =
    `⚡ *BOT PANEL*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `Welcome! Select a service:`;
  const kb = mainMenuKeyboard(ctx.from?.id);
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

export function cardShopRedirectKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🛍️ Open CardShop", "cardshop:main")
    .row()
    .text("📋 My Orders", "cardshop:myorders")
    .text("🏠 Main Menu", "menu:main");
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

export function meetingsMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Schedule Meeting", "meetings:schedule")
    .row()
    .text("📋 My Meetings", "meetings:list")
    .text("❌ Cancel Meeting", "meetings:cancel_pick")
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
      const colonIdx = pending.indexOf(":");
      const category = colonIdx >= 0 ? pending.slice(0, colonIdx) : pending;
      const detail = colonIdx >= 0 ? pending.slice(colonIdx + 1) : "";

      if (category === "card") {
        if (detail === "chk") await processChk(ctx, text);
        else if (detail === "rzp") await processRzp(ctx, text);
        else if (detail === "bin") await processBin(ctx, text);
        else if (detail === "gen") await processGen(ctx, text);
      } else if (category === "social") {
        await processSocial(ctx, detail, text);
      } else if (category === "meeting") {
        await processMeetingInput(ctx, detail, text);
      } else if (category === "hexagon") {
        if (detail === "input") await handleHexagonMessage(ctx, text);
        else if (detail === "email") await draftEmail(ctx, text);
      } else if (pending.startsWith("hex:")) {
        ctx.session.pendingAction = pending; // restore before handler (it may set a new one)
        await processHexInput(ctx, pending, text);
      }
    } catch (err) {
      logger.error({ err }, "input interceptor error");
      await ctx.reply("❌ Something went wrong. Please try again.");
    }
  });

  bot.callbackQuery("menu:main", async (ctx) => {
    await sendMainMenu(ctx);
  });

  // Legacy shop callback — redirect to new CardShop
  bot.callbackQuery("menu:shop", async (ctx) => {
    await ctx.editMessageText(
      `🛍️ *CARDSHOP*\n━━━━━━━━━━━━━━━━━━\n\nBrowse and buy digital products.`,
      { parse_mode: "Markdown", reply_markup: cardShopRedirectKeyboard() }
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

  bot.callbackQuery("menu:meetings", async (ctx) => {
    await ctx.editMessageText(
      `📅 *MEETINGS*\n━━━━━━━━━━━━━━━━━━\n\nSchedule and manage meetings.`,
      { parse_mode: "Markdown", reply_markup: meetingsMenuKeyboard() }
    );
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("menu:help", async (ctx) => {
    const isOwnerUser = ctx.from && isOwner(ctx.from.id);
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
      `📅 *Meetings*\n` +
      `/schedule · /meetings\n\n` +
      (isOwnerUser
        ? `🤖 *Hexagon AI (owner)*\n` +
          `/hexagon · /ai [question]\n` +
          `/email [brief] · /remind <time> <msg>\n` +
          `/reminders · /digest · /battery\n` +
          `/clearai\n\n`
        : "") +
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
