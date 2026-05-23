import type { Bot } from "grammy";
import { db } from "@workspace/db";
import { usersTable, ordersTable } from "@workspace/db";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";
import { count } from "drizzle-orm";

export function registerOwnerHandlers(bot: Bot) {
  bot.command("broadcast", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ This command is for the bot owner only.");
      return;
    }

    const msg = ctx.match?.trim();
    if (!msg) { await ctx.reply("Usage: /broadcast [message]"); return; }

    try {
      const users = await db.select({ id: usersTable.id }).from(usersTable);

      let sent = 0;
      let failed = 0;

      for (const user of users) {
        try {
          await ctx.api.sendMessage(user.id, `📢 *Broadcast*\n\n${msg}`, {
            parse_mode: "Markdown",
          });
          sent++;
        } catch {
          failed++;
        }
        await new Promise((r) => setTimeout(r, 50));
      }

      await ctx.reply(`📢 Broadcast complete.\n✅ Sent: ${sent}\n❌ Failed: ${failed}`);
    } catch (err) {
      logger.error({ err }, "broadcast command error");
      await ctx.reply("❌ Broadcast failed.");
    }
  });

  bot.command("stats", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ This command is for the bot owner only.");
      return;
    }

    try {
      const [userCount] = await db.select({ value: count() }).from(usersTable);
      const [orderCount] = await db.select({ value: count() }).from(ordersTable);

      await ctx.reply(
        `📊 *Bot Statistics*\n\n` +
          `👤 Total Users: ${userCount?.value ?? 0}\n` +
          `📦 Total Orders: ${orderCount?.value ?? 0}`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      logger.error({ err }, "stats command error");
      await ctx.reply("❌ Failed to fetch stats.");
    }
  });
}
