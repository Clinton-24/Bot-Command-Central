/**
 * Reminders + email secretary + daily morning briefing
 * Digest is plain text (no parse_mode) so /connect_gmail underscores never break Telegram.
 */

import { InlineKeyboard } from "grammy";
import { and, eq, ne } from "drizzle-orm";
import { pool, db, productsTable, meetingsTable, accessTable } from "@workspace/db";
import type { MyBot } from "../index";
import { isOwner } from "../helpers";
import { checkAccess } from "./access";
import { md } from "../utils/escape";
import { logger } from "../../lib/logger";
import { routeChat } from "../../lib/model-router";
import {
  buildGmailAuthUrl,
  disconnectUserGmail,
  fetchRecentEmailsForUser,
  formatEmailsForPrompt,
  getUserGmail,
  hasUserGmail,
  isGmailOAuthAppConfigured,
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

function msUntilNextNairobiTime(hour: number, minute = 0): number {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  const y = Number(get("year"));
  const mo = Number(get("month"));
  const d = Number(get("day"));
  const h = Number(get("hour"));
  const mi = Number(get("minute"));
  const s = Number(get("second"));
  const nowNairobiAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let targetNairobiAsUtc = Date.UTC(y, mo - 1, d, hour, minute, 0);
  if (targetNairobiAsUtc <= nowNairobiAsUtc) targetNairobiAsUtc += 24 * 60 * 60 * 1000;
  return targetNairobiAsUtc - nowNairobiAsUtc;
}

async function listBriefingRecipients(): Promise<number[]> {
  const ids = new Set<number>();
  const ownerId = parseInt(process.env["BOT_OWNER_ID"] ?? "0", 10);
  if (ownerId) ids.add(ownerId);
  try {
    const rows = await db
      .select({ userId: accessTable.userId })
      .from(accessTable)
      .where(and(eq(accessTable.isApproved, true), ne(accessTable.tier, "blocked")));
    for (const r of rows) {
      const id = Number(r.userId);
      if (id) ids.add(id);
    }
  } catch (err) {
    logger.warn({ err }, "listBriefingRecipients failed");
  }
  return [...ids];
}

export async function createReminder(userId: number, label: string, fireAt: Date): Promise<number> {
  const result = await pool.query(
    `INSERT INTO bot_reminders (user_id, label, fire_at) VALUES ($1, $2, $3) RETURNING id`,
    [userId, label.slice(0, 500), fireAt.toISOString()],
  );
  return Number(result.rows[0].id);
}

export async function listPendingReminders(userId: number): Promise<ReminderRow[]> {
  const result = await pool.query(
    `SELECT id, user_id, label, fire_at, sent_at, created_at FROM bot_reminders
     WHERE user_id = $1 AND sent_at IS NULL ORDER BY fire_at ASC LIMIT 30`,
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
    `SELECT id, user_id, label, fire_at FROM bot_reminders
     WHERE sent_at IS NULL AND fire_at <= NOW() ORDER BY fire_at ASC LIMIT 50`,
  );
  let sent = 0;
  for (const row of result.rows) {
    try {
      await bot.api.sendMessage(
        Number(row.user_id),
        `⏰ REMINDER\n━━━━━━━━━━━━━━━━━━\n\n${row.label}`,
      );
      await pool.query(`UPDATE bot_reminders SET sent_at = NOW() WHERE id = $1`, [row.id]);
      sent++;
    } catch (err) {
      logger.error({ err, id: row.id }, "Failed to send reminder");
    }
  }
  return sent;
}

export async function buildEmailBriefing(userId: number): Promise<string> {
  if (!(await hasUserGmail(userId))) {
    return "📧 EMAIL NOT CONNECTED\n\nLink your Gmail with /connect_gmail so it appears in /digest and the 10:00 Nairobi briefing.";
  }
  const emails = await fetchRecentEmailsForUser(userId, { maxResults: 20 });
  if (emails.length === 0) {
    return "📧 INBOX\n\nNo recent primary inbox messages (last 2 days).";
  }
  const block = formatEmailsForPrompt(emails);
  try {
    const ai = await routeChat("analysis", [
      {
        role: "system",
        content:
          "You are an executive email secretary. Extract ONLY vital or time-sensitive items. " +
          "Plain text with emoji section headers (no Markdown). " +
          "Sections: Worth a look / Action required / Low priority. Max ~350 words. Never invent emails.",
      },
      { role: "user", content: `Inbox dump (${emails.length} messages):\n\n${block}` },
    ]);
    return `📧 EMAIL BRIEFING\n━━━━━━━━━━━━━━━━━━\n\n${ai.reply}`;
  } catch (err) {
    logger.warn({ err }, "AI email summary failed");
    const lines = emails
      .slice(0, 10)
      .map((e) => `• ${e.subject}\n  ${e.from}\n  ${e.snippet.slice(0, 120)}`)
      .join("\n\n");
    return `📧 INBOX (raw)\n━━━━━━━━━━━━━━━━━━\n\n${lines}`;
  }
}

export async function sendMorningBriefing(
  userId: number,
  bot: MyBot,
  options?: { includeEmail?: boolean },
): Promise<void> {
  const includeEmail = options?.includeEmail ?? (await hasUserGmail(userId));
  const now = new Date();
  const dateLine = now.toLocaleDateString("en-KE", {
    timeZone: "Africa/Nairobi",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  let text =
    `☀️ DAILY BRIEFING — ${dateLine}\n━━━━━━━━━━━━━━━━━━\n10:00 Africa/Nairobi\n\n`;

  try {
    const meetings = await db.select().from(meetingsTable).limit(20);
    const todayStr = now.toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
    const todayMeetings = meetings.filter((m: any) => {
      const raw = m.scheduledAt ?? m.startsAt ?? m.date ?? m.meetingAt;
      if (!raw) return false;
      return new Date(raw).toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" }) === todayStr;
    });
    text += `📅 Calendar\n`;
    if (todayMeetings.length === 0) text += `No meetings on the books today.\n\n`;
    else {
      for (const m of todayMeetings.slice(0, 8) as any[]) {
        const title = String(m.title ?? m.name ?? "Meeting");
        const when = m.scheduledAt ?? m.startsAt ?? "";
        text += `• ${title}${when ? ` — ${new Date(when).toLocaleTimeString("en-KE", { timeZone: "Africa/Nairobi", hour: "2-digit", minute: "2-digit" })}` : ""}\n`;
      }
      text += `\n`;
    }
  } catch (err) {
    logger.warn({ err }, "briefing meetings failed");
    text += `📅 Calendar\n(unavailable)\n\n`;
  }

  try {
    const pending = await listPendingReminders(userId);
    text += `⏰ Your reminders (${pending.length} pending)\n`;
    if (pending.length === 0) text += `None queued. Use /remind 2h message\n\n`;
    else {
      for (const r of pending.slice(0, 8)) {
        const when = new Date(r.fire_at).toLocaleString("en-KE", {
          timeZone: "Africa/Nairobi",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
        text += `• ${when} — ${r.label}\n`;
      }
      text += `\n`;
    }
  } catch (err) {
    logger.warn({ err }, "briefing reminders failed");
  }

  if (includeEmail) {
    try {
      if (await hasUserGmail(userId)) {
        const emails = await fetchRecentEmailsForUser(userId, { maxResults: 18 });
        text += `📧 Inbox (${emails.length} recent primary)\n`;
        if (emails.length === 0) text += `Quiet — no primary mail in last 2 days.\n\n`;
        else {
          const block = formatEmailsForPrompt(emails);
          try {
            const ai = await routeChat("analysis", [
              {
                role: "system",
                content:
                  "Executive secretary morning email section. Plain text only. " +
                  "Sections: Worth a look / Action required / Low priority. Max 280 words. Never invent emails.",
              },
              { role: "user", content: block },
            ]);
            text += `${ai.reply}\n\n`;
          } catch {
            for (const e of emails.slice(0, 5)) text += `• ${e.subject} — ${e.from}\n`;
            text += `\n`;
          }
        }
      } else {
        text += `📧 Inbox\nNot connected — /connect_gmail\n\n`;
      }
    } catch (err) {
      logger.warn({ err }, "briefing email failed");
      text += `📧 Inbox\nScan failed\n\n`;
    }
  } else {
    text += `📧 Inbox\nNot linked — /connect_gmail\n\n`;
  }

  try {
    const products = await db.select().from(productsTable).where(eq(productsTable.isActive, true));
    const lowStock = products.filter((p) => {
      const s = Number(p.stock);
      return Number.isFinite(s) && s > 0 && s <= 5;
    });
    text += `🛍️ Shop\n• Active products: ${products.length}\n`;
    if (lowStock.length > 0) {
      text += `• Low stock (1-5 left): ${lowStock.map((p) => `${p.name} (${p.stock})`).join(", ")}\n`;
    } else {
      text += `• Stock: all unlimited or healthy\n`;
    }
    text += `\n`;
  } catch (err) {
    logger.warn({ err }, "briefing shop failed");
  }

  text += `🎯 Suggested focus\n• Review your reminders (/reminders)\n`;
  if (includeEmail) text += `• Handle action-required emails (/inbox)\n`;
  else text += `• Connect Gmail with /connect_gmail\n`;
  text += `• Check shop if low-stock items are listed\n`;
  text += `\nCommands: /digest · /remind · /reminders · /connect_gmail · /inbox`;

  if (text.length > 4000) text = text.slice(0, 3990) + "\n…";
  // Always plain text — no parse_mode (underscores in command names break Markdown)
  await bot.api.sendMessage(userId, text);
}

export async function sendDailyDigest(userId: number, bot: MyBot): Promise<void> {
  await sendMorningBriefing(userId, bot, { includeEmail: await hasUserGmail(userId) });
}

export function registerReminderHandlers(bot: MyBot): void {
  bot.command("remind", async (ctx) => {
    if (!ctx.from) return;
    if (!(await checkAccess(ctx, "free"))) return;

    const args = ctx.match?.trim() ?? "";
    const parts = args.match(/^(\S+)\s+(.+)$/s);
    if (!parts) {
      await ctx.reply(
        `⏰ Set a Reminder\n━━━━━━━━━━━━━━━━━━\n\nUsage: /remind <time> <message>\n\nExamples:\n• /remind 30m Check emails\n• /remind 2h Team call\n• /remind 1d Review report\n\nAlso: /reminders · /digest · /connect_gmail`,
      );
      return;
    }

    const [, timeStr, label] = parts;
    const delayMs = parseDelay(timeStr!);
    if (!delayMs || delayMs <= 0) {
      await ctx.reply("❌ Invalid time. Use: 30s, 5m, 2h, 1d");
      return;
    }
    if (delayMs > 30 * 24 * 60 * 60 * 1000) {
      await ctx.reply("❌ Maximum is 30 days.");
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
      `⏰ Reminder Set! (#${id})\n━━━━━━━━━━━━━━━━━━\n\n📌 ${label}\n🕐 ${when} (Nairobi)`,
      { reply_markup: new InlineKeyboard().text("⏰ My Reminders", "reminders:list") },
    );
  });

  bot.command("reminders", async (ctx) => {
    if (!ctx.from) return;
    if (!(await checkAccess(ctx, "free"))) return;
    const rows = await listPendingReminders(ctx.from.id);
    if (rows.length === 0) {
      await ctx.reply("⏰ No pending reminders\n\n/remind 2h Check the inbox");
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
    await ctx.reply(`⏰ Pending (${rows.length})\n━━━━━━━━━━━━━━━━━━\n\n${lines}`, {
      reply_markup: new InlineKeyboard().text("🗑️ Clear all", "reminders:clear_all"),
    });
  });

  bot.command("connect_gmail", async (ctx) => {
    if (!ctx.from) return;
    if (!(await checkAccess(ctx, "free"))) return;

    if (!isGmailOAuthAppConfigured()) {
      await ctx.reply(
        "📧 Gmail linking not available yet\n\nOwner must set on Render:\n• GOOGLE_CLIENT_ID\n• GOOGLE_CLIENT_SECRET\n\nAnd add redirect URI:\nhttps://bot-command-central-1.onrender.com/oauth/google/callback",
      );
      return;
    }

    try {
      const url = buildGmailAuthUrl(ctx.from.id);
      const existing = await getUserGmail(ctx.from.id);
      await ctx.reply(
        `📧 Connect your Gmail\n━━━━━━━━━━━━━━━━━━\n\n` +
          (existing?.email ? `Currently linked: ${existing.email}\n\n` : "") +
          `Tap below → choose Google account → allow read-only access.\n\n` +
          `Only used for your /inbox, /digest, and 10:00 Nairobi briefing.`,
        { reply_markup: new InlineKeyboard().url("🔗 Connect Gmail", url) },
      );
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Failed"}`);
    }
  });

  bot.command("disconnect_gmail", async (ctx) => {
    if (!ctx.from) return;
    if (!(await checkAccess(ctx, "free"))) return;
    const ok = await disconnectUserGmail(ctx.from.id);
    await ctx.reply(ok ? "✅ Gmail disconnected." : "No Gmail was connected.");
  });

  bot.command("inbox", async (ctx) => {
    if (!ctx.from) return;
    if (!(await checkAccess(ctx, "free"))) return;

    if (!(await hasUserGmail(ctx.from.id))) {
      await ctx.reply("📧 No Gmail linked\n\nUse /connect_gmail first.");
      return;
    }

    const thinking = await ctx.reply("📧 Scanning inbox...");
    try {
      const briefing = await buildEmailBriefing(ctx.from.id);
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
      await ctx.reply(briefing);
    } catch (err) {
      logger.error({ err }, "inbox scan failed");
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Unknown"}`);
    }
  });

  bot.callbackQuery("reminders:list", async (ctx) => {
    if (!ctx.from) return;
    if (!(await checkAccess(ctx, "free"))) {
      await ctx.answerCallbackQuery("Access required");
      return;
    }
    await ctx.answerCallbackQuery();
    const rows = await listPendingReminders(ctx.from.id);
    const text =
      rows.length === 0
        ? "⏰ No pending reminders."
        : `⏰ Pending (${rows.length})\n\n` +
          rows
            .map((r) => `• #${r.id} ${new Date(r.fire_at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })}\n  ${r.label}`)
            .join("\n\n");
    await ctx.reply(text);
  });

  bot.callbackQuery("reminders:clear_all", async (ctx) => {
    if (!ctx.from) return;
    if (!(await checkAccess(ctx, "free"))) {
      await ctx.answerCallbackQuery("Access required");
      return;
    }
    const n = await clearPendingReminders(ctx.from.id);
    await ctx.answerCallbackQuery(`🗑️ ${n} cleared`);
    await ctx.editMessageText(`🗑️ Cleared ${n} reminder(s).`);
  });

  bot.command("digest", async (ctx) => {
    if (!ctx.from) return;
    if (!(await checkAccess(ctx, "free"))) return;
    const thinking = await ctx.reply("☀️ Building briefing...");
    try {
      await sendMorningBriefing(ctx.from.id, bot, {
        includeEmail: await hasUserGmail(ctx.from.id),
      });
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    } catch (err) {
      logger.error({ err }, "digest failed");
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Unknown"}`);
    }
  });
}

export function startDailyDigestScheduler(bot: MyBot): void {
  function scheduleNext(): void {
    const delay = msUntilNextNairobiTime(10, 0);
    const nextAt = new Date(Date.now() + delay);
    setTimeout(async () => {
      try {
        await fireDueReminders(bot);
        const recipients = await listBriefingRecipients();
        logger.info({ count: recipients.length }, "Sending 10:00 Nairobi briefings");
        for (const userId of recipients) {
          try {
            await sendMorningBriefing(userId, bot, {
              includeEmail: await hasUserGmail(userId),
            });
          } catch (err) {
            logger.error({ err, userId }, "briefing send failed");
          }
        }
      } catch (err) {
        logger.error({ err }, "daily briefing failed");
      }
      scheduleNext();
    }, delay);
    logger.info({ nextBriefing: nextAt.toISOString() }, "Daily briefing at 10:00 Africa/Nairobi");
  }
  scheduleNext();
}

export function startTwoHourPingScheduler(bot: MyBot): void {
  const ownerId = parseInt(process.env["BOT_OWNER_ID"] ?? "0", 10);
  if (!ownerId) {
    logger.warn("BOT_OWNER_ID not set — 2h ping disabled");
    return;
  }

  async function tick(): Promise<void> {
    try {
      const fired = await fireDueReminders(bot);
      const pending = await listPendingReminders(ownerId);
      let text =
        `🔔 2-HOUR PING\n━━━━━━━━━━━━━━━━━━\n⏰ Fired: ${fired}\n📌 Pending: ${pending.length}\n`;
      if (pending.length > 0) {
        text +=
          "\nNext up:\n" +
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
      if (await hasUserGmail(ownerId)) {
        try {
          const emails = await fetchRecentEmailsForUser(ownerId, { maxResults: 8 });
          const urgent = emails.slice(0, 3);
          if (urgent.length > 0) {
            text += "\n\n📧 Mail pulse\n";
            text += urgent.map((e) => `• ${e.subject} — ${e.from}`).join("\n");
          }
        } catch (err) {
          logger.warn({ err }, "2h email pulse failed");
        }
      }
      text += "\n\n/digest · /inbox · /reminders";
      await bot.api.sendMessage(ownerId, text);
    } catch (err) {
      logger.error({ err }, "2h ping failed");
    }
  }

  setInterval(() => {
    fireDueReminders(bot).catch((err) => logger.error({ err }, "reminder poll failed"));
  }, 2 * 60 * 1000);

  setInterval(() => {
    void tick();
  }, 2 * 60 * 60 * 1000);

  logger.info("2-hour owner ping started");
}
