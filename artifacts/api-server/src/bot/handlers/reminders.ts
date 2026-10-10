/**
 * Reminders + email secretary pings
 * • /remind — persistent DB reminders
 * • /reminders — list pending
 * • /inbox — Gmail scan + AI vital summary
 * • Every 2 hours: ping owner with due reminders + mail pulse
 */

import { InlineKeyboard } from "grammy";
import { pool } from "@workspace/db";
import type { MyBot } from "../index";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";
import { sendDailyDigest } from "./hexagon";
import { routeChat } from "../../lib/model-router";
import {
  fetchRecentEmails,
  formatEmailsForPrompt,
  isGmailConfigured,
} from "../../lib/gmail";

interface ReminderRow {
  id: number;
  user_id: string;
  label: string;
  fire_at: Date;
  sent_at: Date | null;
  created_at: Date;
}

function parseDelay(input: string): number | null {
  const match = input.match(
    /^(\d+(?:\.\d+)?)\s*(s|m|h|d|min|sec|hour|day|hours|days|mins|seconds?)$/i,
  );
  if (!match) return null;
  const val = parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();
  if (unit.startsWith("s")) return val * 1000;
  if (unit.startsWith("m")) return val * 60 * 1000;
  if (unit.startsWith("h")) return val * 60 * 60 * 1000;
  if (unit.startsWith("d")) return val * 24 * 60 * 60 * 1000;
  return null;
}

export async function createReminder(
  userId: number,
  label: string,
  fireAt: Date,
): Promise<number> {
  const result = await pool.query(
    `INSERT INTO bot_reminders (user_id, label, fire_at)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [userId, label.slice(0, 500), fireAt.toISOString()],
  );
  return Number(result.rows[0].id);
}

export async function listPendingReminders(userId: number): Promise<ReminderRow[]> {
  const result = await pool.query(
    `SELECT id, user_id, label, fire_at, sent_at, created_at
     FROM bot_reminders
     WHERE user_id = $1 AND sent_at IS NULL
     ORDER BY fire_at ASC
     LIMIT 30`,
    [userId],
  );
  return result.rows as ReminderRow[];
}

export async function clearPendingReminders(userId: number): Promise<number> {
  const result = await pool.query(
    `DELETE FROM bot_reminders WHERE user_id = $1 AND sent_at IS NULL`,
    [userId],
  );
  return result.rowCount ?? 0;
}

export async function fireDueReminders(bot: MyBot): Promise<number> {
  const result = await pool.query(
    `SELECT id, user_id, label, fire_at
     FROM bot_reminders
     WHERE sent_at IS NULL AND fire_at <= NOW()
     ORDER BY fire_at ASC
     LIMIT 50`,
  );
  let sent = 0;
  for (const row of result.rows) {
    try {
      await bot.api.sendMessage(
        Number(row.user_id),
        `⏰ *REMINDER*\n━━━━━━━━━━━━━━━━━━\n\n${row.label}`,
        { parse_mode: "Markdown" },
      );
      await pool.query(`UPDATE bot_reminders SET sent_at = NOW() WHERE id = $1`, [row.id]);
      sent++;
    } catch (err) {
      logger.error({ err, id: row.id }, "Failed to send reminder");
    }
  }
  return sent;
}

export async function buildEmailBriefing(): Promise<string> {
  if (!isGmailConfigured()) {
    return (
      "📧 *Email not connected*\n\n" +
      "Set these on Render:\n" +
      "• `GOOGLE_CLIENT_ID`\n" +
      "• `GOOGLE_CLIENT_SECRET`\n" +
      "• `GMAIL_REFRESH_TOKEN`\n\n" +
      "_Enable Gmail API, create OAuth client, generate refresh token with gmail.readonly scope._"
    );
  }

  const emails = await fetchRecentEmails({ maxResults: 20 });
  if (emails.length === 0) {
    return "📧 *Inbox*\n━━━━━━━━━━━━━━━━━━\n\nNo recent primary inbox messages (last 2 days).";
  }

  const block = formatEmailsForPrompt(emails);
  try {
    const ai = await routeChat("analysis", [
      {
        role: "system",
        content:
          "You are an executive email secretary. From the inbox dump, extract ONLY what is vital or time-sensitive. " +
          "Output Telegram Markdown with sections:\n" +
          "🔴 Worth a look\n🚨 Action required\nLow priority (brief)\n" +
          "Be sharp. No fluff. Max ~350 words. Never invent emails.",
      },
      { role: "user", content: `Inbox dump (${emails.length} messages):\n\n${block}` },
    ]);
    return `📧 *EMAIL BRIEFING*\n━━━━━━━━━━━━━━━━━━\n\n${ai.reply}`;
  } catch (err) {
    logger.warn({ err }, "AI email summary failed — falling back to raw list");
    const lines = emails
      .slice(0, 10)
      .map((e) => `• *${e.subject}*\n  _${e.from}_\n  ${e.snippet.slice(0, 120)}`)
      .join("\n\n");
    return `📧 *INBOX* (raw)\n━━━━━━━━━━━━━━━━━━\n\n${lines}`;
  }
}

export function registerReminderHandlers(bot: MyBot): void {
  bot.command("remind", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Reminders are owner-only.");
      return;
    }

    const args = ctx.match?.trim() ?? "";
    const parts = args.match(/^(\S+)\s+(.+)$/s);
    if (!parts) {
      await ctx.reply(
        `⏰ *Set a Reminder*\n━━━━━━━━━━━━━━━━━━\n\n` +
          `Usage: /remind <time> <message>\n\n` +
          `Examples:\n` +
          `• /remind 30m Check emails\n` +
          `• /remind 2h Team call at 3pm\n` +
          `• /remind 1d Review monthly report\n\n` +
          `Time units: s, m, h, d\n` +
          `Also: /inbox · /reminders · every 2h auto-ping`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    const [, timeStr, label] = parts;
    const delayMs = parseDelay(timeStr!);
    if (!delayMs || delayMs <= 0) {
      await ctx.reply(`❌ Invalid time format.\n\nUse: 30s, 5m, 2h, 1d`);
      return;
    }

    const maxMs = 30 * 24 * 60 * 60 * 1000;
    if (delayMs > maxMs) {
      await ctx.reply("❌ Maximum reminder time is 30 days.");
      return;
    }

    const fireAt = new Date(Date.now() + delayMs);
    const id = await createReminder(ctx.from.id, label!, fireAt);

    const when = fireAt.toLocaleString("en-KE", {
      timeZone: "Africa/Nairobi",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

    await ctx.reply(
      `⏰ *Reminder Set!* (#${id})\n━━━━━━━━━━━━━━━━━━\n\n📌 ${label}\n🕐 ${when} (Nairobi)`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("⏰ My Reminders", "reminders:list")
          .text("📧 Inbox", "reminders:inbox"),
      },
    );
  });

  bot.command("reminders", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner only.");
      return;
    }
    const rows = await listPendingReminders(ctx.from.id);
    if (rows.length === 0) {
      await ctx.reply(
        `⏰ *No pending reminders*\n\nSet one with:\n/remind 2h Check the inbox`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("📧 Scan inbox", "reminders:inbox"),
        },
      );
      return;
    }
    const lines = rows
      .map((r) => {
        const when = new Date(r.fire_at).toLocaleString("en-KE", {
          timeZone: "Africa/Nairobi",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        return `• #${r.id} — ${when}\n  ${r.label}`;
      })
      .join("\n\n");
    await ctx.reply(`⏰ *Pending reminders* (${rows.length})\n━━━━━━━━━━━━━━━━━━\n\n${lines}`, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🗑️ Clear all", "reminders:clear_all")
        .text("📧 Inbox", "reminders:inbox"),
    });
  });

  bot.command("inbox", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner only.");
      return;
    }
    const thinking = await ctx.reply("📧 _Scanning inbox..._", { parse_mode: "Markdown" });
    try {
      const briefing = await buildEmailBriefing();
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
      await ctx.reply(briefing, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error({ err }, "inbox scan failed");
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
      await ctx.reply(`❌ Inbox scan failed:\n${err instanceof Error ? err.message : "Unknown"}`);
    }
  });

  bot.callbackQuery("reminders:list", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    await ctx.answerCallbackQuery();
    const rows = await listPendingReminders(ctx.from.id);
    const text =
      rows.length === 0
        ? "⏰ No pending reminders."
        : `⏰ *Pending* (${rows.length})\n\n` +
          rows
            .map((r) => `• #${r.id} ${new Date(r.fire_at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })}\n  ${r.label}`)
            .join("\n\n");
    await ctx.reply(text, { parse_mode: "Markdown" });
  });

  bot.callbackQuery("reminders:inbox", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    await ctx.answerCallbackQuery();
    const thinking = await ctx.reply("📧 _Scanning..._", { parse_mode: "Markdown" });
    try {
      const briefing = await buildEmailBriefing();
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
      await ctx.reply(briefing, { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Failed"}`);
    }
  });

  bot.callbackQuery("reminders:clear_all", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    const n = await clearPendingReminders(ctx.from.id);
    await ctx.answerCallbackQuery(`🗑️ ${n} cleared`);
    await ctx.editMessageText(
      `🗑️ *All Reminders Cleared*\n━━━━━━━━━━━━━━━━━━\n\n${n} reminder(s) removed.`,
      { parse_mode: "Markdown" },
    );
  });

  bot.command("digest", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner only.");
      return;
    }
    await sendDailyDigest(ctx.from.id, bot);
  });
}

let dailyDigestTimer: ReturnType<typeof setTimeout> | null = null;
let twoHourTimer: ReturnType<typeof setInterval> | null = null;

export function startDailyDigestScheduler(bot: MyBot): void {
  const ownerId = parseInt(process.env["BOT_OWNER_ID"] ?? "0", 10);
  if (!ownerId) {
    logger.warn("BOT_OWNER_ID not set — daily digest disabled");
    return;
  }

  function scheduleNext(): void {
    const now = new Date();
    const next = new Date();
    next.setHours(8, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next.getTime() - now.getTime();
    dailyDigestTimer = setTimeout(async () => {
      await sendDailyDigest(ownerId, bot).catch((err) =>
        logger.error({ err }, "daily digest failed"),
      );
      scheduleNext();
    }, delay);
    logger.info({ nextDigest: next.toISOString() }, "Daily digest scheduled");
  }

  scheduleNext();
}

/** Every 2 hours: fire due reminders + ping owner with status + email pulse. */
export function startTwoHourPingScheduler(bot: MyBot): void {
  const ownerId = parseInt(process.env["BOT_OWNER_ID"] ?? "0", 10);
  if (!ownerId) {
    logger.warn("BOT_OWNER_ID not set — 2h ping disabled");
    return;
  }

  const INTERVAL = 2 * 60 * 60 * 1000;

  async function tick(): Promise<void> {
    try {
      const fired = await fireDueReminders(bot);
      const pending = await listPendingReminders(ownerId);
      let text =
        `🔔 *2-HOUR PING*\n━━━━━━━━━━━━━━━━━━\n` +
        `⏰ Fired now: *${fired}*\n` +
        `📌 Still pending: *${pending.length}*\n`;

      if (pending.length > 0) {
        text +=
          `\nNext up:\n` +
          pending
            .slice(0, 5)
            .map((r) => {
              const when = new Date(r.fire_at).toLocaleString("en-KE", {
                timeZone: "Africa/Nairobi",
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              });
              return `• ${when} — ${r.label}`;
            })
            .join("\n");
      }

      if (isGmailConfigured()) {
        try {
          const emails = await fetchRecentEmails({ maxResults: 8 });
          const urgent = emails.slice(0, 3);
          if (urgent.length > 0) {
            text += `\n\n📧 *Recent mail pulse*\n`;
            text += urgent.map((e) => `• ${e.subject} — _${e.from}_`).join("\n");
          } else {
            text += `\n\n📧 Inbox quiet (no primary mail in 2d).`;
          }
        } catch (err) {
          logger.warn({ err }, "2h email pulse failed");
          text += `\n\n📧 Email pulse failed (check Gmail env).`;
        }
      } else {
        text += `\n\n_Gmail not connected — set GOOGLE_CLIENT_ID / SECRET / GMAIL_REFRESH_TOKEN_`;
      }

      text += `\n\n/inbox for full briefing · /reminders to manage`;

      await bot.api.sendMessage(ownerId, text, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error({ err }, "2h ping tick failed");
    }
  }

  // Poll due reminders every 2 minutes so timed reminders fire on time
  setInterval(() => {
    fireDueReminders(bot).catch((err) => logger.error({ err }, "reminder poll failed"));
  }, 2 * 60 * 1000);

  twoHourTimer = setInterval(() => {
    void tick();
  }, INTERVAL);

  logger.info("2-hour owner ping scheduler started");
}
