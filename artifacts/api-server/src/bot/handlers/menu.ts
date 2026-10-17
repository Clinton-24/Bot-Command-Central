import { InlineKeyboard } from "grammy";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { processChk, processRzp, processBin, processGen } from "./cards";
import { processSocial } from "./social";
import { processMeetingInput } from "./meetings";
import { handleHexagonMessage, logGroupMessage } from "./hexagon";
import { processBankLogInput } from "./dblogs";
import { processAccessInput, checkAccess, handleInviteCode } from "./access";
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

  kb.text("🤖 Crescent AI", "menu:hexagon").row();

  if (userId && isOwner(userId)) {
    kb.text("🔮 Hex Panel", "hex:main")
      .row()
      .text("🗄️ Bank Logs", "dblogs:main")
      .row();
  }

  kb.text("❓ Help", "menu:help");
  return kb;
}

export async function sendMainMenu(ctx: BotContext): Promise<void> {
  ctx.session.crescentMode = false;
  if (ctx.session.pendingAction === "hexagon:input") {
    ctx.session.pendingAction = undefined;
  }
  const userId = ctx.from?.id;

  if (userId && !isOwner(userId)) {
    // Auto-grant free tier — no owner pending queue for normal use
    const { ensureAutoFreeAccess } = await import("./growth");
    await ensureAutoFreeAccess({
      id: userId,
      username: ctx.from?.username,
      firstName: ctx.from?.first_name,
    }).catch(() => {});

    const { getAccess } = await import("./access");
    const access = await getAccess(userId).catch(() => null);

    if (access?.tier === "blocked") {
      const blocked =
        `🚫 Access Denied\n━━━━━━━━━━━━━━━━━━\n\nYour account is blocked.` +
        (access.blockedReason ? `\nReason: ${access.blockedReason}` : "");
      if (ctx.callbackQuery) {
        try { await ctx.answerCallbackQuery(); } catch { /* */ }
        await ctx.editMessageText(blocked).catch(() => ctx.reply(blocked));
      } else {
        await ctx.reply(blocked);
      }
      return;
    }

    if (!access?.isApproved) {
      const name = ctx.from?.username
        ? `@${ctx.from.username}`
        : (ctx.from?.first_name ?? "User");
      const gateText =
        `🌙 Crescent\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Hey ${name}\nWelcome to God of Credentials.\n\n` +
        `Tap Unlock free access (or /start) to continue.\n` +
        `Upgrade anytime for full shop + higher AI/card limits.`;
      const gateKb = new InlineKeyboard()
        .text("🔄 Unlock free access", "growth:try_crescent")
        .row()
        .text("💳 Premium / VIP", "access:plans");
      if (ctx.callbackQuery) {
        try { await ctx.answerCallbackQuery(); } catch { /* */ }
        await ctx.editMessageText(gateText, { reply_markup: gateKb }).catch(() =>
          ctx.reply(gateText, { reply_markup: gateKb }),
        );
      } else {
        await ctx.reply(gateText, { reply_markup: gateKb });
      }
      return;
    }
  }

  const text =
    `🌙 *Crescent*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `*God of Credentials* — select a service:`;
  const kb = mainMenuKeyboard(ctx.from?.id);
  if (ctx.callbackQuery) {
    try {
      await ctx.answerCallbackQuery();
    } catch {
      /* */
    }
    try {
      await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
    } catch {
      await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
    }
  } else {
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  }
}

/** Legacy shop menu (used by shop.ts handlers). Prefer CardShop. */
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
  bot.on("message", async (ctx, next) => {
    await logGroupMessage(ctx);
    return next();
  });

  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return next();

    const lower = text.toLowerCase();
    if (
      ctx.session.crescentMode &&
      (lower === "exit" || lower === "stop" || lower === "leave" || lower === "quit")
    ) {
      const { disableCrescentChat } = await import("./hexagon");
      disableCrescentChat(ctx);
      await ctx.reply("👋 Left Crescent chat.\n\nTap 🤖 Crescent AI or /crescent anytime.");
      return;
    }

    if (ctx.session.crescentMode || ctx.session.pendingAction === "hexagon:input") {
      ctx.session.crescentMode = true;
      ctx.session.pendingAction = "hexagon:input";
      try {
        await handleHexagonMessage(ctx, text);
      } catch (err) {
        logger.error({ err }, "crescent sticky chat error");
        await ctx.reply("❌ Something went wrong. Please try again.");
      }
      return;
    }

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
        if (detail === "email") await draftEmail(ctx, text);
        else await handleHexagonMessage(ctx, text);
      } else if (pending.startsWith("hex:")) {
        ctx.session.pendingAction = pending;
        await processHexInput(ctx, pending, text);
      } else if (pending.startsWith("banklogs:")) {
        await processBankLogInput(ctx, pending, text);
      } else if (pending.startsWith("access:") || pending.startsWith("acl:")) {
        await processAccessInput(bot, ctx, pending, text);
      } else if (pending === "access:referral") {
        await processAccessInput(bot, ctx, "access:referral", text);
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
    try {
      await ctx.answerCallbackQuery();
    } catch {
      /* */
    }
    await ctx.editMessageText(
      `🛍️ *CARDSHOP*\n━━━━━━━━━━━━━━━━━━\n\nBrowse and buy digital products.`,
      { parse_mode: "Markdown", reply_markup: cardShopRedirectKeyboard() },
    );
  });

  bot.callbackQuery("menu:cards", async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
    } catch {
      /* */
    }
    await ctx.editMessageText(
      `💳 *CARD TOOLS*\n━━━━━━━━━━━━━━━━━━\n\nFree: 4 uses/day · Premium: 50 · VIP: 999`,
      { parse_mode: "Markdown", reply_markup: cardMenuKeyboard() },
    );
  });

  bot.callbackQuery("menu:social", async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
    } catch {
      /* */
    }
    const isPrivate = ctx.chat?.type === "private";
    const note = isPrivate ? "" : "\n\n⚠️ _Switch to DM with the bot to use these tools._";
    await ctx.editMessageText(
      `📥 *SOCIAL TOOLS*\n━━━━━━━━━━━━━━━━━━\n\nFetch metadata from social URLs.${note}`,
      { parse_mode: "Markdown", reply_markup: socialMenuKeyboard() },
    );
  });

  bot.callbackQuery("menu:meetings", async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
    } catch {
      /* */
    }
    await ctx.editMessageText(
      `📅 *MEETINGS*\n━━━━━━━━━━━━━━━━━━\n\nSchedule and manage meetings.`,
      { parse_mode: "Markdown", reply_markup: meetingsMenuKeyboard() },
    );
  });

  bot.callbackQuery("menu:help", async (ctx) => {
    try {
      await ctx.answerCallbackQuery();
    } catch {
      /* */
    }
    const isOwnerUser = ctx.from && isOwner(ctx.from.id);
    const text =
      `❓ COMMAND REFERENCE\n` +
      `━━━━━━━━━━━━━━━━━━\n\n` +
      `🤖 CRESCENT AI\n` +
      `/crescent — open chat mode\n` +
      `/briefing — daily briefing\n` +
      `/imagine <prompt> — generate image\n` +
      `/exit — leave chat mode\n` +
      `/invite — your referral link\n\n` +
      `🛒 SHOP\n` +
      `/shop · /buy — open CardShop\n` +
      `/orders · /myorders — your orders\n\n` +
      `⏰ REMINDERS & MAIL\n` +
      `/remind <time> <msg> — set reminder\n` +
      `/reminders — list reminders\n` +
      `/digest — send daily digest now\n` +
      `/connect_gmail · /inbox\n\n` +
      `🩺 STATUS\n` +
      `/health · /ping · /id · /menu\n\n` +
      `💳 TIERS\n` +
      `/subscribe · /plans — Premium / VIP\n\n` +
      (isOwnerUser
        ? `📢 OWNER\n/broadcast · /stats · /kill · /unkill\n/hex · /access · /online\n`
        : `📢 Need more? Upgrade with /plans\n`);
    try {
      await ctx.editMessageText(text, {
        reply_markup: new InlineKeyboard().text("🔙 Main Menu", "menu:main"),
      });
    } catch {
      await ctx.reply(text, {
        reply_markup: new InlineKeyboard().text("🔙 Main Menu", "menu:main"),
      });
    }
  });
}
