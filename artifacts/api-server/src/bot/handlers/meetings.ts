import { InlineKeyboard } from "grammy";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { db } from "@workspace/db";
import { meetingsTable } from "@workspace/db";
import { eq, and, gte, desc } from "drizzle-orm";
import { logger } from "../../lib/logger";

function parseDateTime(input: string): Date | null {
  const clean = input.trim();

  const timeOnly = (base: Date, t: string): Date | null => {
    const hm = t.match(/^(\d{1,2}):(\d{2})$/);
    if (hm) {
      const d = new Date(base);
      d.setHours(parseInt(hm[1]!), parseInt(hm[2]!), 0, 0);
      return isNaN(d.getTime()) ? null : d;
    }
    const ampm = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
    if (ampm) {
      let hour = parseInt(ampm[1]!);
      const min = parseInt(ampm[2] ?? "0");
      if (ampm[3]!.toLowerCase() === "pm" && hour !== 12) hour += 12;
      if (ampm[3]!.toLowerCase() === "am" && hour === 12) hour = 0;
      const d = new Date(base);
      d.setHours(hour, min, 0, 0);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  };

  const lower = clean.toLowerCase();

  if (lower.startsWith("today")) {
    return timeOnly(new Date(), lower.replace("today", "").trim());
  }
  if (lower.startsWith("tomorrow")) {
    const next = new Date();
    next.setDate(next.getDate() + 1);
    return timeOnly(next, lower.replace("tomorrow", "").trim());
  }

  const iso = clean.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (iso) {
    const d = new Date(
      parseInt(iso[1]!),
      parseInt(iso[2]!) - 1,
      parseInt(iso[3]!),
      parseInt(iso[4]!),
      parseInt(iso[5]!)
    );
    return isNaN(d.getTime()) ? null : d;
  }

  const slash = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (slash) {
    const d = new Date(
      parseInt(slash[3]!),
      parseInt(slash[2]!) - 1,
      parseInt(slash[1]!),
      parseInt(slash[4]!),
      parseInt(slash[5]!)
    );
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}

function formatDate(d: Date): string {
  return d.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function formatStatus(s: string): string {
  return s === "upcoming" ? "⏳ Upcoming" : s === "cancelled" ? "❌ Cancelled" : "✅ Completed";
}

function meetingsMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Schedule Meeting", "meetings:schedule")
    .row()
    .text("📋 My Meetings", "meetings:list")
    .text("❌ Cancel Meeting", "meetings:cancel_pick")
    .row()
    .text("🔙 Main Menu", "menu:main");
}

const backToMeetingsKb = () =>
  new InlineKeyboard()
    .text("📅 Meetings", "meetings:main")
    .text("🏠 Main Menu", "menu:main");

export async function processMeetingInput(
  ctx: BotContext,
  step: string,
  input: string
): Promise<void> {
  if (step === "title") {
    const title = input.trim();
    if (!title || title.length > 100) {
      await ctx.reply("❌ Title must be 1–100 characters. Try again:");
      ctx.session.pendingAction = "meeting:title";
      return;
    }
    ctx.session.meetingDraft = { ...ctx.session.meetingDraft, title };
    ctx.session.pendingAction = "meeting:datetime";
    await ctx.reply(
      `📅 *NEW MEETING — Step 2/3*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `📌 Title: *${title}* ✅\n\n` +
        `When is the meeting? Send date & time:\n\n` +
        `Supported formats:\n` +
        `• \`YYYY-MM-DD HH:MM\`\n` +
        `• \`today 15:30\`\n` +
        `• \`tomorrow 9am\`\n` +
        `• \`DD/MM/YYYY HH:MM\``,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (step === "datetime") {
    const parsed = parseDateTime(input);
    if (!parsed) {
      await ctx.reply(
        `❌ Couldn't parse that date. Try:\n` +
          `• \`2026-06-01 14:00\`\n` +
          `• \`today 15:30\`\n` +
          `• \`tomorrow 9am\``,
        { parse_mode: "Markdown" }
      );
      ctx.session.pendingAction = "meeting:datetime";
      return;
    }
    if (parsed < new Date()) {
      await ctx.reply("❌ That time is in the past. Please choose a future date & time:");
      ctx.session.pendingAction = "meeting:datetime";
      return;
    }
    ctx.session.meetingDraft = {
      ...ctx.session.meetingDraft,
      scheduledAt: parsed.toISOString(),
    };
    ctx.session.pendingAction = "meeting:description";
    const title = ctx.session.meetingDraft.title ?? "";
    await ctx.reply(
      `📅 *NEW MEETING — Step 3/3*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `📌 Title: *${title}* ✅\n` +
        `🕐 Time: *${formatDate(parsed)}* ✅\n\n` +
        `Add a description or send \`skip\`:`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  if (step === "description") {
    const draft = ctx.session.meetingDraft ?? {};
    const description = input.trim().toLowerCase() === "skip" ? undefined : input.trim();
    const title = draft.title ?? "";
    const scheduledAt = draft.scheduledAt ? new Date(draft.scheduledAt) : null;

    if (!title || !scheduledAt) {
      ctx.session.meetingDraft = undefined;
      await ctx.reply("❌ Session expired. Please start over.", {
        reply_markup: meetingsMenuKeyboard(),
      });
      return;
    }

    ctx.session.meetingDraft = { ...draft, description };
    ctx.session.pendingAction = undefined;

    const confirmKb = new InlineKeyboard()
      .text("✅ Schedule It!", "meetings:confirm")
      .text("❌ Cancel", "meetings:main");

    await ctx.reply(
      `📅 *CONFIRM MEETING*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `📌 *${title}*\n` +
        `🕐 ${formatDate(scheduledAt)}\n` +
        (description ? `📝 ${description}` : ""),
      { parse_mode: "Markdown", reply_markup: confirmKb }
    );
    return;
  }
}

export function registerMeetingHandlers(bot: MyBot): void {
  bot.command("schedule", async (ctx) => {
    ctx.session.meetingDraft = {};
    ctx.session.pendingAction = "meeting:title";
    await ctx.reply(
      `📅 *NEW MEETING — Step 1/3*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `What's the meeting title?\n\nExample: \`Team Standup\``,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("meetings", async (ctx) => {
    await ctx.reply(
      `📅 *MEETINGS*\n━━━━━━━━━━━━━━━━━━\n\nSchedule and manage meetings.`,
      { parse_mode: "Markdown", reply_markup: meetingsMenuKeyboard() }
    );
  });
}

export function registerMeetingCallbacks(bot: MyBot): void {
  bot.callbackQuery("meetings:main", async (ctx) => {
    await ctx.editMessageText(
      `📅 *MEETINGS*\n━━━━━━━━━━━━━━━━━━\n\nSchedule and manage meetings.`,
      { parse_mode: "Markdown", reply_markup: meetingsMenuKeyboard() }
    );
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("meetings:schedule", async (ctx) => {
    ctx.session.meetingDraft = {};
    ctx.session.pendingAction = "meeting:title";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `📅 *NEW MEETING — Step 1/3*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `What's the meeting title?\n\nExample: \`Team Standup\``,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery("meetings:confirm", async (ctx) => {
    const draft = ctx.session.meetingDraft;
    const userId = ctx.from.id;
    const chatId = ctx.chat?.id ?? userId;

    if (!draft?.title || !draft.scheduledAt) {
      await ctx.answerCallbackQuery("❌ Session expired. Please start again.");
      return;
    }

    try {
      const [meeting] = await db
        .insert(meetingsTable)
        .values({
          createdBy: userId,
          chatId,
          title: draft.title,
          description: draft.description ?? null,
          scheduledAt: new Date(draft.scheduledAt),
          status: "upcoming",
        })
        .returning();

      ctx.session.meetingDraft = undefined;
      await ctx.answerCallbackQuery("✅ Meeting scheduled!");

      await ctx.editMessageText(
        `✅ *MEETING SCHEDULED!*\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          `Meeting *#${meeting.id}*\n\n` +
          `📌 ${meeting.title}\n` +
          `🕐 ${formatDate(new Date(meeting.scheduledAt))}\n` +
          (meeting.description ? `📝 ${meeting.description}\n` : "") +
          `\nStatus: ⏳ Upcoming`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("📋 My Meetings", "meetings:list")
            .text("➕ Another", "meetings:schedule")
            .row()
            .text("🏠 Main Menu", "menu:main"),
        }
      );
    } catch (err) {
      logger.error({ err }, "meetings:confirm error");
      await ctx.answerCallbackQuery("❌ Failed to save meeting.");
    }
  });

  bot.callbackQuery("meetings:list", async (ctx) => {
    const userId = ctx.from.id;
    await ctx.answerCallbackQuery();
    try {
      const meetings = await db
        .select()
        .from(meetingsTable)
        .where(eq(meetingsTable.createdBy, userId))
        .orderBy(desc(meetingsTable.scheduledAt))
        .limit(10);

      if (meetings.length === 0) {
        await ctx.editMessageText(
          `📋 *MY MEETINGS*\n━━━━━━━━━━━━━━━━━━\n\n🚫 No meetings yet.`,
          {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard()
              .text("➕ Schedule One", "meetings:schedule")
              .text("🔙 Back", "meetings:main"),
          }
        );
        return;
      }

      const lines = meetings.map((m) => {
        const d = new Date(m.scheduledAt);
        return (
          `*#${m.id}* — ${m.title}\n` +
          `🕐 ${formatDate(d)}\n` +
          `${formatStatus(m.status)}${m.description ? `\n📝 ${m.description}` : ""}`
        );
      });

      await ctx.editMessageText(
        `📋 *MY MEETINGS*\n━━━━━━━━━━━━━━━━━━\n\n${lines.join("\n\n")}`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("➕ Schedule New", "meetings:schedule")
            .text("❌ Cancel One", "meetings:cancel_pick")
            .row()
            .text("🔙 Meetings Menu", "meetings:main"),
        }
      );
    } catch (err) {
      logger.error({ err }, "meetings:list error");
      await ctx.reply("❌ Failed to fetch meetings.");
    }
  });

  bot.callbackQuery("meetings:cancel_pick", async (ctx) => {
    const userId = ctx.from.id;
    await ctx.answerCallbackQuery();
    try {
      const upcoming = await db
        .select()
        .from(meetingsTable)
        .where(
          and(
            eq(meetingsTable.createdBy, userId),
            eq(meetingsTable.status, "upcoming"),
            gte(meetingsTable.scheduledAt, new Date())
          )
        )
        .orderBy(meetingsTable.scheduledAt)
        .limit(8);

      if (upcoming.length === 0) {
        await ctx.editMessageText(
          `📅 *CANCEL MEETING*\n━━━━━━━━━━━━━━━━━━\n\n✅ No upcoming meetings to cancel.`,
          {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard().text("🔙 Back", "meetings:main"),
          }
        );
        return;
      }

      const kb = new InlineKeyboard();
      for (const m of upcoming) {
        const d = new Date(m.scheduledAt);
        const label = `#${m.id} — ${m.title} (${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })})`;
        kb.text(label, `meetings:do_cancel:${m.id}`).row();
      }
      kb.text("🔙 Back", "meetings:main");

      await ctx.editMessageText(
        `❌ *CANCEL A MEETING*\n━━━━━━━━━━━━━━━━━━\n\nSelect the meeting to cancel:`,
        { parse_mode: "Markdown", reply_markup: kb }
      );
    } catch (err) {
      logger.error({ err }, "meetings:cancel_pick error");
      await ctx.reply("❌ Failed to load meetings.");
    }
  });

  bot.callbackQuery(/^meetings:do_cancel:(\d+)$/, async (ctx) => {
    const meetingId = parseInt(ctx.match[1]!);
    const userId = ctx.from.id;
    await ctx.answerCallbackQuery();

    try {
      const [meeting] = await db
        .select()
        .from(meetingsTable)
        .where(
          and(eq(meetingsTable.id, meetingId), eq(meetingsTable.createdBy, userId))
        );

      if (!meeting) {
        await ctx.reply("❌ Meeting not found.");
        return;
      }

      await db
        .update(meetingsTable)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(meetingsTable.id, meetingId));

      await ctx.editMessageText(
        `❌ *MEETING CANCELLED*\n━━━━━━━━━━━━━━━━━━\n\n` +
          `Meeting *#${meeting.id}* — ${meeting.title}\n` +
          `🕐 ${formatDate(new Date(meeting.scheduledAt))}\n\n` +
          `Status: ❌ Cancelled`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("📋 My Meetings", "meetings:list")
            .text("🏠 Main Menu", "menu:main"),
        }
      );
    } catch (err) {
      logger.error({ err }, "meetings:do_cancel error");
      await ctx.reply("❌ Failed to cancel meeting.");
    }
  });
}
