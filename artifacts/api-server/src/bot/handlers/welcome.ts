import { InlineKeyboard } from "grammy";
import type { MyBot } from "../index";
import { sendMainMenu } from "./menu";
import { db } from "@workspace/db";
import { usersTable, groupSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger";

export function registerWelcomeHandler(bot: MyBot): void {
  bot.on("message:new_chat_members", async (ctx) => {
    const chatId = ctx.chat.id;
    const newMembers = ctx.message.new_chat_members;
    const groupName = ctx.chat.title ?? "this group";

    try {
      const [settings] = await db
        .select()
        .from(groupSettingsTable)
        .where(eq(groupSettingsTable.chatId, chatId));

      for (const member of newMembers) {
        if (member.is_bot) continue;
        await db
          .insert(usersTable)
          .values({
            id: member.id,
            username: member.username,
            firstName: member.first_name,
            lastName: member.last_name,
          })
          .onConflictDoNothing();

        const name = member.first_name || member.username || "User";
        const username = member.username ? `@${member.username}` : name;

        if (settings?.welcomeMessage) {
          const msg = settings.welcomeMessage
            .replace(/\{name\}/g, name)
            .replace(/\{username\}/g, username)
            .replace(/\{group\}/g, groupName);

          const kb = new InlineKeyboard();
          if (settings.groupRules) {
            kb.text("📜 Group Rules", `welcome:rules:${chatId}`);
          }

          await ctx.reply(msg, {
            parse_mode: "Markdown",
            reply_markup: settings.groupRules ? kb : undefined,
          }).catch(() => {});
        } else {
          // Default welcome message
          const defaultMsg =
            `👋 Welcome to *${groupName}*, ${name}!\n\n` +
            `We're glad to have you here. Please read the rules and enjoy your stay.`;

          const kb = new InlineKeyboard();
          if (settings?.groupRules) {
            kb.text("📜 Group Rules", `welcome:rules:${chatId}`);
          }

          await ctx.reply(defaultMsg, {
            parse_mode: "Markdown",
            reply_markup: settings?.groupRules ? kb : undefined,
          }).catch(() => {});
        }
      }
    } catch (err) {
      logger.error({ err }, "welcome handler error");
    }
  });

  // Rules button callback
  bot.callbackQuery(/^welcome:rules:(-?\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = parseInt(ctx.match[1]!);
    try {
      const [settings] = await db
        .select()
        .from(groupSettingsTable)
        .where(eq(groupSettingsTable.chatId, chatId));

      if (settings?.groupRules) {
        await ctx.reply(
          `📜 *Group Rules*\n━━━━━━━━━━━━━━━━━━\n\n${settings.groupRules}`,
          { parse_mode: "Markdown" }
        );
      } else {
        await ctx.answerCallbackQuery("No rules set for this group.");
      }
    } catch (err) {
      logger.error({ err }, "rules callback error");
    }
  });

  bot.command("start", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    try {
      await db
        .insert(usersTable)
        .values({
          id: from.id,
          username: from.username,
          firstName: from.first_name,
          lastName: from.last_name,
        })
        .onConflictDoNothing();
    } catch (err) {
      logger.error({ err }, "start: failed to save user");
    }

    await sendMainMenu(ctx);
  });

  bot.command("menu", async (ctx) => {
    await sendMainMenu(ctx);
  });

  bot.command("ping", async (ctx) => {
    const start = Date.now();
    const msg = await ctx.reply("🏓 Pinging...");
    const elapsed = Date.now() - start;
    await ctx.api.editMessageText(
      ctx.chat.id,
      msg.message_id,
      `🏓 *Pong!*\n━━━━━━━━━━━━━━━━━━\n⚡ Response: ${elapsed}ms\n✅ Bot is online`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("id", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const chatType = ctx.chat.type;
    const isGroup = chatType === "group" || chatType === "supergroup";
    await ctx.reply(
      `🪪 *Your Info*\n━━━━━━━━━━━━━━━━━━\n` +
        `👤 Name: ${from.first_name}${from.last_name ? ` ${from.last_name}` : ""}\n` +
        `🆔 User ID: \`${from.id}\`\n` +
        (from.username ? `📛 Username: @${from.username}\n` : "") +
        (isGroup ? `\n💬 Chat ID: \`${ctx.chat.id}\`\n📂 Chat: ${(ctx.chat as { title?: string }).title ?? "Group"}` : ""),
      { parse_mode: "Markdown" }
    );
  });

  bot.command("report", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const reason = ctx.match?.trim();
    if (!reason) {
      await ctx.reply("Usage: /report <reason>\n\nExample: /report Spam in group");
      return;
    }

    const ownerIdStr = process.env["BOT_OWNER_ID"];
    if (!ownerIdStr) {
      await ctx.reply("⚠️ Report system not configured.");
      return;
    }

    const ownerId = parseInt(ownerIdStr, 10);
    const chatInfo = ctx.chat.type !== "private"
      ? `\n💬 Chat: ${(ctx.chat as { title?: string }).title ?? "Unknown"} (\`${ctx.chat.id}\`)`
      : "";

    try {
      await ctx.api.sendMessage(
        ownerId,
        `🚨 *USER REPORT*\n━━━━━━━━━━━━━━━━━━\n\n` +
          `👤 From: ${from.first_name}${from.username ? ` (@${from.username})` : ""}\n` +
          `🆔 ID: \`${from.id}\`${chatInfo}\n\n` +
          `📝 Reason:\n${reason}`,
        { parse_mode: "Markdown" }
      );
      await ctx.reply("✅ Your report has been sent to the admin. Thank you!");
    } catch (err) {
      logger.error({ err }, "report command error");
      await ctx.reply("❌ Failed to send report. Please try again.");
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `⚡ *FULL COMMAND LIST*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🛍️ *CARDSHOP*\n` +
        `/shop — Open the CardShop\n` +
        `/myorders — View your orders\n\n` +
        `💳 *CARD TOOLS (free)*\n` +
        `/chk CARD|MM|YY|CVV — Luhn check\n` +
        `/rzp CARD|MM|YY|CVV — RZP check\n` +
        `/bin XXXXXX — BIN lookup\n` +
        `/gen XXXXXX — Generate cards\n\n` +
        `📥 *SOCIAL SCRAPER (DM only)*\n` +
        `/fb [URL] /insta [URL] /snap [URL] /pin [URL]\n\n` +
        `👥 *GROUP ADMIN*\n` +
        `/warn · /warnings · /resetwarns (reply to user)\n` +
        `/ban · /unban · /mute · /unmute (reply to user)\n` +
        `/mutetime <1h|30m|1d> (reply to user)\n` +
        `/bl word · /unbl word · /bllist\n` +
        `/links on|off · /forwards on|off\n` +
        `/captcha on|off · /antispam on|off\n` +
        `/setwelcome [msg] · /setrules [rules]\n` +
        `/pin · /unpin · /settings · /logs\n\n` +
        `🛠️ *GENERAL*\n` +
        `/ping — Latency check\n` +
        `/id — Your Telegram ID & chat info\n` +
        `/report <reason> — Report to admin\n\n` +
        `📢 *OWNER ONLY*\n` +
        `/broadcast [msg] · /stats · /hex`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("🛍️ CardShop", "cardshop:main")
          .text("💳 Card Tools", "menu:cards")
          .row()
          .text("🏠 Main Menu", "menu:main"),
      }
    );
  });
}
