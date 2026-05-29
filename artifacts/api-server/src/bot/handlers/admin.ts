import { InlineKeyboard } from "grammy";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { db } from "@workspace/db";
import { warningsTable, blacklistTable, groupSettingsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { mustBeAdmin, mustBeGroup, formatUser } from "../helpers";
import { logger } from "../../lib/logger";

const MAX_WARNINGS = 3;

async function getOrCreateSettings(chatId: number) {
  const [existing] = await db
    .select()
    .from(groupSettingsTable)
    .where(eq(groupSettingsTable.chatId, chatId));

  if (existing) return existing;

  const [created] = await db
    .insert(groupSettingsTable)
    .values({ chatId })
    .returning();
  return created;
}

function buildSettingsKeyboard(settings: {
  linksEnabled: boolean;
  forwardsEnabled: boolean;
  captchaEnabled: boolean;
  antispamEnabled: boolean;
}): InlineKeyboard {
  const on = (v: boolean) => (v ? "✅" : "❌");
  return new InlineKeyboard()
    .text(`🔗 Links ${on(settings.linksEnabled)}`, "settings:toggle:links")
    .text(`↩️ Forwards ${on(settings.forwardsEnabled)}`, "settings:toggle:forwards")
    .row()
    .text(`🤖 Captcha ${on(settings.captchaEnabled)}`, "settings:toggle:captcha")
    .text(`🛡️ Antispam ${on(settings.antispamEnabled)}`, "settings:toggle:antispam")
    .row()
    .text("🔄 Refresh", "settings:refresh")
    .text("✖️ Close", "settings:close");
}

function buildSettingsText(settings: {
  linksEnabled: boolean;
  forwardsEnabled: boolean;
  captchaEnabled: boolean;
  antispamEnabled: boolean;
  welcomeMessage: string | null;
}): string {
  const on = (v: boolean) => (v ? "✅ ON" : "❌ OFF");
  return (
    `⚙️ *GROUP SETTINGS*\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `🔗 Links: ${on(settings.linksEnabled)}\n` +
    `↩️ Forwards: ${on(settings.forwardsEnabled)}\n` +
    `🤖 Captcha: ${on(settings.captchaEnabled)}\n` +
    `🛡️ Antispam: ${on(settings.antispamEnabled)}\n` +
    `👋 Welcome: ${settings.welcomeMessage ? "✅ Set" : "❌ Not set"}\n\n` +
    `_Tap a button to toggle._`
  );
}

export function registerAdminHandlers(bot: MyBot): void {
  bot.command("warn", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;
    const target = ctx.message?.reply_to_message?.from;
    if (!target) { await ctx.reply("Reply to a user to warn them."); return; }
    const chatId = ctx.chat!.id;
    const warnedBy = ctx.from!.id;
    try {
      await db.insert(warningsTable).values({ chatId, userId: target.id, warnedBy, reason: ctx.match?.trim() || undefined });
      const warns = await db.select().from(warningsTable).where(and(eq(warningsTable.chatId, chatId), eq(warningsTable.userId, target.id)));
      const count = warns.length;
      const mention = formatUser(target);
      if (count >= MAX_WARNINGS) {
        await ctx.api.banChatMember(chatId, target.id);
        await ctx.reply(`⛔ ${mention} banned after ${count} warnings.`, { parse_mode: "Markdown" });
      } else {
        await ctx.reply(`⚠️ ${mention} warned. (${count}/${MAX_WARNINGS})${ctx.match?.trim() ? `\nReason: ${ctx.match}` : ""}`, { parse_mode: "Markdown" });
      }
    } catch (err) { logger.error({ err }, "warn error"); await ctx.reply("❌ Failed."); }
  });

  bot.command("warnings", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    const target = ctx.message?.reply_to_message?.from;
    if (!target) { await ctx.reply("Reply to a user to check warnings."); return; }
    try {
      const warns = await db.select().from(warningsTable).where(and(eq(warningsTable.chatId, ctx.chat!.id), eq(warningsTable.userId, target.id)));
      await ctx.reply(`📋 ${formatUser(target)} has *${warns.length}/${MAX_WARNINGS}* warnings.`, { parse_mode: "Markdown" });
    } catch (err) { logger.error({ err }, "warnings error"); await ctx.reply("❌ Failed."); }
  });

  bot.command("resetwarns", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;
    const target = ctx.message?.reply_to_message?.from;
    if (!target) { await ctx.reply("Reply to a user to reset their warnings."); return; }
    try {
      await db.delete(warningsTable).where(and(eq(warningsTable.chatId, ctx.chat!.id), eq(warningsTable.userId, target.id)));
      await ctx.reply(`✅ Warnings reset for ${formatUser(target)}.`, { parse_mode: "Markdown" });
    } catch (err) { logger.error({ err }, "resetwarns error"); await ctx.reply("❌ Failed."); }
  });

  bot.command("ban", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;
    const target = ctx.message?.reply_to_message?.from;
    if (!target) { await ctx.reply("Reply to a user to ban them."); return; }
    try {
      await ctx.api.banChatMember(ctx.chat!.id, target.id);
      await ctx.reply(`⛔ ${formatUser(target)} has been banned.`, { parse_mode: "Markdown" });
    } catch (err) { logger.error({ err }, "ban error"); await ctx.reply("❌ Failed. Check my permissions."); }
  });

  bot.command("unban", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;
    const target = ctx.message?.reply_to_message?.from;
    if (!target) { await ctx.reply("Reply to a user to unban them."); return; }
    try {
      await ctx.api.unbanChatMember(ctx.chat!.id, target.id);
      await ctx.reply(`✅ ${formatUser(target)} has been unbanned.`, { parse_mode: "Markdown" });
    } catch (err) { logger.error({ err }, "unban error"); await ctx.reply("❌ Failed."); }
  });

  bot.command("mute", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;
    const target = ctx.message?.reply_to_message?.from;
    if (!target) { await ctx.reply("Reply to a user to mute them."); return; }
    try {
      await ctx.api.restrictChatMember(ctx.chat!.id, target.id, {
        can_send_messages: false, can_send_audios: false, can_send_documents: false,
        can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
        can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false,
      });
      await ctx.reply(`🔇 ${formatUser(target)} has been muted.`, { parse_mode: "Markdown" });
    } catch (err) { logger.error({ err }, "mute error"); await ctx.reply("❌ Failed. Check my permissions."); }
  });

  bot.command("unmute", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;
    const target = ctx.message?.reply_to_message?.from;
    if (!target) { await ctx.reply("Reply to a user to unmute them."); return; }
    try {
      await ctx.api.restrictChatMember(ctx.chat!.id, target.id, {
        can_send_messages: true, can_send_audios: true, can_send_documents: true,
        can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
        can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
        can_add_web_page_previews: true,
      });
      await ctx.reply(`🔊 ${formatUser(target)} has been unmuted.`, { parse_mode: "Markdown" });
    } catch (err) { logger.error({ err }, "unmute error"); await ctx.reply("❌ Failed."); }
  });

  bot.command("bl", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;
    const word = ctx.match?.trim().toLowerCase();
    if (!word) { await ctx.reply("Usage: /bl word"); return; }
    try {
      await db.insert(blacklistTable).values({ chatId: ctx.chat!.id, word, addedBy: ctx.from!.id });
      await ctx.reply(`✅ Word "${word}" blacklisted.`);
    } catch (err) { logger.error({ err }, "bl error"); await ctx.reply("❌ Failed."); }
  });

  bot.command("unbl", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;
    const word = ctx.match?.trim().toLowerCase();
    if (!word) { await ctx.reply("Usage: /unbl word"); return; }
    try {
      await db.delete(blacklistTable).where(and(eq(blacklistTable.chatId, ctx.chat!.id), eq(blacklistTable.word, word)));
      await ctx.reply(`✅ Word "${word}" removed.`);
    } catch (err) { logger.error({ err }, "unbl error"); await ctx.reply("❌ Failed."); }
  });

  bot.command("bllist", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    try {
      const words = await db.select().from(blacklistTable).where(eq(blacklistTable.chatId, ctx.chat!.id));
      if (words.length === 0) { await ctx.reply("📋 No blacklisted words."); return; }
      await ctx.reply(`📋 *Blacklisted Words*\n\n${words.map((w) => `• ${w.word}`).join("\n")}`, { parse_mode: "Markdown" });
    } catch (err) { logger.error({ err }, "bllist error"); await ctx.reply("❌ Failed."); }
  });

  bot.command("links", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;
    const arg = ctx.match?.trim().toLowerCase();
    if (arg !== "on" && arg !== "off") { await ctx.reply("Usage: /links on|off"); return; }
    const enabled = arg === "on";
    try {
      await db.insert(groupSettingsTable).values({ chatId: ctx.chat!.id, linksEnabled: enabled })
        .onConflictDoUpdate({ target: groupSettingsTable.chatId, set: { linksEnabled: enabled, updatedAt: new Date() } });
      await ctx.reply(`🔗 Links ${enabled ? "✅ enabled" : "❌ disabled"}.`);
    } catch (err) { logger.error({ err }, "links error"); await ctx.reply("❌ Failed."); }
  });

  bot.command("forwards", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;
    const arg = ctx.match?.trim().toLowerCase();
    if (arg !== "on" && arg !== "off") { await ctx.reply("Usage: /forwards on|off"); return; }
    const enabled = arg === "on";
    try {
      await db.insert(groupSettingsTable).values({ chatId: ctx.chat!.id, forwardsEnabled: enabled })
        .onConflictDoUpdate({ target: groupSettingsTable.chatId, set: { forwardsEnabled: enabled, updatedAt: new Date() } });
      await ctx.reply(`↩️ Forwards ${enabled ? "✅ enabled" : "❌ disabled"}.`);
    } catch (err) { logger.error({ err }, "forwards error"); await ctx.reply("❌ Failed."); }
  });

  bot.command("captcha", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;
    const arg = ctx.match?.trim().toLowerCase();
    if (arg !== "on" && arg !== "off") { await ctx.reply("Usage: /captcha on|off"); return; }
    const enabled = arg === "on";
    try {
      await db.insert(groupSettingsTable).values({ chatId: ctx.chat!.id, captchaEnabled: enabled })
        .onConflictDoUpdate({ target: groupSettingsTable.chatId, set: { captchaEnabled: enabled, updatedAt: new Date() } });
      await ctx.reply(`🤖 Captcha ${enabled ? "✅ enabled" : "❌ disabled"}.`);
    } catch (err) { logger.error({ err }, "captcha error"); await ctx.reply("❌ Failed."); }
  });

  bot.command("antispam", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;
    const arg = ctx.match?.trim().toLowerCase();
    if (arg !== "on" && arg !== "off") { await ctx.reply("Usage: /antispam on|off"); return; }
    const enabled = arg === "on";
    try {
      await db.insert(groupSettingsTable).values({ chatId: ctx.chat!.id, antispamEnabled: enabled })
        .onConflictDoUpdate({ target: groupSettingsTable.chatId, set: { antispamEnabled: enabled, updatedAt: new Date() } });
      await ctx.reply(`🛡️ Antispam ${enabled ? "✅ enabled" : "❌ disabled"}.`);
    } catch (err) { logger.error({ err }, "antispam error"); await ctx.reply("❌ Failed."); }
  });

  bot.command("setwelcome", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;
    const msg = ctx.match?.trim();
    if (!msg) { await ctx.reply("Usage: /setwelcome [message]\n\nVariables: {name} {username}"); return; }
    try {
      await db.insert(groupSettingsTable).values({ chatId: ctx.chat!.id, welcomeMessage: msg })
        .onConflictDoUpdate({ target: groupSettingsTable.chatId, set: { welcomeMessage: msg, updatedAt: new Date() } });
      await ctx.reply(`✅ Welcome message set:\n\n${msg}`);
    } catch (err) { logger.error({ err }, "setwelcome error"); await ctx.reply("❌ Failed."); }
  });

  bot.command("pin", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;
    const reply = ctx.message?.reply_to_message;
    if (!reply) { await ctx.reply("Reply to a message to pin it."); return; }
    try {
      await ctx.api.pinChatMessage(ctx.chat!.id, reply.message_id);
      await ctx.reply("📌 Message pinned.");
    } catch (err) { logger.error({ err }, "pin error"); await ctx.reply("❌ Failed."); }
  });

  bot.command("unpin", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;
    try {
      await ctx.api.unpinAllChatMessages(ctx.chat!.id);
      await ctx.reply("✅ All messages unpinned.");
    } catch (err) { logger.error({ err }, "unpin error"); await ctx.reply("❌ Failed."); }
  });

  bot.command("settings", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    try {
      const settings = await getOrCreateSettings(ctx.chat!.id);
      await ctx.reply(buildSettingsText(settings), {
        parse_mode: "Markdown",
        reply_markup: buildSettingsKeyboard(settings),
      });
    } catch (err) { logger.error({ err }, "settings error"); await ctx.reply("❌ Failed."); }
  });

  bot.command("logs", async (ctx) => {
    if (!(await mustBeGroup(ctx))) return;
    if (!(await mustBeAdmin(ctx))) return;
    const arg = ctx.match?.trim();
    if (!arg) { await ctx.reply("Usage: /logs <channel_id>"); return; }
    const logChannelId = parseInt(arg, 10);
    if (isNaN(logChannelId)) { await ctx.reply("❌ Invalid channel ID."); return; }
    try {
      await db.insert(groupSettingsTable).values({ chatId: ctx.chat!.id, logChannelId })
        .onConflictDoUpdate({ target: groupSettingsTable.chatId, set: { logChannelId, updatedAt: new Date() } });
      await ctx.reply(`✅ Log channel set to \`${logChannelId}\`.`, { parse_mode: "Markdown" });
    } catch (err) { logger.error({ err }, "logs error"); await ctx.reply("❌ Failed."); }
  });
}

export function registerAdminCallbacks(bot: MyBot): void {
  const TOGGLE_FIELDS: Record<string, keyof typeof groupSettingsTable.$inferSelect> = {
    links: "linksEnabled",
    forwards: "forwardsEnabled",
    captcha: "captchaEnabled",
    antispam: "antispamEnabled",
  };

  bot.callbackQuery(/^settings:toggle:(.+)$/, async (ctx) => {
    if (!ctx.chat) { await ctx.answerCallbackQuery("⚠️ Use in a group."); return; }
    if (!(await mustBeAdmin(ctx))) { await ctx.answerCallbackQuery("⚠️ Admins only."); return; }

    const field = ctx.match[1] as string;
    const dbField = TOGGLE_FIELDS[field];
    if (!dbField) { await ctx.answerCallbackQuery(); return; }

    try {
      const settings = await getOrCreateSettings(ctx.chat.id);
      const current = settings[dbField] as boolean;
      const newVal = !current;

      await db
        .update(groupSettingsTable)
        .set({ [dbField]: newVal, updatedAt: new Date() })
        .where(eq(groupSettingsTable.chatId, ctx.chat.id));

      const updated = { ...settings, [dbField]: newVal };
      await ctx.editMessageText(buildSettingsText(updated), {
        parse_mode: "Markdown",
        reply_markup: buildSettingsKeyboard(updated),
      });
      await ctx.answerCallbackQuery(`${field} toggled ${newVal ? "ON" : "OFF"}`);
    } catch (err) {
      logger.error({ err }, "settings toggle error");
      await ctx.answerCallbackQuery("❌ Failed to update.");
    }
  });

  bot.callbackQuery("settings:refresh", async (ctx) => {
    if (!ctx.chat) { await ctx.answerCallbackQuery(); return; }
    try {
      const settings = await getOrCreateSettings(ctx.chat.id);
      await ctx.editMessageText(buildSettingsText(settings), {
        parse_mode: "Markdown",
        reply_markup: buildSettingsKeyboard(settings),
      });
      await ctx.answerCallbackQuery("✅ Refreshed");
    } catch (err) {
      logger.error({ err }, "settings refresh error");
      await ctx.answerCallbackQuery("❌ Failed.");
    }
  });

  bot.callbackQuery("settings:close", async (ctx) => {
    await ctx.deleteMessage().catch(() => {});
    await ctx.answerCallbackQuery();
  });
}
