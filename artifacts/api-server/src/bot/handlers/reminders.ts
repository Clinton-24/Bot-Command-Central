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

function nairobiParts(date = new Date()): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    weekday: get("weekday"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** Sat/Sun in Africa/Nairobi — XAUUSD session alerts stay silent. */
function isWeekendNairobi(date = new Date()): boolean {
  const wd = nairobiParts(date).weekday.toLowerCase();
  return wd === "sat" || wd === "sun";
}

function msUntilNextNairobiTime(hour: number, minute = 0): number {
  const now = new Date();
  const p = nairobiParts(now);
  const y = Number(p.year);
  const mo = Number(p.month);
  const d = Number(p.day);
  const h = Number(p.hour);
  const mi = Number(p.minute);
  const s = Number(p.second);
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
  await bot.api.sendMessage(userId, text);
}

export async function sendDailyDigest(userId: number, bot: MyBot): Promise<void> {
  await sendMorningBriefing(userId, bot, { includeEmail: await hasUserGmail(userId) });
}

/** Owner-only XAUUSD Volume Profile routine (Africa/Nairobi times). Weekends skipped. */
const XAU_ROUTINE_ALERTS: Array<{ hour: number; minute: number; title: string; body: string }> = [
  {
    hour: 0,
    minute: 5,
    title: "XAUUSD new day — draw FRVP",
    body:
      "Previous full day has closed. A new XAUUSD day is entering (Kenya time).\n\n" +
      "Do this now:\n" +
      "1. Open TradingView — 15m or 1H\n" +
      "2. Draw Fixed Range Volume Profile on the previous full day\n" +
      "   (Monday: use Friday's full day — weekend has no session)\n" +
      "3. Extend POC · VAH · VAL into today\n\n" +
      "Then only trade clear: POC Bounce · Value Area Reversal · Breakout\n" +
      "Rules: 0.5–1% risk · tight SL · ≥2R · max 2–3 losses then stop",
  },
  {
    hour: 9,
    minute: 0,
    title: "XAUUSD morning prep",
    body:
      "Simple Volume Profile routine\n" +
      "1. Open TradingView — 15m or 1H\n" +
      "2. Draw Fixed Range Volume Profile on the previous full day\n" +
      "3. Extend into today: POC · VAH · VAL\n\n" +
      "Setups only:\n" +
      "• POC Bounce — reject at POC\n" +
      "• Value Area Reversal — outside VAH/VAL then close back in\n" +
      "• Breakout — break VA, pullback, continue\n\n" +
      "Rules: risk 0.5–1% · tight SL · ≥2R · max 2–3 losses then stop\n" +
      "Only take the clear ones.",
  },
  {
    hour: 11,
    minute: 0,
    title: "London open — XAUUSD",
    body:
      "London session starting.\n" +
      "Watch POC / VAH / VAL for bounce, value-area reversal, or breakout + pullback.\n" +
      "Risk 0.5–1%. Max 2–3 losers then stop for the day.",
  },
  {
    hour: 16,
    minute: 30,
    title: "NY open / London–NY overlap — XAUUSD",
    body:
      "Highest volume window for gold.\n" +
      "Re-check POC · VAH · VAL. Prefer clear rejects or confirmed breakout continuations.\n" +
      "No force trades. Target ≥2R.",
  },
  {
    hour: 19,
    minute: 30,
    title: "London close check — XAUUSD",
    body:
      "London winding down. Review open risk.\n" +
      "If already 2–3 losses → stop. Protect the account.",
  },
  {
    hour: 22,
    minute: 0,
    title: "End-of-day review — XAUUSD",
    body:
      "Log the day: setups taken, R multiple, rule breaks.\n" +
      "Tomorrow: Fixed Range VP on today → extend POC/VAH/VAL again.\n" +
      "Keep it simple.",
  },
];

function scheduleNairobiDaily(
  hour: number,
  minute: number,
  label: string,
  run: () => Promise<void>,
): void {
  const scheduleNext = (): void => {
    const delay = msUntilNextNairobiTime(hour, minute);
    setTimeout(async () => {
      try {
        if (isWeekendNairobi()) {
          logger.info({ label }, "Skipping XAU alert — weekend in Nairobi");
        } else {
          await run();
        }
      } catch (err) {
        logger.error({ err, label }, "scheduled owner alert failed");
      }
      scheduleNext();
    }, delay);
    logger.info({ label, hour, minute, nextInMs: delay }, "Scheduled Nairobi daily alert");
  };
  scheduleNext();
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

  bot.command("sessions", async (ctx) => {
    if (!ctx.from) return;
    if (!isOwner(ctx.from.id)) {
      await ctx.reply("Owner only.");
      return;
    }
    const lines = XAU_ROUTINE_ALERTS.map(
      (a) =>
        `• ${String(a.hour).padStart(2, "0")}:${String(a.minute).padStart(2, "0")} — ${a.title}`,
    );
    await ctx.reply(
      `🥇 XAUUSD Volume Profile alerts (Nairobi)\n━━━━━━━━━━━━━━━━━━\n` + lines.join("\n"),
    );
  });

  bot.command("ping_off", async (ctx) => {
    if (!ctx.from) return;
    if (!isOwner(ctx.from.id)) {
      await ctx.reply("Owner only.");
      return;
    }
    await ctx.reply(
      `✅ Every-2-hour owner ping is OFF by default.\n` +
        `On Render → Environment: delete OWNER_2H_PING or set false, redeploy if it was true.\n` +
        `You still get XAUUSD alerts at times listed in /sessions.\n` +
        `Clear queued reminders: /reminders → Clear all`,
    );
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

/**
 * Always polls due reminders every 2 min.
 * Old every-2h owner spam is OFF by default (set OWNER_2H_PING=true to re-enable).
 * Owner gets XAUUSD Volume Profile session alerts instead (weekdays only).
 */
export function startTwoHourPingScheduler(bot: MyBot): void {
  const ownerId = parseInt(process.env["BOT_OWNER_ID"] ?? "0", 10);

  setInterval(() => {
    fireDueReminders(bot).catch((err) => logger.error({ err }, "reminder poll failed"));
  }, 2 * 60 * 1000);

  const want2h =
    (process.env["OWNER_2H_PING"] ?? "").toLowerCase() === "true" ||
    process.env["OWNER_2H_PING"] === "1";

  if (want2h && ownerId) {
    setInterval(async () => {
      try {
        const fired = await fireDueReminders(bot);
        const pending = await listPendingReminders(ownerId);
        let msg =
          `🔔 2-HOUR PING\n━━━━━━━━━━━━━━━━━━\n⏰ Fired: ${fired}\n📌 Pending: ${pending.length}\n`;
        if (pending.length > 0) {
          msg +=
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
        msg += "\n\nDisable: OWNER_2H_PING=false on Render · /ping_off · /reminders";
        await bot.api.sendMessage(ownerId, msg);
      } catch (err) {
        logger.error({ err }, "2h ping failed");
      }
    }, 2 * 60 * 60 * 1000);
    logger.info("2-hour owner ping ENABLED (OWNER_2H_PING=true)");
  } else {
    logger.info("2-hour owner ping disabled (default). Set OWNER_2H_PING=true to re-enable.");
  }

  if (!ownerId) {
    logger.warn("BOT_OWNER_ID not set — XAUUSD session alerts disabled");
    return;
  }

  for (const alert of XAU_ROUTINE_ALERTS) {
    scheduleNairobiDaily(alert.hour, alert.minute, alert.title, async () => {
      const when = new Date().toLocaleString("en-KE", {
        timeZone: "Africa/Nairobi",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      const body =
        `🥇 ${alert.title}\n━━━━━━━━━━━━━━━━━━\n${when} (Nairobi)\n\n${alert.body}\n\n` +
        `/digest · /reminders · /sessions`;
      await bot.api.sendMessage(ownerId, body);
    });
  }
  logger.info({ count: XAU_ROUTINE_ALERTS.length }, "XAUUSD Volume Profile session alerts armed for owner");
}
