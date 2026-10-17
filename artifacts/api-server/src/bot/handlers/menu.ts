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
    .text("🛍️ Shop", "cardshop:main")
    .text("💳 Card Tools", "menu:cards")
    .row()
    .text("📥 Social Tools", "menu:social")
    .text("📅 Meetings", "menu:meetings")
    .row();

  kb.text("🤖 Crescent AI", "menu:hexagon").row();

  if (userId && isOwner(userId)) {
    kb.text("🔮 Owner Panel", "hex:main")
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
  const name = ctx.from?.first_name ?? "there";
  const owner = userId ? isOwner(userId) : false;

  let accessOk = true;
  if (userId && !owner) {
    try {
      accessOk = await checkAccess(ctx);
    } catch {
      accessOk = true;
    }
  }

  if (!owner && !accessOk) {
    await ctx.reply(
      `🌙 Crescent\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Hey ${name}\nWelcome to God of Credentials.\n\n` +
        `Access required to use the panel.`,
      {
        reply_markup: new InlineKeyboard()
          .text("🔄 Unlock free access", "growth:try_crescent")
          .row()
          .text("💳 Premium / VIP", "access:plans"),
      },
    );
    return;
  }

  const text =
    `🌙 *Crescent*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `*God of Credentials* — select a service:`;
  const kb = mainMenuKeyboard(ctx.from?.id);
  try {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
    } else {
      await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
    }
  } catch {
    await ctx.reply(text.replace(/\*/g, ""), { reply_markup: kb });
  }
}

/** Legacy shop menu (shop.ts). Prefer Shop. */
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
    .text("🛍️ Open Shop", "cardshop:main")
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
    .text("➕ Schedule", "meetings:add")
    .text("📋 List", "meetings:list")
    .row()
    .text("🔙 Main Menu", "menu:main");
}

export function registerMenuHandlers(bot: MyBot): void {
  bot.on("message", async (ctx, next) => {
    try {
      await logGroupMessage(ctx);
    } catch {
      /* ignore */
    }
    return next();
  });

  bot.on("message:text", async (ctx, next) => {
    const action = ctx.session.pendingAction;
    const text = ctx.message.text;

    if (ctx.session.crescentMode || action === "hexagon:input") {
      await handleHexagonMessage(ctx, text);
      return;
    }
    if (action === "hexagon:imagine") {
      await ctx.reply("Use /imagine your prompt for image generation.");
      ctx.session.pendingAction = "hexagon:input";
      return;
    }
    if (action?.startsWith("hex:")) {
      await processHexInput(ctx, action, text);
      return;
    }
    if (action?.startsWith("banklogs:")) {
      await processBankLogInput(ctx, action, text);
      return;
    }
    if (action?.startsWith("access:") || action?.startsWith("acl:")) {
      await processAccessInput(ctx, action, text);
      return;
    }
    if (action?.startsWith("social:")) {
      await processSocial(ctx, action, text);
      return;
    }
    if (action?.startsWith("meetings:")) {
      await processMeetingInput(ctx, action, text);
      return;
    }
    if (action === "cards:chk") {
      await processChk(ctx, text);
      return;
    }
    if (action === "cards:bin") {
      await processBin(ctx, text);
      return;
    }
    if (action === "cards:gen") {
      await processGen(ctx, text);
      return;
    }
    if (action === "cards:rzp") {
      await processRzp(ctx, text);
      return;
    }
    if (action === "email:draft") {
      await draftEmail(ctx, text);
      return;
    }

    // invite codes via /start already handled; free text invite attempt
    if (/^[A-Za-z0-9]{6,12}$/.test(text.trim()) && !text.startsWith("/")) {
      try {
        const handled = await handleInviteCode(ctx, text.trim());
        if (handled) return;
      } catch {
        /* fall through */
      }
    }

    return next();
  });

  bot.callbackQuery("menu:main", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendMainMenu(ctx);
  });

  bot.callbackQuery("menu:shop", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(
        `🛍️ *SHOP*\n━━━━━━━━━━━━━━━━━━\n\nBrowse and buy digital products.`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("Open Shop", "cardshop:main")
            .text("🏠 Main Menu", "menu:main"),
        },
      );
    } catch {
      await ctx.reply("🛍️ SHOP", {
        reply_markup: new InlineKeyboard().text("Open Shop", "cardshop:main"),
      });
    }
  });

  bot.callbackQuery("menu:cards", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText("💳 *CARD TOOLS*\n━━━━━━━━━━━━━━━━━━\n\nSelect a tool:", {
        parse_mode: "Markdown",
        reply_markup: cardMenuKeyboard(),
      });
    } catch {
      await ctx.reply("💳 CARD TOOLS", { reply_markup: cardMenuKeyboard() });
    }
  });

  bot.callbackQuery("menu:social", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText("📥 *SOCIAL TOOLS*\n━━━━━━━━━━━━━━━━━━\n\nSelect a platform:", {
        parse_mode: "Markdown",
        reply_markup: socialMenuKeyboard(),
      });
    } catch {
      await ctx.reply("📥 SOCIAL TOOLS", { reply_markup: socialMenuKeyboard() });
    }
  });

  bot.callbackQuery("menu:meetings", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText("📅 *MEETINGS*\n━━━━━━━━━━━━━━━━━━", {
        parse_mode: "Markdown",
        reply_markup: meetingsMenuKeyboard(),
      });
    } catch {
      await ctx.reply("📅 MEETINGS", { reply_markup: meetingsMenuKeyboard() });
    }
  });

  bot.callbackQuery("menu:hexagon", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { enableCrescentChat } = await import("./hexagon");
    const { checkCrescentAccess } = await import("./access");
    if (!(await checkCrescentAccess(ctx))) return;
    enableCrescentChat(ctx);
    await ctx.reply("🤖 Crescent chat mode on. Type your message or /crescent for the menu.");
  });

  bot.callbackQuery("crescent:exit", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.crescentMode = false;
    if (ctx.session.pendingAction === "hexagon:input" || ctx.session.pendingAction === "hexagon:imagine") {
      ctx.session.pendingAction = undefined;
    }
    await ctx.reply("👋 Left Crescent chat mode.");
  });

  bot.callbackQuery("menu:help", async (ctx) => {
    await ctx.answerCallbackQuery();
    const help =
      `❓ *HELP*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `/start — Welcome\n` +
      `/menu — Main menu\n` +
      `/shop · /buy — open Shop\n` +
      `/crescent — Crescent AI\n` +
      `/briefing — Daily briefing\n` +
      `/imagine — Image generation\n` +
      `/plans — Subscription plans\n` +
      `/exit — Leave Crescent chat\n` +
      `/id — Your Telegram ID`;
    try {
      await ctx.editMessageText(help, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🏠 Main Menu", "menu:main"),
      });
    } catch {
      await ctx.reply(help.replace(/\*/g, ""), {
        reply_markup: new InlineKeyboard().text("🏠 Main Menu", "menu:main"),
      });
    }
  });

  bot.command("menu", async (ctx) => {
    await sendMainMenu(ctx);
  });
}
