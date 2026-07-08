import type { MyBot } from "../index";
import { isOwner } from "../helpers";
import { scheduleReminder, clearAllReminders, sendDailyDigest } from "./hexagon";
import { logger } from "../../lib/logger";
import { InlineKeyboard } from "grammy";

function parseDelay(input: string): number | null {
  const match = input.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|min|sec|hour|day|hours|days|mins|seconds?)$/i);
  if (!match) return null;
  const val = parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();
  if (unit.startsWith("s")) return val * 1000;
  if (unit.startsWith("m")) return val * 60 * 1000;
  if (unit.startsWith("h")) return val * 60 * 60 * 1000;
  if (unit.startsWith("d")) return val * 24 * 60 * 60 * 1000;
  return null;
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
          `Time units: s, m, h, d`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const [, timeStr, label] = parts;
    const delayMs = parseDelay(timeStr!);
    if (!delayMs || delayMs <= 0) {
      await ctx.reply(`❌ Invalid time format.\n\nUse: 30s, 5m, 2h, 1d`);
      return;
    }

    const maxMs = 7 * 24 * 60 * 60 * 1000;
    if (delayMs > maxMs) {
      await ctx.reply("❌ Maximum reminder time is 7 days.");
      return;
    }

    const fireAt = new Date(Date.now() + delayMs);
    scheduleReminder(bot, ctx.from.id, label!, fireAt);

    const when = fireAt.toLocaleString("en-US", {
      weekday: "short", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: true,
    });

    await ctx.reply(
      `⏰ *Reminder Set!*\n━━━━━━━━━━━━━━━━━━\n\n📌 ${label}\n🕐 ${when}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("⏰ View Reminders", "hexagon:reminders")
          .text("🤖 Hexagon", "menu:hexagon"),
      }
    );
  });

  bot.command("reminders", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner only.");
      return;
    }
    await ctx.reply(
      `⏰ Use the /remind command to set reminders.\n\nExample: /remind 1h Check messages`,
      {
        reply_markup: new InlineKeyboard()
          .text("⏰ My Reminders", "hexagon:reminders")
          .text("🤖 Hexagon", "menu:hexagon"),
      }
    );
  });

  bot.callbackQuery("reminders:clear_all", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    const n = clearAllReminders(ctx.from.id);
    await ctx.answerCallbackQuery(`🗑️ ${n} reminder(s) cleared`);
    await ctx.editMessageText(
      `🗑️ *All Reminders Cleared*\n━━━━━━━━━━━━━━━━━━\n\n${n} reminder(s) removed.`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🤖 Back to Hexagon", "menu:hexagon"),
      }
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
        logger.error({ err }, "daily digest failed")
      );
      scheduleNext();
    }, delay);
    logger.info({ nextDigest: next.toISOString() }, "Daily digest scheduled");
  }

  scheduleNext();
}
