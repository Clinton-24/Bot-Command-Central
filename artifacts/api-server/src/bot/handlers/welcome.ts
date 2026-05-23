import type { Bot } from "grammy";
import { db } from "@workspace/db";
import { usersTable, groupSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger";

export function registerWelcomeHandler(bot: Bot) {
  bot.on("message:new_chat_members", async (ctx) => {
    const chatId = ctx.chat.id;
    const newMembers = ctx.message.new_chat_members;

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

        if (settings?.welcomeMessage) {
          const name = member.first_name || member.username || "User";
          const username = member.username ? `@${member.username}` : name;
          const msg = settings.welcomeMessage
            .replace("{name}", name)
            .replace("{username}", username);

          await ctx.reply(msg, { parse_mode: "Markdown" }).catch(() => {});
        }
      }
    } catch (err) {
      logger.error({ err }, "welcome handler error");
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

    await ctx.reply(
      `👋 *Welcome!*\n\n` +
        `I'm your all-in-one group management and tools bot.\n\n` +
        `⚡ *Commands*\n\n` +
        `🛒 *Shop*\n` +
        `/buy — Browse products\n` +
        `/orders — Your order history\n` +
        `/cancelorder — Cancel active order\n\n` +
        `💳 *Card Tools*\n` +
        `/chk CARD|MM|YY|CVV\n` +
        `/rzp CARD|MM|YY|CVV\n` +
        `/bin XXXXXX\n` +
        `/gen XXXXXX\n\n` +
        `📥 *Social (DM only)*\n` +
        `/fb /insta /snap /pin [URL]\n\n` +
        `👥 *Group Admin*\n` +
        `/warn /ban /mute /bl and more\n\n` +
        `Type /help for the full command list.`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `⚡ *Full Command List*\n\n` +
        `🛒 *SHOP*\n` +
        `/buy — Purchase a product\n` +
        `/cancelorder — Cancel your active order\n` +
        `/orders — Your order history\n\n` +
        `💳 *CARD TOOLS (free)*\n` +
        `/chk CARD|MM|YY|CVV\n` +
        `/rzp CARD|MM|YY|CVV\n` +
        `/bin XXXXXX\n` +
        `/gen XXXXXX\n\n` +
        `📥 *SOCIAL (DM only)*\n` +
        `/fb [URL] · /insta [URL] · /snap [URL] · /pin [URL]\n\n` +
        `👥 *GROUP ADMIN*\n` +
        `/warn · /warnings · /resetwarns (reply)\n` +
        `/ban · /unban (reply)\n` +
        `/mute · /unmute (reply)\n` +
        `/bl word · /unbl word · /bllist\n` +
        `/links on|off · /forwards on|off\n` +
        `/captcha on|off · /antispam on|off\n` +
        `/setwelcome [msg] · /pin · /unpin\n` +
        `/settings · /logs\n\n` +
        `📢 *OWNER ONLY*\n` +
        `/broadcast [msg] · /stats`,
      { parse_mode: "Markdown" }
    );
  });
}
