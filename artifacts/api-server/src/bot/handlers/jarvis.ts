import { InlineKeyboard } from "grammy";
import { eq, desc, and, gte, lte } from "drizzle-orm";
import { db, productsTable, ordersTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

// ── OpenRouter config ─────────────────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const MODEL = "mistralai/mistral-7b-instruct"; // fast, free-tier friendly on OpenRouter

// ── Product context builder ───────────────────────────────────────────────────

async function buildProductContext(): Promise<string> {
  try {
    const products = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.isActive, true))
      .limit(30);

    if (products.length === 0) return "No products are currently listed in the shop.";

    const lines = products.map((p) =>
      `- ${p.name} | Price: $${p.price} | Stock: ${p.stock} | Category: ${p.category}${p.description ? ` | ${p.description}` : ""}`
    );
    return `Current active products in the shop:\n${lines.join("\n")}`;
  } catch (err) {
    logger.error({ err }, "Failed to fetch products for Jarvis context");
    return "Product data temporarily unavailable.";
  }
}

async function buildOrderContext(): Promise<string> {
  try {
    const recent = await db
      .select()
      .from(ordersTable)
      .orderBy(desc(ordersTable.createdAt))
      .limit(10);

    if (recent.length === 0) return "No recent orders.";

    const lines = recent.map((o) =>
      `- Order #${o.id} | Product ID: ${o.productId} | Qty: ${o.quantity} | Status: ${o.status} | Date: ${o.createdAt.toDateString()}`
    );
    return `Recent orders (last 10):\n${lines.join("\n")}`;
  } catch (err) {
    logger.error({ err }, "Failed to fetch orders for Jarvis context");
    return "Order data temporarily unavailable.";
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

async function buildSystemPrompt(): Promise<string> {
  const productCtx = await buildProductContext();
  const orderCtx = await buildOrderContext();

  return `You are Jarvis, a sharp and intelligent personal AI assistant embedded inside a Telegram bot called Bot-Command-Central. You serve the bot owner only.

You have two roles:
1. SHOP ASSISTANT — You know the bot's products and orders and can answer questions about them, help analyze sales, suggest pricing, or answer customer-related queries.
2. GENERAL AI — You can have natural conversations, draft emails, answer questions, help with analysis, writing, research, and anything the owner needs.

LIVE SHOP DATA (use this when asked about products or orders):
${productCtx}

${orderCtx}

RULES:
- Keep responses concise and clear for Telegram (mobile screen)
- Use markdown formatting (* for bold, _ for italic) where helpful
- If asked to draft an email, write it in full and end with [EMAIL_READY]
- If you don't know something, say so honestly
- Never make up product prices or stock levels — use only the data above
- For general questions not related to the shop, answer normally as a helpful AI

Today's date: ${new Date().toDateString()}`;
}

// ── OpenRouter API call ───────────────────────────────────────────────────────

async function callOpenRouter(
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>
): Promise<string> {
  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://bot-command-central-1.onrender.com",
      "X-Title": "Bot-Command-Central Jarvis",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    logger.error({ status: res.status, errText }, "OpenRouter API error");
    throw new Error(`OpenRouter error ${res.status}: ${errText}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message: string };
  };

  if (data.error) throw new Error(data.error.message);
  return data.choices?.[0]?.message?.content ?? "I couldn't generate a response.";
}

// ── Conversation history ──────────────────────────────────────────────────────

const conversationHistory: Map<number, Array<{ role: "user" | "assistant"; content: string }>> = new Map();

function getHistory(userId: number) {
  if (!conversationHistory.has(userId)) conversationHistory.set(userId, []);
  return conversationHistory.get(userId)!;
}

function trimHistory(history: Array<{ role: string; content: string }>, maxTurns = 15) {
  if (history.length > maxTurns * 2) history.splice(0, history.length - maxTurns * 2);
}

// ── Core ask function ─────────────────────────────────────────────────────────

export async function askJarvis(userId: number, userMessage: string): Promise<string> {
  const history = getHistory(userId);
  history.push({ role: "user", content: userMessage });
  trimHistory(history);

  const systemPrompt = await buildSystemPrompt();

  const reply = await callOpenRouter([
    { role: "system", content: systemPrompt },
    ...history,
  ]);

  history.push({ role: "assistant", content: reply });
  return reply;
}

// ── Message splitting ─────────────────────────────────────────────────────────

function splitMessage(text: string, maxLen = 4000): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const cut = remaining.lastIndexOf("\n", maxLen) > 0 ? remaining.lastIndexOf("\n", maxLen) : maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

export function jarvisMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💬 Chat", "jarvis:chat")
    .text("🛍️ Products Q&A", "jarvis:products")
    .row()
    .text("📦 Order Summary", "jarvis:orders")
    .text("📧 Draft Email", "jarvis:email")
    .row()
    .text("📅 Daily Digest", "jarvis:digest")
    .text("⏰ Reminders", "jarvis:reminders")
    .row()
    .text("🧹 Clear History", "jarvis:clear")
    .text("🏠 Main Menu", "menu:main");
}

// ── Handle a Jarvis message ───────────────────────────────────────────────────

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
                .text("🤖 Jarvis Menu", "menu:jarvis")
            : undefined,
        }
      );
    }
  } catch (err) {
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    const msg = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "Jarvis response error");
    await ctx.reply(`❌ Jarvis error: ${msg}\n\nCheck that OPENROUTER_API_KEY is set on Render.`);
  }
}

// ── Register handlers ─────────────────────────────────────────────────────────

export function registerJarvisHandlers(bot: MyBot): void {
  bot.command("jarvis", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Jarvis is the owner's personal assistant.");
      return;
    }
    const input = ctx.match?.trim();
    if (!input) {
      await ctx.reply(
        `🤖 *JARVIS — AI Assistant*\n━━━━━━━━━━━━━━━━━━\n\nPowered by OpenRouter. I know your shop products and orders in real time.\n\nAsk me anything or use the menu below.`,
        { parse_mode: "Markdown", reply_markup: jarvisMenuKeyboard() }
      );
      return;
    }
    await handleJarvisMessage(ctx, input);
  });

  bot.command("ai", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.reply("⛔ Owner-only."); return; }
    const input = ctx.match?.trim();
    if (!input) { await ctx.reply("Usage: /ai [your question]"); return; }
    await handleJarvisMessage(ctx, input);
  });

  bot.command("clearai", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    conversationHistory.delete(ctx.from.id);
    await ctx.reply("🧹 Conversation history cleared.");
  });
}

export function registerJarvisCallbacks(bot: MyBot): void {
  bot.callbackQuery("menu:jarvis", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `🤖 *JARVIS — AI Assistant*\n━━━━━━━━━━━━━━━━━━\n\nPowered by OpenRouter. I know your shop products and orders in real time.\n\nAsk me anything or use the menu below.`,
      { parse_mode: "Markdown", reply_markup: jarvisMenuKeyboard() }
    );
  });

  bot.callbackQuery("jarvis:chat", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    ctx.session.pendingAction = "jarvis:input";
    await ctx.answerCallbackQuery();
    await ctx.reply(`💬 *Chat with Jarvis*\n━━━━━━━━━━━━━━━━━━\n\nType your message and I'll respond. I remember context across this session.`, { parse_mode: "Markdown" });
  });

  bot.callbackQuery("jarvis:products", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    ctx.session.pendingAction = "jarvis:input";
    await ctx.answerCallbackQuery();
    await ctx.reply(`🛍️ *Products Q&A*\n━━━━━━━━━━━━━━━━━━\n\nAsk me anything about your products.\n\nExamples:\n• _"Which products are low on stock?"_\n• _"What's our most expensive item?"_\n• _"Suggest a discount for category X"_`, { parse_mode: "Markdown" });
  });

  bot.callbackQuery("jarvis:orders", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery("📦 Fetching order summary...");
    try {
      const reply = await askJarvis(ctx.from.id, "Give me a brief summary of recent orders — how many, what statuses, any patterns or issues?");
      const chunks = splitMessage(reply);
      for (let i = 0; i < chunks.length; i++) {
        await ctx.reply(
          (i === 0 ? `📦 *Order Summary*\n━━━━━━━━━━━━━━━━━━\n\n` : "") + chunks[i],
          {
            parse_mode: "Markdown",
            reply_markup: i === chunks.length - 1
              ? new InlineKeyboard().text("🤖 Jarvis Menu", "menu:jarvis")
              : undefined,
          }
        );
      }
    } catch (err) {
      await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  });

  bot.callbackQuery("jarvis:email", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    ctx.session.pendingAction = "jarvis:input";
    await ctx.answerCallbackQuery();
    await ctx.reply(`📧 *Draft an Email*\n━━━━━━━━━━━━━━━━━━\n\nDescribe what you need to say and I'll write a full email.\n\nExample:\n_"Write an email to a customer apologizing for a delayed order #42"_`, { parse_mode: "Markdown" });
  });

  bot.callbackQuery("jarvis:digest", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery();
    await sendDailyDigest(ctx.from.id, bot);
  });

  bot.callbackQuery("jarvis:reminders", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery();
    await showReminders(ctx);
  });

  bot.callbackQuery("jarvis:clear", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery(); return; }
    conversationHistory.delete(ctx.from.id);
    await ctx.answerCallbackQuery("🧹 History cleared");
    await ctx.editMessageText(
      `🤖 *JARVIS*\n━━━━━━━━━━━━━━━━━━\n\n🧹 Chat history cleared. Fresh start!`,
      { parse_mode: "Markdown", reply_markup: jarvisMenuKeyboard() }
    );
  });
}

// ── Reminders ─────────────────────────────────────────────────────────────────

interface Reminder {
  id: string; userId: number; label: string; fireAt: Date; timer: ReturnType<typeof setTimeout>;
}

const reminders: Map<string, Reminder> = new Map();

function getReminderList(): Reminder[] {
  return Array.from(reminders.values()).sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
}

function formatReminderTime(d: Date): string {
  return d.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
}

async function showReminders(ctx: BotContext): Promise<void> {
  const list = getReminderList();
  if (list.length === 0) {
    await ctx.reply(`⏰ *REMINDERS*\n━━━━━━━━━━━━━━━━━━\n\nNo active reminders.\n\nSet one with:\n/remind 30m Check emails\n/remind 2h Team call`, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🤖 Back to Jarvis", "menu:jarvis") });
    return;
  }
  const lines = list.map((r, i) => `${i + 1}. ⏰ ${r.label}\n   🕐 ${formatReminderTime(r.fireAt)}`).join("\n\n");
  await ctx.reply(`⏰ *ACTIVE REMINDERS*\n━━━━━━━━━━━━━━━━━━\n\n${lines}`, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🗑️ Clear All", "reminders:clear_all").text("🤖 Jarvis", "menu:jarvis") });
}

export function scheduleReminder(bot: MyBot, userId: number, label: string, fireAt: Date): string {
  const id = `${userId}-${Date.now()}`;
  const delay = fireAt.getTime() - Date.now();
  if (delay <= 0) return "";
  const timer = setTimeout(async () => {
    reminders.delete(id);
    await bot.api.sendMessage(userId, `⏰ *REMINDER*\n━━━━━━━━━━━━━━━━━━\n\n${label}`, { parse_mode: "Markdown" }).catch(() => {});
  }, delay);
  reminders.set(id, { id, userId, label, fireAt, timer });
  return id;
}

export function clearAllReminders(userId: number): number {
  let count = 0;
  for (const [id, r] of reminders) {
    if (r.userId === userId) { clearTimeout(r.timer); reminders.delete(id); count++; }
  }
  return count;
}

// ── Daily digest ──────────────────────────────────────────────────────────────

export async function sendDailyDigest(userId: number, bot: MyBot): Promise<void> {
  try {
    const upcoming = await getUpcomingMeetingsForDigest(userId);
    const activeReminders = Array.from(reminders.values()).filter((r) => r.userId === userId).sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
    const now = new Date();
    const dateStr = now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });

    let digest = `🌅 *GOOD MORNING — DAILY DIGEST*\n━━━━━━━━━━━━━━━━━━━━━━\n📅 ${dateStr}\n\n`;

    if (upcoming.length > 0) {
      digest += `📋 *TODAY'S MEETINGS (${upcoming.length})*\n`;
      for (const m of upcoming) {
        const t = new Date(m.scheduledAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
        digest += `• ${t} — ${m.title}\n`;
        if (m.description) digest += `  📝 ${m.description}\n`;
      }
      digest += "\n";
    } else {
      digest += `📋 *Meetings:* No meetings today ✅\n\n`;
    }

    if (activeReminders.length > 0) {
      digest += `⏰ *ACTIVE REMINDERS (${activeReminders.length})*\n`;
      for (const r of activeReminders.slice(0, 5)) digest += `• ${r.label} — ${formatReminderTime(r.fireAt)}\n`;
      digest += "\n";
    }

    // Quick shop snapshot
    try {
      const products = await db.select().from(productsTable).where(eq(productsTable.isActive, true));
      const lowStock = products.filter((p) => Number(p.stock) > 0 && Number(p.stock) <= 5);
      digest += `🛍️ *SHOP SNAPSHOT*\n• Active products: ${products.length}\n`;
      if (lowStock.length > 0) digest += `• ⚠️ Low stock: ${lowStock.map((p) => p.name).join(", ")}\n`;
      digest += "\n";
    } catch { /* skip if DB unavailable */ }

    digest += `_Have a productive day! Type /jarvis to chat with me._`;

    await bot.api.sendMessage(userId, digest, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("💬 Chat with Jarvis", "jarvis:chat").text("📅 Meetings", "menu:meetings") });
  } catch (err) {
    logger.error({ err }, "sendDailyDigest error");
  }
}

async function getUpcomingMeetingsForDigest(userId: number) {
  try {
    const { meetingsTable } = await import("@workspace/db");
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    return db.select().from(meetingsTable).where(
      and(eq(meetingsTable.createdBy, userId), eq(meetingsTable.status, "upcoming"), gte(meetingsTable.scheduledAt, start), lte(meetingsTable.scheduledAt, end))
    ).orderBy(meetingsTable.scheduledAt);
  } catch { return []; }
}
