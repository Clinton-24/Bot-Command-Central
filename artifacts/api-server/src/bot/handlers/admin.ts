import type { Bot } from "grammy";
import { db } from "@workspace/db";
import {
  warningsTable,
  blacklistTable,
  groupSettingsTable,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { mustBeAdmin, mustBeGroup, formatUser } from "../helpers";
import { logger } from "../../lib/logger";

const MAX_WARNINGS = 3;

export function registerAdminHandlers(bot: Bot) {
  bot.command("warn", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;

    const target = ctx.message?.reply_to_message?.from;
    if (!target) { await ctx.reply("Reply to a user to warn them."); return; }

    const chatId = ctx.chat!.id;
    const warnedBy = ctx.from!.id;

    try {
      await db.insert(warningsTable).values({
        chatId,
        userId: target.id,
        warnedBy,
        reason: ctx.match?.trim() || undefined,
      });

      const allWarns = await db
        .select()
        .from(warningsTable)
        .where(and(eq(warningsTable.chatId, chatId), eq(warningsTable.userId, target.id)));

      const count = allWarns.length;
      const mention = formatUser(target);

      if (count >= MAX_WARNINGS) {
        await ctx.api.banChatMember(chatId, target.id);
        await ctx.reply(
          `⛔ ${mention} has been *banned* after ${count} warnings.`,
          { parse_mode: "Markdown" }
        );
      } else {
        await ctx.reply(
          `⚠️ ${mention} warned. (${count}/${MAX_WARNINGS})\n${ctx.match?.trim() ? `Reason: ${ctx.match}` : ""}`,
          { parse_mode: "Markdown" }
        );
      }
    } catch (err) {
      logger.error({ err }, "warn command error");
      await ctx.reply("❌ Failed to warn user.");
    }
  });

  bot.command("warnings", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;

    const target = ctx.message?.reply_to_message?.from;
    if (!target) { await ctx.reply("Reply to a user to check their warnings."); return; }

    try {
      const warns = await db
        .select()
        .from(warningsTable)
        .where(and(eq(warningsTable.chatId, ctx.chat!.id), eq(warningsTable.userId, target.id)));

      const mention = formatUser(target);
      await ctx.reply(
        `📋 ${mention} has *${warns.length}/${MAX_WARNINGS}* warnings.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      logger.error({ err }, "warnings command error");
      await ctx.reply("❌ Failed to fetch warnings.");
    }
  });

  bot.command("resetwarns", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;

    const target = ctx.message?.reply_to_message?.from;
    if (!target) { await ctx.reply("Reply to a user to reset their warnings."); return; }

    try {
      await db
        .delete(warningsTable)
        .where(and(eq(warningsTable.chatId, ctx.chat!.id), eq(warningsTable.userId, target.id)));

      const mention = formatUser(target);
      await ctx.reply(`✅ Warnings reset for ${mention}.`, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error({ err }, "resetwarns command error");
      await ctx.reply("❌ Failed to reset warnings.");
    }
  });

  bot.command("ban", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;

    const target = ctx.message?.reply_to_message?.from;
    if (!target) { await ctx.reply("Reply to a user to ban them."); return; }

    try {
      await ctx.api.banChatMember(ctx.chat!.id, target.id);
      const mention = formatUser(target);
      await ctx.reply(`⛔ ${mention} has been banned.`, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error({ err }, "ban command error");
      await ctx.reply("❌ Failed to ban user. Make sure I have ban permissions.");
    }
  });

  bot.command("unban", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;

    const target = ctx.message?.reply_to_message?.from;
    if (!target) { await ctx.reply("Reply to a user to unban them."); return; }

    try {
      await ctx.api.unbanChatMember(ctx.chat!.id, target.id);
      const mention = formatUser(target);
      await ctx.reply(`✅ ${mention} has been unbanned.`, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error({ err }, "unban command error");
      await ctx.reply("❌ Failed to unban user.");
    }
  });

  bot.command("mute", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;

    const target = ctx.message?.reply_to_message?.from;
    if (!target) { await ctx.reply("Reply to a user to mute them."); return; }

    try {
      await ctx.api.restrictChatMember(ctx.chat!.id, target.id, {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
      });
      const mention = formatUser(target);
      await ctx.reply(`🔇 ${mention} has been muted.`, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error({ err }, "mute command error");
      await ctx.reply("❌ Failed to mute user. Make sure I have restrict permissions.");
    }
  });

  bot.command("unmute", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;

    const target = ctx.message?.reply_to_message?.from;
    if (!target) { await ctx.reply("Reply to a user to unmute them."); return; }

    try {
      await ctx.api.restrictChatMember(ctx.chat!.id, target.id, {
        can_send_messages: true,
        can_send_audios: true,
        can_send_documents: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_video_notes: true,
        can_send_voice_notes: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true,
      });
      const mention = formatUser(target);
      await ctx.reply(`🔊 ${mention} has been unmuted.`, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error({ err }, "unmute command error");
      await ctx.reply("❌ Failed to unmute user.");
    }
  });

  bot.command("bl", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;

    const word = ctx.match?.trim().toLowerCase();
    if (!word) { await ctx.reply("Usage: /bl word"); return; }

    try {
      await db.insert(blacklistTable).values({
        chatId: ctx.chat!.id,
        word,
        addedBy: ctx.from!.id,
      });
      await ctx.reply(`✅ Word "${word}" added to blacklist.`);
    } catch (err) {
      logger.error({ err }, "bl command error");
      await ctx.reply("❌ Failed to add word.");
    }
  });

  bot.command("unbl", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;

    const word = ctx.match?.trim().toLowerCase();
    if (!word) { await ctx.reply("Usage: /unbl word"); return; }

    try {
      await db
        .delete(blacklistTable)
        .where(and(eq(blacklistTable.chatId, ctx.chat!.id), eq(blacklistTable.word, word)));
      await ctx.reply(`✅ Word "${word}" removed from blacklist.`);
    } catch (err) {
      logger.error({ err }, "unbl command error");
      await ctx.reply("❌ Failed to remove word.");
    }
  });

  bot.command("bllist", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;

    try {
      const words = await db
        .select()
        .from(blacklistTable)
        .where(eq(blacklistTable.chatId, ctx.chat!.id));

      if (words.length === 0) { await ctx.reply("📋 No blacklisted words."); return; }
      const list = words.map((w) => `• ${w.word}`).join("\n");
      await ctx.reply(`📋 *Blacklisted Words*\n\n${list}`, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error({ err }, "bllist command error");
      await ctx.reply("❌ Failed to fetch blacklist.");
    }
  });

  bot.command("links", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;

    const arg = ctx.match?.trim().toLowerCase();
    if (arg !== "on" && arg !== "off") { await ctx.reply("Usage: /links on|off"); return; }

    const enabled = arg === "on";
    const chatId = ctx.chat!.id;

    try {
      await db
        .insert(groupSettingsTable)
        .values({ chatId, linksEnabled: enabled })
        .onConflictDoUpdate({ target: groupSettingsTable.chatId, set: { linksEnabled: enabled, updatedAt: new Date() } });
      await ctx.reply(`🔗 Links are now ${enabled ? "✅ enabled" : "❌ disabled"}.`);
    } catch (err) {
      logger.error({ err }, "links command error");
      await ctx.reply("❌ Failed to update setting.");
    }
  });

  bot.command("forwards", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;

    const arg = ctx.match?.trim().toLowerCase();
    if (arg !== "on" && arg !== "off") { await ctx.reply("Usage: /forwards on|off"); return; }

    const enabled = arg === "on";
    const chatId = ctx.chat!.id;

    try {
      await db
        .insert(groupSettingsTable)
        .values({ chatId, forwardsEnabled: enabled })
        .onConflictDoUpdate({ target: groupSettingsTable.chatId, set: { forwardsEnabled: enabled, updatedAt: new Date() } });
      await ctx.reply(`↩️ Forwards are now ${enabled ? "✅ enabled" : "❌ disabled"}.`);
    } catch (err) {
      logger.error({ err }, "forwards command error");
      await ctx.reply("❌ Failed to update setting.");
    }
  });

  bot.command("captcha", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;

    const arg = ctx.match?.trim().toLowerCase();
    if (arg !== "on" && arg !== "off") { await ctx.reply("Usage: /captcha on|off"); return; }

    const enabled = arg === "on";
    const chatId = ctx.chat!.id;

    try {
      await db
        .insert(groupSettingsTable)
        .values({ chatId, captchaEnabled: enabled })
        .onConflictDoUpdate({ target: groupSettingsTable.chatId, set: { captchaEnabled: enabled, updatedAt: new Date() } });
      await ctx.reply(`🤖 Captcha is now ${enabled ? "✅ enabled" : "❌ disabled"}.`);
    } catch (err) {
      logger.error({ err }, "captcha command error");
      await ctx.reply("❌ Failed to update setting.");
    }
  });

  bot.command("antispam", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;

    const arg = ctx.match?.trim().toLowerCase();
    if (arg !== "on" && arg !== "off") { await ctx.reply("Usage: /antispam on|off"); return; }

    const enabled = arg === "on";
    const chatId = ctx.chat!.id;

    try {
      await db
        .insert(groupSettingsTable)
        .values({ chatId, antispamEnabled: enabled })
        .onConflictDoUpdate({ target: groupSettingsTable.chatId, set: { antispamEnabled: enabled, updatedAt: new Date() } });
      await ctx.reply(`🛡️ Anti-spam is now ${enabled ? "✅ enabled" : "❌ disabled"}.`);
    } catch (err) {
      logger.error({ err }, "antispam command error");
      await ctx.reply("❌ Failed to update setting.");
    }
  });

  bot.command("setwelcome", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;

    const msg = ctx.match?.trim();
    if (!msg) { await ctx.reply("Usage: /setwelcome [message]\n\nVariables: {name} {username}"); return; }

    const chatId = ctx.chat!.id;

    try {
      await db
        .insert(groupSettingsTable)
        .values({ chatId, welcomeMessage: msg })
        .onConflictDoUpdate({ target: groupSettingsTable.chatId, set: { welcomeMessage: msg, updatedAt: new Date() } });
      await ctx.reply(`✅ Welcome message set:\n\n${msg}`);
    } catch (err) {
      logger.error({ err }, "setwelcome command error");
      await ctx.reply("❌ Failed to set welcome message.");
    }
  });

  bot.command("pin", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;

    const reply = ctx.message?.reply_to_message;
    if (!reply) { await ctx.reply("Reply to a message to pin it."); return; }

    try {
      await ctx.api.pinChatMessage(ctx.chat!.id, reply.message_id);
      await ctx.reply("📌 Message pinned.");
    } catch (err) {
      logger.error({ err }, "pin command error");
      await ctx.reply("❌ Failed to pin message.");
    }
  });

  bot.command("unpin", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;

    try {
      await ctx.api.unpinAllChatMessages(ctx.chat!.id);
      await ctx.reply("📌 All messages unpinned.");
    } catch (err) {
      logger.error({ err }, "unpin command error");
      await ctx.reply("❌ Failed to unpin messages.");
    }
  });

  bot.command("settings", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;

    const chatId = ctx.chat!.id;
    try {
      const [settings] = await db
        .select()
        .from(groupSettingsTable)
        .where(eq(groupSettingsTable.chatId, chatId));

      const s = settings ?? {
        linksEnabled: true,
        forwardsEnabled: true,
        captchaEnabled: false,
        antispamEnabled: false,
        welcomeMessage: null,
      };

      await ctx.reply(
        `⚙️ *Group Settings*\n\n` +
          `🔗 Links: ${s.linksEnabled ? "✅ On" : "❌ Off"}\n` +
          `↩️ Forwards: ${s.forwardsEnabled ? "✅ On" : "❌ Off"}\n` +
          `🤖 Captcha: ${s.captchaEnabled ? "✅ On" : "❌ Off"}\n` +
          `🛡️ Anti-spam: ${s.antispamEnabled ? "✅ On" : "❌ Off"}\n` +
          `👋 Welcome: ${s.welcomeMessage ? "✅ Set" : "❌ Not set"}`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      logger.error({ err }, "settings command error");
      await ctx.reply("❌ Failed to fetch settings.");
    }
  });

  bot.command("logs", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;

    const arg = ctx.match?.trim();
    const chatId = ctx.chat!.id;

    if (!arg) { await ctx.reply("Usage: /logs <channel_id>\n\nSet a channel to receive moderation logs."); return; }

    const logChannelId = parseInt(arg, 10);
    if (isNaN(logChannelId)) { await ctx.reply("❌ Invalid channel ID."); return; }

    try {
      await db
        .insert(groupSettingsTable)
        .values({ chatId, logChannelId })
        .onConflictDoUpdate({ target: groupSettingsTable.chatId, set: { logChannelId, updatedAt: new Date() } });
      await ctx.reply(`✅ Log channel set to \`${logChannelId}\`.`, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error({ err }, "logs command error");
      await ctx.reply("❌ Failed to set log channel.");
    }
  });
}
