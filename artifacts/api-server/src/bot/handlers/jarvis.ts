import { InlineKeyboard } from "grammy";
import OpenAI from "openai";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

const openai = new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] });

const SYSTEM_PROMPT = `You are Jarvis, a highly intelligent personal assistant bot running inside Telegram. 
You are helpful, concise, and efficient. You assist with:
- Answering questions and having natural conversations
- Drafting emails (respond with a ready-to-send email in clear format)
- Giving reminders and scheduling advice
- Summarising information
- Writing, research, analysis
Keep responses concise for Telegram. Use markdown for formatting when it helps readability.
If the user asks you to send an email, write it out in full and end with: [EMAIL_READY].`;

const conversationHistory: Map<number, Array<{ role: "user" | "assistant"; content: string }>> =
  new Map();

function getHistory(userId: number) {
  if (!conversationHistory.has(userId)) {
    conversationHistory.set(userId, []);
  }
  return conversationHistory.get(userId)!;
}

function trimHistory(history: Array<{ role: string; content: string }>, maxTurns = 20) {
  if (history.length > maxTurns * 2) {
    history.splice(0, history.length - maxTurns * 2);
  }
}

export async function askJarvis(userId: number, userMessage: string): Promise<string> {
  const history = getHistory(userId);
  history.push({ role: "user", content: userMessage });
  trimHistory(history);

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: 1024,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
      ],
    });

    const reply = response.choices[0]?.message?.content ?? "I couldn't generate a response.";
    history.push({ role: "assistant", content: reply });
    return reply;
  } catch (err) {
    logger.error({ err }, "OpenAI error");
    throw new Error("AI unavailable");
  }
}

export function registerJarvisHandlers(bot: MyBot): void {
  bot.command("jarvis", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Jarvis is the owner's personal assistant.");
      return;
    }
    const input = ctx.match?.trim();
    if (!input) {
      await ctx.reply(
        `🤖 *JARVIS — Personal AI Assistant*\n` +
          `━━━━━━━━━━━━━━━━━━\n\n` +
          `I'm ready. Ask me anything — or use the menu below.`,
        {
          parse_mode: "Markdown",
          reply_markup: jarvisMenuKeyboard(),
        }
      );
      return;
    }
    await handleJarvisMessage(ctx, input);
  });

  bot.command("ai", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ AI assistant is owner-only.");
      return;
    }
    const input = ctx.match?.trim();
    if (!input) {
      await ctx.reply("Usage: /ai [your question]");
      return;
    }
    await handleJarvisMessage(ctx, input);
  });

  bot.command("clearai", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    conversationHistory.delete(ctx.from.id);
    await ctx.reply("🧹 Conversation history cleared.");
  });
}

export async function handleJarvisMessage(ctx: BotContext, input: string): Promise<void> {
  const userId = ctx.from!.id;
  const thinking = await ctx.reply("🤔 _Thinking..._", { parse_mode: "Markdown" });

  try {
    const reply = await askJarvis(userId, input);

    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});

    const chunks = splitMessage(reply);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await ctx.reply(
        (i === 0 ? `🤖 *Jarvis*\n━━━━━━━━━━━━━━━━━━\n\n` : "") + chunks[i],
        {
          parse_mode: "Markdown",
          reply_markup: isLast
            ? new InlineKeyboard()
                .text("🧹 Clear Chat", "jarvis:clear")
                .text("🏠 Menu", "menu:main")
            : undefined,
        }
      );
    }
  } catch {
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply("❌ Jarvis is unavailable right now. Check your OpenAI API key.");
  }
}

export function jarvisMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💬 Chat", "jarvis:chat")
    .text("📧 Draft Email", "jarvis:email")
    .row()
    .text("📅 Daily Digest", "jarvis:digest")
    .text("⏰ Reminders", "jarvis:reminders")
    .row()
    .text("🧹 Clear History", "jarvis:clear")
    .text("🏠 Main Menu", "menu:main");
}

export function registerJarvisCallbacks(bot: MyBot): void {
  bot.callbackQuery("menu:jarvis", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    await ctx.editMessageText(
      `🤖 *JARVIS — Personal AI Assistant*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `How can I assist you today?`,
      { parse_mode: "Markdown", reply_markup: jarvisMenuKeyboard() }
    );
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("jarvis:chat", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    ctx.session.pendingAction = "jarvis:input";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `💬 *Chat with Jarvis*\n━━━━━━━━━━━━━━━━━━\n\nType your message and I'll respond.`,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery("jarvis:email", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    ctx.session.pendingAction = "jarvis:input";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `📧 *Draft an Email*\n━━━━━━━━━━━━━━━━━━\n\nTell me what you need to say.\n\nExample:\n_"Write an email to my client postponing tomorrow's call to next week"_`,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery("jarvis:digest", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    await ctx.answerCallbackQuery();
    await sendDailyDigest(ctx.from.id, bot);
  });

  bot.callbackQuery("jarvis:reminders", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    await ctx.answerCallbackQuery();
    await showReminders(ctx);
  });

  bot.callbackQuery("jarvis:clear", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery();
      return;
    }
    conversationHistory.delete(ctx.from.id);
    await ctx.answerCallbackQuery("🧹 History cleared");
    await ctx.editMessageText(
      `🤖 *JARVIS*\n━━━━━━━━━━━━━━━━━━\n\n🧹 Chat history cleared. Fresh start!`,
      { parse_mode: "Markdown", reply_markup: jarvisMenuKeyboard() }
    );
  });
}

async function showReminders(ctx: BotContext): Promise<void> {
  const reminders = getReminderList();
  if (reminders.length === 0) {
    await ctx.reply(
      `⏰ *REMINDERS*\n━━━━━━━━━━━━━━━━━━\n\nNo active reminders.\n\nSet one with:\n/remind 30m Check emails\n/remind 2h Team call\n/remind 1d Review report`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🤖 Back to Jarvis", "menu:jarvis"),
      }
    );
    return;
  }

  const list = reminders
    .map((r, i) => `${i + 1}. ⏰ ${r.label}\n   🕐 ${formatReminderTime(r.fireAt)}`)
    .join("\n\n");

  await ctx.reply(`⏰ *ACTIVE REMINDERS*\n━━━━━━━━━━━━━━━━━━\n\n${list}`, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard()
      .text("🗑️ Clear All", "reminders:clear_all")
      .text("🤖 Jarvis", "menu:jarvis"),
  });
}

function formatReminderTime(d: Date): string {
  return d.toLocaleString("en-US", {
    weekday: "short", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

function splitMessage(text: string, maxLen = 4000): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const cut = remaining.lastIndexOf("\n", maxLen) > 0
      ? remaining.lastIndexOf("\n", maxLen)
      : maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── In-memory reminder store ──────────────────────────────────────────────────
interface Reminder {
  id: string;
  userId: number;
  label: string;
  fireAt: Date;
  timer: ReturnType<typeof setTimeout>;
}

const reminders: Map<string, Reminder> = new Map();

function getReminderList(): Reminder[] {
  return Array.from(reminders.values()).sort(
    (a, b) => a.fireAt.getTime() - b.fireAt.getTime()
  );
}

export function scheduleReminder(
  bot: MyBot,
  userId: number,
  label: string,
  fireAt: Date
): string {
  const id = `${userId}-${Date.now()}`;
  const delay = fireAt.getTime() - Date.now();
  if (delay <= 0) return "";

  const timer = setTimeout(async () => {
    reminders.delete(id);
    await bot.api
      .sendMessage(
        userId,
        `⏰ *REMINDER*\n━━━━━━━━━━━━━━━━━━\n\n${label}`,
        { parse_mode: "Markdown" }
      )
      .catch(() => {});
  }, delay);

  reminders.set(id, { id, userId, label, fireAt, timer });
  return id;
}

export function clearAllReminders(userId: number): number {
  let count = 0;
  for (const [id, r] of reminders) {
    if (r.userId === userId) {
      clearTimeout(r.timer);
      reminders.delete(id);
      count++;
    }
  }
  return count;
}

// ── Daily digest ─────────────────────────────────────────────────────────────
export async function sendDailyDigest(userId: number, bot: MyBot): Promise<void> {
  try {
    const upcoming = await getUpcomingMeetingsForDigest(userId);
    const activeReminders = Array.from(reminders.values())
      .filter((r) => r.userId === userId)
      .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());

    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", year: "numeric",
    });

    let digest =
      `🌅 *GOOD MORNING — DAILY DIGEST*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📅 ${dateStr}\n\n`;

    if (upcoming.length > 0) {
      digest += `📋 *TODAY'S MEETINGS (${upcoming.length})*\n`;
      for (const m of upcoming) {
        const t = new Date(m.scheduledAt).toLocaleTimeString("en-US", {
          hour: "2-digit", minute: "2-digit", hour12: true,
        });
        digest += `• ${t} — ${m.title}\n`;
        if (m.description) digest += `  📝 ${m.description}\n`;
      }
      digest += "\n";
    } else {
      digest += `📋 *Meetings:* No meetings today ✅\n\n`;
    }

    if (activeReminders.length > 0) {
      digest += `⏰ *ACTIVE REMINDERS (${activeReminders.length})*\n`;
      for (const r of activeReminders.slice(0, 5)) {
        digest += `• ${r.label} — ${formatReminderTime(r.fireAt)}\n`;
      }
      digest += "\n";
    }

    digest += `_Have a productive day! Type /jarvis to chat with me._`;

    await bot.api.sendMessage(userId, digest, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("💬 Chat with Jarvis", "jarvis:chat")
        .text("📅 Meetings", "menu:meetings"),
    });
  } catch (err) {
    logger.error({ err }, "sendDailyDigest error");
  }
}

async function getUpcomingMeetingsForDigest(userId: number) {
  try {
    const { db } = await import("@workspace/db");
    const { meetingsTable } = await import("@workspace/db");
    const { eq, and, gte, lte } = await import("drizzle-orm");

    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date();
    end.setHours(23, 59, 59, 999);

    return db
      .select()
      .from(meetingsTable)
      .where(
        and(
          eq(meetingsTable.createdBy, userId),
          eq(meetingsTable.status, "upcoming"),
          gte(meetingsTable.scheduledAt, start),
          lte(meetingsTable.scheduledAt, end)
        )
      )
      .orderBy(meetingsTable.scheduledAt);
  } catch {
    return [];
  }
}
