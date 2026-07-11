/**
 * HEXAGON — AI Agent for Bot-Command-Central
 * ─────────────────────────────────────────────
 * • Free model fallback loop (5 models)
 * • Daily quota: 50 queries/day (resets midnight Nairobi)
 * • Group analyst: reads group messages, summarises user behaviour
 * • Agent mode: performs live tasks (broadcast, ban, product ops, etc.)
 * • Shop-aware: live product + order context injected into every prompt
 */

import { InlineKeyboard } from "grammy";
import { eq, desc, gte, and, sql } from "drizzle-orm";
import { db, productsTable, ordersTable, usersTable, groupMessagesTable, groupSettingsTable, warningsTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

// ── OpenRouter ────────────────────────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// Priority fallback list — tries each in order on 429/503
const FREE_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-r1:free",
  "qwen/qwen3-8b:free",
  "google/gemma-3-12b-it:free",
  "mistralai/devstral-small:free",
];

// ── Daily quota ───────────────────────────────────────────────────────────────

const DAILY_LIMIT = 50;
const usageMap = new Map<number, { count: number; date: string }>();

function todayStr(): string {
  return new Date().toLocaleDateString("en-KE", { timeZone: "Africa/Nairobi" });
}

function checkAndIncrementQuota(userId: number): { allowed: boolean; used: number; limit: number } {
  const today = todayStr();
  const entry = usageMap.get(userId);
  if (!entry || entry.date !== today) {
    usageMap.set(userId, { count: 1, date: today });
    return { allowed: true, used: 1, limit: DAILY_LIMIT };
  }
  if (entry.count >= DAILY_LIMIT) return { allowed: false, used: entry.count, limit: DAILY_LIMIT };
  entry.count++;
  return { allowed: true, used: entry.count, limit: DAILY_LIMIT };
}

function getQuotaStatus(userId: number): { used: number; limit: number; remaining: number } {
  const today = todayStr();
  const entry = usageMap.get(userId);
  if (!entry || entry.date !== today) return { used: 0, limit: DAILY_LIMIT, remaining: DAILY_LIMIT };
  return { used: entry.count, limit: DAILY_LIMIT, remaining: DAILY_LIMIT - entry.count };
}

// ── Context builders ──────────────────────────────────────────────────────────

async function buildShopContext(): Promise<string> {
  try {
    const [products, orders] = await Promise.all([
      db.select().from(productsTable).where(eq(productsTable.isActive, true)).limit(30),
      db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(10),
    ]);
    const productLines = products.length === 0
      ? "No active products."
      : products.map((p) => `• ${p.name} | $${p.price} | Stock: ${p.stock} | Category: ${p.category}`).join("\n");
    const orderLines = orders.length === 0
      ? "No recent orders."
      : orders.map((o) => `• Order #${o.id} | Product:${o.productId} | Qty:${o.quantity} | Status:${o.status}`).join("\n");
    return `LIVE SHOP DATA:\n${productLines}\n\nRECENT ORDERS:\n${orderLines}`;
  } catch {
    return "Shop data unavailable.";
  }
}

async function buildGroupContext(chatId: number): Promise<string> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const messages = await db
      .select()
      .from(groupMessagesTable)
      .where(and(eq(groupMessagesTable.chatId, chatId), gte(groupMessagesTable.createdAt, since)))
      .orderBy(desc(groupMessagesTable.createdAt))
      .limit(200);
    if (messages.length === 0) return "No recent group messages recorded.";

    // Group by user
    const byUser = new Map<number, { name: string; count: number; samples: string[] }>();
    for (const m of messages) {
      const entry = byUser.get(m.userId) ?? { name: m.firstName ?? m.username ?? String(m.userId), count: 0, samples: [] };
      entry.count++;
      if (entry.samples.length < 3) entry.samples.push(m.message.slice(0, 80));
      byUser.set(m.userId, entry);
    }

    const lines = Array.from(byUser.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([, v]) => `• ${v.name} (${v.count} msgs): "${v.samples.join('" | "')}"`)
      .join("\n");

    return `LAST 24H GROUP ACTIVITY (${messages.length} messages, ${byUser.size} users):\n${lines}`;
  } catch {
    return "Group data unavailable.";
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

async function buildSystemPrompt(ctx?: BotContext): Promise<string> {
  const shopCtx = await buildShopContext();
  const groupCtx = ctx?.chat?.type !== "private" && ctx?.chat?.id
    ? await buildGroupContext(ctx.chat.id)
    : "";

  return `You are HEXAGON, an elite AI agent embedded in a private Telegram bot called Bot-Command-Central.

PERSONALITY: Sharp, direct, intelligent, slightly futuristic. No fluff. You are a high-performance assistant.

YOUR CAPABILITIES:
1. GENERAL AI — Answer anything: research, writing, analysis, coding, math, advice.
2. SHOP AGENT — Full awareness of the bot's product catalog and order history.
3. GROUP ANALYST — You can analyse group conversations and report on user behaviour.
4. TASK AGENT — You can instruct the bot to perform actions. When the user asks you to do something actionable (ban a user, broadcast a message, add a product), respond with a JSON action block at the END of your reply:
   \`\`\`action
   {"type":"broadcast","payload":{"message":"..."}}
   \`\`\`
   Supported action types: broadcast, ban_user, add_product, remove_product, send_dm

${shopCtx}
${groupCtx ? `\n${groupCtx}` : ""}

FORMAT RULES:
- Keep replies concise for Telegram mobile (max ~300 words unless asked for more)
- Use *bold* and _italic_ markdown
- For code, wrap in \`backticks\`
- Never make up product prices, stock, or order data — only use the live data above
- Today: ${new Date().toLocaleDateString("en-KE", { timeZone: "Africa/Nairobi", weekday: "long", year: "numeric", month: "long", day: "numeric" })}`;
}

// ── OpenRouter call with fallback ─────────────────────────────────────────────

async function callOpenRouter(
  messages: Array<{ role: "user" | "assistant" | "system"; content: string }>
): Promise<{ reply: string; model: string }> {
  if (!OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY not set on Render.");

  let lastError = "";
  for (const model of FREE_MODELS) {
    try {
      const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://bot-command-central-1.onrender.com",
          "X-Title": "Hexagon-AI",
        },
        body: JSON.stringify({ model, max_tokens: 1024, messages }),
      });

      if (res.status === 429 || res.status === 503) {
        lastError = `${model}: rate-limited`;
        logger.warn({ model }, "Rate-limited, trying next model...");
        continue;
      }
      if (!res.ok) {
        const t = await res.text();
        lastError = `${model}: HTTP ${res.status}`;
        logger.warn({ model, status: res.status, t }, "Model error");
        continue;
      }

      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message: string } };
      if (data.error) { lastError = data.error.message; continue; }

      const reply = data.choices?.[0]?.message?.content?.trim() ?? "";
      if (!reply) { lastError = "Empty response"; continue; }

      logger.info({ model }, "Hexagon responded");
      return { reply, model };
    } catch (err) {
      lastError = err instanceof Error ? err.message : "fetch error";
      logger.warn({ model }, "Model fetch failed");
    }
  }
  throw new Error(`All models failed. Last: ${lastError}`);
}

// ── Agent action parser & executor ────────────────────────────────────────────

interface AgentAction {
  type: "broadcast" | "ban_user" | "add_product" | "remove_product" | "send_dm";
  payload: Record<string, unknown>;
}

function extractAction(reply: string): { clean: string; action: AgentAction | null } {
  const match = reply.match(/```action\s*([\s\S]*?)```/);
  if (!match) return { clean: reply, action: null };
  const clean = reply.replace(/```action[\s\S]*?```/, "").trim();
  try {
    return { clean, action: JSON.parse(match[1].trim()) as AgentAction };
  } catch {
    return { clean, action: null };
  }
}

async function executeAction(bot: MyBot, ownerId: number, action: AgentAction): Promise<string> {
  try {
    switch (action.type) {
      case "broadcast": {
        const msg = String(action.payload["message"] ?? "");
        if (!msg) return "⚠️ Broadcast failed: no message.";
        const users = await db.select().from(usersTable).limit(500);
        let sent = 0;
        for (const u of users) {
          try { await bot.api.sendMessage(u.id, `📢 *BROADCAST*\n\n${msg}`, { parse_mode: "Markdown" }); sent++; } catch { /* skip */ }
          await new Promise((r) => setTimeout(r, 50));
        }
        return `✅ Broadcast sent to ${sent} users.`;
      }
      case "send_dm": {
        const userId = Number(action.payload["userId"]);
        const msg = String(action.payload["message"] ?? "");
        if (!userId || !msg) return "⚠️ DM failed: missing userId or message.";
        await bot.api.sendMessage(userId, msg, { parse_mode: "Markdown" });
        return `✅ DM sent to user ${userId}.`;
      }
      case "add_product": {
        const name = String(action.payload["name"] ?? "");
        const price = String(action.payload["price"] ?? "0");
        const stock = Number(action.payload["stock"] ?? 0);
        const category = String(action.payload["category"] ?? "general");
        if (!name) return "⚠️ Product add failed: name required.";
        await db.insert(productsTable).values({ name, price, stock, category, isActive: true });
        return `✅ Product "${name}" added to shop.`;
      }
      default:
        return `⚠️ Unknown action type: ${action.type}`;
    }
  } catch (err) {
    return `❌ Action failed: ${err instanceof Error ? err.message : "unknown"}`;
  }
}

// ── Conversation history ──────────────────────────────────────────────────────

const history = new Map<number, Array<{ role: "user" | "assistant"; content: string }>>();

function getHistory(id: number) {
  if (!history.has(id)) history.set(id, []);
  return history.get(id)!;
}

function trimHistory(h: Array<unknown>, max = 20) {
  if (h.length > max) h.splice(0, h.length - max);
}

// ── Core ask ──────────────────────────────────────────────────────────────────

async function askHexagon(
  userId: number,
  userMessage: string,
  ctx?: BotContext
): Promise<{ reply: string; model: string; actionResult?: string }> {
  const h = getHistory(userId);
  h.push({ role: "user", content: userMessage });
  trimHistory(h);

  const system = await buildSystemPrompt(ctx);
  const { reply, model } = await callOpenRouter([{ role: "system", content: system }, ...h]);

  const { clean, action } = extractAction(reply);
  h.push({ role: "assistant", content: clean });

  let actionResult: string | undefined;
  if (action && ctx) {
    const bot = (ctx as BotContext & { bot?: MyBot }).bot;
    if (bot) actionResult = await executeAction(bot, userId, action);
  }

  return { reply: clean, model, actionResult };
}

// ── Message split ─────────────────────────────────────────────────────────────

function split(text: string, max = 3900): string[] {
  const chunks: string[] = [];
  let rem = text;
  while (rem.length > max) {
    const cut = rem.lastIndexOf("\n", max) > 0 ? rem.lastIndexOf("\n", max) : max;
    chunks.push(rem.slice(0, cut));
    rem = rem.slice(cut).trimStart();
  }
  if (rem) chunks.push(rem);
  return chunks;
}

// ── Keyboards ─────────────────────────────────────────────────────────────────

function hexagonMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💬 Chat", "hexagon:chat")
    .text("🛍️ Shop Q&A", "hexagon:shop")
    .row()
    .text("🕵️ Group Analyst", "hexagon:analyst")
    .text("⚡ Agent Mode", "hexagon:agent")
    .row()
    .text("📊 Usage", "hexagon:usage")
    .text("🧹 Clear", "hexagon:clear")
    .row()
    .text("🏠 Main Menu", "menu:main");
}

// ── Public handler ────────────────────────────────────────────────────────────

export async function handleHexagonMessage(ctx: BotContext, input: string): Promise<void> {
  const userId = ctx.from!.id;
  const quota = checkAndIncrementQuota(userId);

  if (!quota.allowed) {
    await ctx.reply(
      `⛔ *Daily limit reached*\n━━━━━━━━━━━━━━━━━━\n\nYou've used ${quota.used}/${quota.limit} queries today.\n\n_Resets at midnight Nairobi time._`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🤖 Hexagon", "menu:hexagon") }
    );
    return;
  }

  const thinking = await ctx.reply(`🧠 _Hexagon thinking... (${quota.used}/${quota.limit})_`, { parse_mode: "Markdown" });

  try {
    const { reply, model, actionResult } = await askHexagon(userId, input, ctx);
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});

    const chunks = split(reply);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      await ctx.reply(
        (i === 0 ? `🤖 *HEXAGON*\n━━━━━━━━━━━━━━━━━━\n\n` : "") + chunks[i],
        {
          parse_mode: "Markdown",
          reply_markup: isLast
            ? new InlineKeyboard().text("💬 Continue", "hexagon:chat").text("🤖 Menu", "menu:hexagon")
            : undefined,
        }
      );
    }

    if (actionResult) {
      await ctx.reply(`⚡ *Agent Result*\n━━━━━━━━━━━━━━━━━━\n\n${actionResult}`, { parse_mode: "Markdown" });
    }

    // Footer: model used + remaining quota
    await ctx.reply(
      `_Model: ${model.split("/")[1]?.split(":")[0] ?? model} · ${quota.remaining - 1} queries left today_`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(`❌ *Hexagon error*\n\n${err instanceof Error ? err.message : "Unknown error"}`, { parse_mode: "Markdown" });
  }
}

// ── Group message logger (call from bot message handler) ──────────────────────

export async function logGroupMessage(ctx: BotContext): Promise<void> {
  if (!ctx.message?.text || !ctx.from || ctx.chat?.type === "private") return;
  try {
    await db.insert(groupMessagesTable).values({
      chatId: ctx.chat!.id,
      userId: ctx.from.id,
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
      message: ctx.message.text.slice(0, 500),
    });
  } catch { /* non-critical */ }
}

// ── Group analyst ─────────────────────────────────────────────────────────────

async function runGroupAnalysis(ctx: BotContext, bot: MyBot): Promise<void> {
  const chatId = ctx.chat!.id;
  const thinking = await ctx.reply("🔍 _Analysing group activity..._", { parse_mode: "Markdown" });

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const messages = await db
      .select()
      .from(groupMessagesTable)
      .where(and(eq(groupMessagesTable.chatId, chatId), gte(groupMessagesTable.createdAt, since)))
      .orderBy(groupMessagesTable.createdAt)
      .limit(300);

    if (messages.length < 5) {
      await ctx.api.deleteMessage(chatId, thinking.message_id).catch(() => {});
      await ctx.reply("📊 Not enough group messages recorded yet.\n\n_I need at least 5 messages from the group to analyse. I log messages automatically once added to a group._", { parse_mode: "Markdown" });
      return;
    }

    // Build analysis prompt
    const transcript = messages
      .map((m) => `[${m.firstName ?? m.username ?? m.userId}]: ${m.message}`)
      .join("\n");

    const { reply } = await callOpenRouter([
      {
        role: "system",
        content: `You are HEXAGON, an expert group behaviour analyst. Analyse the following Telegram group conversation from the last 24 hours. Provide:
1. ACTIVITY SUMMARY — total messages, active users, peak times
2. USER PROFILES — brief behaviour profile for each active user (tone, topics, activity level)
3. SENTIMENT — overall group mood
4. RED FLAGS — any suspicious, spammy, or toxic patterns
5. RECOMMENDATIONS — what the admin should do

Be concise, sharp, and insightful. Use bullet points. Today: ${new Date().toDateString()}`
      },
      { role: "user", content: `Analyse this conversation:\n\n${transcript.slice(0, 8000)}` }
    ]);

    await ctx.api.deleteMessage(chatId, thinking.message_id).catch(() => {});

    const chunks = split(`📊 *GROUP ANALYSIS REPORT*\n━━━━━━━━━━━━━━━━━━\n_Last 24 hours · ${messages.length} messages · ${new Set(messages.map((m) => m.userId)).size} users_\n\n${reply}`);
    for (const chunk of chunks) {
      await ctx.reply(chunk, { parse_mode: "Markdown" });
    }
  } catch (err) {
    await ctx.api.deleteMessage(chatId, thinking.message_id).catch(() => {});
    await ctx.reply(`❌ Analysis failed: ${err instanceof Error ? err.message : "Unknown"}`);
  }
}

// ── Daily group digest (called by cron) ──────────────────────────────────────

export async function sendDailyGroupDigest(bot: MyBot, chatId: number, ownerId: number): Promise<void> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const messages = await db
      .select()
      .from(groupMessagesTable)
      .where(and(eq(groupMessagesTable.chatId, chatId), gte(groupMessagesTable.createdAt, since)))
      .limit(300);

    if (messages.length < 3) return;

    const byUser = new Map<number, { name: string; count: number }>();
    for (const m of messages) {
      const e = byUser.get(m.userId) ?? { name: m.firstName ?? m.username ?? String(m.userId), count: 0 };
      e.count++;
      byUser.set(m.userId, e);
    }

    const top = Array.from(byUser.entries()).sort((a, b) => b[1].count - a[1].count).slice(0, 5);

    const digest = `📊 *DAILY GROUP DIGEST*\n━━━━━━━━━━━━━━━━━━\n_${new Date().toDateString()}_\n\n` +
      `📨 Total messages: *${messages.length}*\n` +
      `👥 Active users: *${byUser.size}*\n\n` +
      `🏆 *Top Contributors*\n` +
      top.map(([, v], i) => `${i + 1}. ${v.name} — ${v.count} msgs`).join("\n");

    await bot.api.sendMessage(ownerId, digest, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error({ err }, "sendDailyGroupDigest failed");
  }
}

// ── Register ──────────────────────────────────────────────────────────────────

export function registerHexagonHandlers(bot: MyBot): void {
  bot.command("hexagon", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.reply("⛔ Owner only."); return; }
    const input = ctx.match?.trim();
    if (!input) {
      const { used, limit, remaining } = getQuotaStatus(ctx.from.id);
      await ctx.reply(
        `🤖 *HEXAGON AI AGENT*\n━━━━━━━━━━━━━━━━━━\n\n_Elite AI · Shop-aware · Group analyst · Task agent_\n\n📊 Today: *${used}/${limit}* queries used · *${remaining}* remaining\n\nAsk me anything or use the menu:`,
        { parse_mode: "Markdown", reply_markup: hexagonMenuKeyboard() }
      );
      return;
    }
    await handleHexagonMessage(ctx, input);
  });

  bot.command("ai", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    const input = ctx.match?.trim();
    if (!input) { await ctx.reply("Usage: /ai [question]"); return; }
    await handleHexagonMessage(ctx, input);
  });

  bot.command("clearai", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    history.delete(ctx.from.id);
    await ctx.reply("🧹 Hexagon memory cleared.");
  });

  bot.command("analyse", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    await runGroupAnalysis(ctx, bot);
  });
}

export function registerHexagonCallbacks(bot: MyBot): void {
  bot.callbackQuery("menu:hexagon", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery();
    const { used, limit, remaining } = getQuotaStatus(ctx.from.id);
    await ctx.editMessageText(
      `🤖 *HEXAGON AI AGENT*\n━━━━━━━━━━━━━━━━━━\n\n_Elite AI · Shop-aware · Group analyst · Task agent_\n\n📊 Today: *${used}/${limit}* queries used · *${remaining}* remaining\n\nAsk me anything or use the menu:`,
      { parse_mode: "Markdown", reply_markup: hexagonMenuKeyboard() }
    );
  });

  bot.callbackQuery("hexagon:chat", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    ctx.session.pendingAction = "hexagon:input";
    await ctx.answerCallbackQuery();
    await ctx.reply("💬 *Chat with Hexagon*\n\nType your message:", { parse_mode: "Markdown" });
  });

  bot.callbackQuery("hexagon:shop", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    ctx.session.pendingAction = "hexagon:input";
    await ctx.answerCallbackQuery();
    await ctx.reply("🛍️ *Shop Q&A*\n\nAsk about products, orders, pricing, or stock:\n\n_e.g. \"Which products are low on stock?\" or \"Summarise today's orders\"_", { parse_mode: "Markdown" });
  });

  bot.callbackQuery("hexagon:agent", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    ctx.session.pendingAction = "hexagon:input";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `⚡ *AGENT MODE*\n━━━━━━━━━━━━━━━━━━\n\nI can perform live tasks. Try:\n\n• _"Broadcast: Shop is closed today"_\n• _"Add product: VPN 1 month, $5, category: digital, stock: 100"_\n• _"DM user 123456 saying their order is ready"_\n\nType your instruction:`,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery("hexagon:analyst", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery("🔍 Analysing...");
    await runGroupAnalysis(ctx, bot);
  });

  bot.callbackQuery("hexagon:usage", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    const { used, limit, remaining } = getQuotaStatus(ctx.from.id);
    const bar = "█".repeat(Math.round((used / limit) * 10)) + "░".repeat(10 - Math.round((used / limit) * 10));
    await ctx.editMessageText(
      `📊 *HEXAGON USAGE*\n━━━━━━━━━━━━━━━━━━\n\n${bar}\n*${used}/${limit}* queries today\n*${remaining}* remaining\n\n_Resets midnight Nairobi time_\n_Free models: ${FREE_MODELS.length} in fallback pool_`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Back", "menu:hexagon") }
    );
  });

  bot.callbackQuery("hexagon:clear", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery(); return; }
    history.delete(ctx.from.id);
    await ctx.answerCallbackQuery("🧹 Cleared");
    await ctx.editMessageText(
      `🤖 *HEXAGON*\n━━━━━━━━━━━━━━━━━━\n\n🧹 Memory cleared. Fresh start!`,
      { parse_mode: "Markdown", reply_markup: hexagonMenuKeyboard() }
    );
  });
}

// ── Reminders (exported for reminders.ts) ─────────────────────────────────────

interface Reminder { id: string; userId: number; label: string; fireAt: Date; timer: ReturnType<typeof setTimeout>; }
const reminders = new Map<string, Reminder>();

export function scheduleReminder(bot: MyBot, userId: number, label: string, fireAt: Date): string {
  const id = `${userId}-${Date.now()}`;
  const delay = fireAt.getTime() - Date.now();
  if (delay <= 0) return "";
  const timer = setTimeout(async () => {
    reminders.delete(id);
    await bot.api.sendMessage(userId, `⏰ *REMINDER*\n\n${label}`, { parse_mode: "Markdown" }).catch(() => {});
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

// ── Daily digest (exported for reminders.ts & cron) ──────────────────────────

export async function sendDailyDigest(userId: number, bot: MyBot): Promise<void> {
  try {
    const products = await db.select().from(productsTable).where(eq(productsTable.isActive, true));
    const lowStock = products.filter((p) => Number(p.stock) <= 5 && Number(p.stock) > 0);
    const now = new Date();

    let digest = `🌅 *GOOD MORNING — DAILY DIGEST*\n━━━━━━━━━━━━━━━━━━━━\n`;
    digest += `📅 ${now.toLocaleDateString("en-KE", { timeZone: "Africa/Nairobi", weekday: "long", month: "long", day: "numeric" })}\n\n`;
    digest += `🛍️ *SHOP SNAPSHOT*\n• Active products: ${products.length}\n`;
    if (lowStock.length > 0) digest += `• ⚠️ Low stock: ${lowStock.map((p) => p.name).join(", ")}\n`;

    const { used, limit } = getQuotaStatus(userId);
    digest += `\n🤖 *HEXAGON AI*\n• Queries today: ${used}/${limit}\n`;
    digest += `\n_Have a productive day! /hexagon to chat._`;

    await bot.api.sendMessage(userId, digest, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error({ err }, "sendDailyDigest error");
  }
}

// ── askHexagon export (for email.ts) ─────────────────────────────────────────

export { askHexagon };
