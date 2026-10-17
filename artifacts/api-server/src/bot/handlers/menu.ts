import { InlineKeyboard } from "grammy";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { processAccessInput } from "./access";
import { processSocialInput } from "./social";
import { processMeetingInput } from "./meetings";
import { handleHexagonMessage, logGroupMessage } from "./hexagon";
import { processCardInput } from "./cards";
import { processBankLogInput } from "./dblogs";
import { processHexInput } from "./hex";
import { ensureAutoFreeAccess, getAccess } from "./access";
import { showSubscriptionPanel } from "./subscription";

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
  const userId = ctx.from?.id;
  if (userId) {
    try {
      await ensureAutoFreeAccess(userId, ctx.from?.username ?? null);
    } catch {
      /* ignore */
    }
  }

  let access: Awaited<ReturnType<typeof getAccess>> | null = null;
  if (userId) {
    try {
      access = await getAccess(userId);
    } catch {
      access = null;
    }
  }

  const name = ctx.from?.first_name ?? "there";
  const owner = userId ? isOwner(userId) : false;

  if (!owner && access && (access.status === "blocked" || access.status === "expired")) {
    await ctx.reply(
      `🌙 Crescent\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Hey ${name}\nWelcome to God of Credentials.\n\n` +
        `Your access is currently ${access.status}. Contact the owner.`,
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
  bot.command("menu", async (ctx) => {
    await sendMainMenu(ctx);
  });

  bot.callbackQuery("menu:main", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendMainMenu(ctx);
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
    const { registerHexagonHandlers } = await import("./hexagon");
    // Open Crescent intro via callback path used elsewhere
    const { enableCrescentChat } = await import("./hexagon");
    const { checkCrescentAccess } = await import("./access");
    if (!(await checkCrescentAccess(ctx))) return;
    enableCrescentChat(ctx);
    await ctx.reply("🤖 Crescent chat mode on. Type your message or /crescent for the menu.");
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

  bot.callbackQuery("cardshop:main", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(
        `🛍️ *SHOP*\n━━━━━━━━━━━━━━━━━━\n\nBrowse and buy digital products.`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("🏦 Bank Logs", "cardshop:banklogs")
            .row()
            .text("🧅 Tor Links", "cardshop:torlinks")
            .row()
            .text("📺 Streaming", "cardshop:cat:streaming")
            .text("🎮 Gaming", "cardshop:cat:gaming")
            .row()
            .text("🛡️ VPN", "cardshop:cat:vpn")
            .text("🎁 Gift Cards", "cardshop:cat:giftcard")
            .row()
            .text("💳 Cards", "cardshop:cat:cards")
            .text("📱 Social", "cardshop:cat:social")
            .row()
            .text("📋 My Orders", "cardshop:myorders")
            .text("🔙 Main Menu", "menu:main"),
        },
      );
    } catch {
      await ctx.reply("🛍️ SHOP", {
        reply_markup: new InlineKeyboard()
          .text("🏦 Bank Logs", "cardshop:banklogs")
          .row()
          .text("🧅 Tor Links", "cardshop:torlinks")
          .row()
          .text("🔙 Main Menu", "menu:main"),
      });
    }
  });

  // Route free-text while pending actions / Crescent mode
  bot.on("message:text", async (ctx, next) => {
    const action = ctx.session.pendingAction;
    const text = ctx.message.text;

    if (ctx.session.crescentMode || action === "hexagon:input") {
      await handleHexagonMessage(ctx, text);
      return;
    }
    if (action === "hexagon:imagine") {
      const { handleHexagonMessage: h } = await import("./hexagon");
      // reuse imagine path via message
      await ctx.reply("Use /imagine your prompt for image generation.");
      ctx.session.pendingAction = "hexagon:input";
      return;
    }
    if (action?.startsWith("hex:")) {
      await processHexInput(ctx, action, text);
      return;
    }
    if (action?.startsWith("banklogs:") || action?.startsWith("access:") || action?.startsWith("acl:")) {
      if (action.startsWith("banklogs:")) await processBankLogInput(ctx, action, text);
      else await processAccessInput(ctx, action, text);
      return;
    }
    if (action?.startsWith("social:")) {
      await processSocialInput(ctx, action, text);
      return;
    }
    if (action?.startsWith("meetings:")) {
      await processMeetingInput(ctx, action, text);
      return;
    }
    if (action?.startsWith("cards:")) {
      await processCardInput(ctx, action, text);
      return;
    }

    await logGroupMessage(ctx);
    return next();
  });
}
