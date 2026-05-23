import type { Bot } from "grammy";
import { db } from "@workspace/db";
import { blacklistTable, groupSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger";

const URL_REGEX = /https?:\/\/[^\s]+|t\.me\/[^\s]+/gi;

export function registerAntiSpamHandler(bot: Bot) {
  bot.on("message", async (ctx, next) => {
    const chat = ctx.chat;
    if (!chat || chat.type === "private") return next();

    const from = ctx.from;
    if (!from) return next();

    try {
      const member = await ctx.api.getChatMember(chat.id, from.id);
      if (["administrator", "creator"].includes(member.status)) return next();
    } catch {
      return next();
    }

    try {
      const [settings] = await db
        .select()
        .from(groupSettingsTable)
        .where(eq(groupSettingsTable.chatId, chat.id));

      const text = ctx.message?.text || ctx.message?.caption || "";

      if (settings) {
        if (!settings.forwardsEnabled && ctx.message?.forward_origin) {
          await ctx.deleteMessage().catch(() => {});
          await ctx.reply(`❌ Forwarded messages are not allowed in this group.`).catch(() => {});
          return;
        }

        if (!settings.linksEnabled && URL_REGEX.test(text)) {
          await ctx.deleteMessage().catch(() => {});
          await ctx.reply(`❌ Links are not allowed in this group.`).catch(() => {});
          return;
        }
      }

      if (text) {
        const words = await db
          .select()
          .from(blacklistTable)
          .where(eq(blacklistTable.chatId, chat.id));

        const lowerText = text.toLowerCase();
        const found = words.find((w) => lowerText.includes(w.word));

        if (found) {
          await ctx.deleteMessage().catch(() => {});
          await ctx.reply(`❌ Message deleted: contains blacklisted word.`).catch(() => {});
          return;
        }
      }
    } catch (err) {
      logger.error({ err }, "antispam handler error");
    }

    return next();
  });
}
