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

    await sendMainMenu(ctx);
  });

  bot.command("menu", async (ctx) => {
    await sendMainMenu(ctx);
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `⚡ *FULL COMMAND LIST*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🛒 *SHOP*\n` +
        `/buy — Browse products\n` +
        `/order <id> — Place an order\n` +
        `/cancelorder — Cancel active order\n` +
        `/orders — Order history\n\n` +
        `💳 *CARD TOOLS (free)*\n` +
        `/chk CARD|MM|YY|CVV\n` +
        `/rzp CARD|MM|YY|CVV\n` +
        `/bin XXXXXX\n` +
        `/gen XXXXXX\n\n` +
        `📥 *SOCIAL (DM only)*\n` +
        `/fb /insta /snap /pin [URL]\n\n` +
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
