/**
 * CRESCENT — AI Agent for Bot-Command-Central
 * ─────────────────────────────────────────────
 * • Free model fallback loop (5 models)
 * • Daily quota: 50 queries/day (resets midnight Nairobi)
 * • Group analyst: reads group messages, summarises user behaviour
 * • Agent mode: performs live tasks (broadcast, ban, product ops, etc.)
 * • Shop-aware: live product + order context injected into every prompt
 */

import { InlineKeyboard } from "grammy";
import { Pool } from "pg";
import { eq, desc, gte, and, count } from "drizzle-orm";
import {
  accessTable,
  blacklistTable,
  crescentQuotaCreditsTable,
  crescentQuotaPurchasesTable,
  db,
  dbLogsTable,
  externalDbLogsTable,
  groupMessagesTable,
  groupSettingsTable,
  meetingsTable,
  ordersTable,
  productsTable,
  usersTable,
  warningsTable,
} from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner, mustBeGroup } from "../helpers";
import { checkCrescentAccess } from "./access";
import { logger } from "../../lib/logger";
import { createCryptoBotInvoice, type CryptoBotAsset } from "./cryptobot";
import {
  CRESCENT_DAILY_LIMIT,
  CRESCENT_TOPUP_CREDITS,
  CRESCENT_TOPUP_PRICE,
  consumeCrescentQuota,
  createCrescentQuotaPurchase,
  attachCrescentQuotaInvoice,
  formatCrescentQuota,
  getCrescentQuotaStatus,
} from "./crescent-quota";

// ── OpenRouter ────────────────────────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// Priority fallback list — verified live August 2026
const FREE_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free", // NVIDIA Nemotron Ultra — 1M ctx, top quality
  "google/gemma-4-31b-it:free",             // Google Gemma 4 31B — fast, reliable
  "google/gemma-4-26b-a4b-it:free",         // Google Gemma 4 26B — lightweight backup
  "google/gemma-3-27b-it:free",             // Google Gemma 3 27B — stable fallback
  "mistralai/mistral-small-3.2-24b-instruct:free", // Mistral Small — good chat
  "cohere/command-r-plus:free",             // Cohere Command R+ — last resort
];

// ── Quota ─────────────────────────────────────────────────────────────────────

// ── Context builders ──────────────────────────────────────────────────────────

async function buildShopContext(): Promise<string> {
  try {
    const [products, orders] = await Promise.all([
      db.select().from(productsTable).where(eq(productsTable.isActive, true)).limit(30),
      db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(10),
    ]);
    const productLines = products.length === 0
      ? "No active products."
      : products.map((p) => {
          const stock = Number(p.stock);
          const availability = stock === 0
            ? "Unlimited"
            : stock > 0
              ? `${p.stock} available`
              : "Out of stock";
          const delivery = p.deliveryType === "auto" && p.deliveryContent
            ? "Digital auto-delivery"
            : "Manual delivery";
          return `• ${p.name} | $${p.price} | Availability: ${availability} | Delivery: ${delivery} | Category: ${p.category}`;
        }).join("\n");
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

async function buildHarmonyContext(): Promise<string> {
  const externalDbUrl = process.env.EXTERNAL_DB_URL;
  if (!externalDbUrl) return "HARMONY DB: not configured.";

  const pool = new Pool({
    connectionString: externalDbUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 5000,
    max: 1,
  });

  try {
    const [tablesResult, columnsResult] = await Promise.all([
      pool.query<{ table_name: string; estimated_rows: string | number }>(`
        SELECT c.relname AS table_name,
               COALESCE(s.n_live_tup, 0)::bigint AS estimated_rows
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        ORDER BY c.relname
      `),
      pool.query<{ table_name: string; column_name: string; data_type: string }>(`
        SELECT table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position
      `),
    ]);

    const columnsByTable = new Map<string, string[]>();
    for (const column of columnsResult.rows) {
      const columns = columnsByTable.get(column.table_name) ?? [];
      columns.push(`${column.column_name}:${column.data_type}`);
      columnsByTable.set(column.table_name, columns);
    }

    const tableLines = tablesResult.rows.map((table) => {
      const columns = columnsByTable.get(table.table_name)?.join(", ") ?? "no columns reported";
      return `• ${table.table_name} (~${Number(table.estimated_rows)} rows) — ${columns}`;
    });

    return [
      "HARMONY DB SCHEMA (read-only metadata; no credentials or row values included):",
      tableLines.length > 0 ? tableLines.join("\n") : "No public tables found.",
    ].join("\n");
  } catch (err) {
    logger.warn({ err }, "Crescent could not inspect Harmony DB metadata");
    return "HARMONY DB: configured but schema metadata is unavailable.";
  } finally {
    await pool.end().catch(() => {});
  }
}

async function buildBotContext(): Promise<string> {
  try {
    const [
      users,
      access,
      products,
      orders,
      groups,
      groupSettings,
      warnings,
      blacklist,
      meetings,
      botLogs,
      harmonyLogs,
      quotaPurchases,
      quotaCredits,
    ] = await Promise.all([
      db.select({ total: count() }).from(usersTable),
      db.select({ total: count() }).from(accessTable),
      db.select({ total: count() }).from(productsTable),
      db.select({ total: count() }).from(ordersTable),
      db.select({ total: count() }).from(groupMessagesTable),
      db.select({ total: count() }).from(groupSettingsTable),
      db.select({ total: count() }).from(warningsTable),
      db.select({ total: count() }).from(blacklistTable),
      db.select({ total: count() }).from(meetingsTable),
      db.select({ status: dbLogsTable.status, message: dbLogsTable.message }).from(dbLogsTable).orderBy(desc(dbLogsTable.createdAt)).limit(8),
      db.select({ status: externalDbLogsTable.status, checkType: externalDbLogsTable.checkType, message: externalDbLogsTable.message }).from(externalDbLogsTable).orderBy(desc(externalDbLogsTable.createdAt)).limit(8),
      db.select({ total: count() }).from(crescentQuotaPurchasesTable),
      db.select({ total: count() }).from(crescentQuotaCreditsTable),
    ]);

    const total = (rows: Array<{ total: number }>): number => rows[0]?.total ?? 0;
    const botLogsText = botLogs.length === 0
      ? "No recent bot DB logs."
      : botLogs.map((log) => `• ${log.status}: ${log.message}`).join("\n");
    const harmonyLogsText = harmonyLogs.length === 0
      ? "No recent Harmony health logs."
      : harmonyLogs.map((log) => `• ${log.status} ${log.checkType}: ${log.message}`).join("\n");
    const harmonyContext = await buildHarmonyContext();

    return [
      "BOT DATA SNAPSHOT (read-only aggregate data):",
      `• Registered users: ${total(users)}`,
      `• Access records: ${total(access)}`,
      `• Products: ${total(products)}`,
      `• Orders: ${total(orders)}`,
      `• Recorded group messages: ${total(groups)}`,
      `• Configured groups: ${total(groupSettings)}`,
      `• Warnings: ${total(warnings)}`,
      `• Blacklisted terms: ${total(blacklist)}`,
      `• Meetings: ${total(meetings)}`,
      `• Quota purchases: ${total(quotaPurchases)}`,
      `• Quota accounts: ${total(quotaCredits)}`,
      "RECENT BOT DB LOGS:",
      botLogsText,
      "RECENT HARMONY HEALTH LOGS:",
      harmonyLogsText,
      harmonyContext,
    ].join("\n");
  } catch (err) {
    logger.warn({ err }, "Crescent could not build bot context");
    return `BOT DATA SNAPSHOT: unavailable.\n${await buildHarmonyContext()}`;
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

async function buildSystemPrompt(ctx?: BotContext): Promise<string> {
  const shopCtx = await buildShopContext();
  const groupCtx = ctx?.chat?.type !== "private" && ctx?.chat?.id
    ? await buildGroupContext(ctx.chat.id)
    : "";

  return `You are CRESCENT, an elite AI agent embedded in a private Telegram bot called Bot-Command-Central.

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
- Never make up product prices, availability, delivery method, or order data — only use the live data above
- A product with stock 0 is intentionally unlimited availability, not out of stock
- Digital products with auto-delivery content are available while they are active
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
          "X-Title": "Crescent-AI",
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

      logger.info({ model }, "Crescent responded");
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
  if (!isOwner(ownerId)) return "⚠️ Agent actions are available to the bot owner only.";

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
        const stock = String(action.payload["stock"] ?? "0");
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
const activeHexagonUsers = new Set<number>();
const seenHexagonUpdates = new Set<number>();
const MAX_SEEN_HEXAGON_UPDATES = 1000;

function wasAlreadyHandled(updateId: number): boolean {
  if (seenHexagonUpdates.has(updateId)) return true;

  seenHexagonUpdates.add(updateId);
  if (seenHexagonUpdates.size > MAX_SEEN_HEXAGON_UPDATES) {
    const oldestUpdateId = seenHexagonUpdates.values().next().value;
    if (typeof oldestUpdateId === "number") seenHexagonUpdates.delete(oldestUpdateId);
  }

  return false;
}

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

function quotaTopupKeyboard(): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (process.env.CRYPTOBOT_API_TOKEN) {
    keyboard.text(`💳 Buy +${CRESCENT_TOPUP_CREDITS} for $${CRESCENT_TOPUP_PRICE}`, "crescent:topup").row();
  }
  return keyboard.text("🤖 Crescent", "menu:hexagon");
}

// ── Public handler ────────────────────────────────────────────────────────────

export async function handleHexagonMessage(ctx: BotContext, input: string): Promise<void> {
  const userId = ctx.from!.id;
  if (wasAlreadyHandled(ctx.update.update_id)) return;
  if (!(await checkCrescentAccess(ctx))) return;

  if (activeHexagonUsers.has(userId)) {
    await ctx.reply("⏳ Crescent is still processing your previous request. Please wait for the response.");
    return;
  }

  activeHexagonUsers.add(userId);

  try {
    const quota = await consumeCrescentQuota(userId);

    if (!quota.allowed) {
      await ctx.reply(
        `⛔ *Daily quota reached*\n━━━━━━━━━━━━━━━━━━\n\nYou've used ${quota.used}/${CRESCENT_DAILY_LIMIT} daily queries.\nYou have no bonus queries remaining.\n\nBuy ${CRESCENT_TOPUP_CREDITS} extra queries for $${CRESCENT_TOPUP_PRICE}.`,
        { parse_mode: "Markdown", reply_markup: quotaTopupKeyboard() }
      );
      return;
    }

    const quotaLabel = quota.unlimited ? "Unlimited" : formatCrescentQuota(quota);
    const thinking = await ctx.reply(`🧠 _Crescent thinking... (${quotaLabel})_`, { parse_mode: "Markdown" });

    try {
      const { reply, actionResult } = await askHexagon(userId, input, ctx);
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});

      const chunks = split(reply);
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        await ctx.reply(
          (i === 0 ? `🤖 *CRESCENT*\n━━━━━━━━━━━━━━━━━━\n\n` : "") + chunks[i],
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
    } catch (err) {
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
      await ctx.reply(`❌ *Crescent error*\n\n${err instanceof Error ? err.message : "Unknown error"}`, { parse_mode: "Markdown" });
    }
  } finally {
    activeHexagonUsers.delete(userId);
  }
}

// ── Group message logger (call from bot message handler) ──────────────────────

export async function logGroupMessage(ctx: BotContext): Promise<void> {
  const message = ctx.message;
  if (!message || !ctx.from || ctx.chat?.type === "private") return;

  const text = "text" in message ? message.text : "caption" in message ? message.caption : undefined;
  if (!text?.trim()) return;

  try {
    await db.insert(groupMessagesTable).values({
      chatId: ctx.chat!.id,
      userId: ctx.from.id,
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
      message: text.trim().slice(0, 500),
    });
  } catch { /* non-critical */ }
}

// ── Group analyst ─────────────────────────────────────────────────────────────

async function runGroupAnalysis(ctx: BotContext, bot: MyBot): Promise<void> {
  if (!(await mustBeGroup(ctx))) return;

  const chatId = ctx.chat!.id;
  const thinking = await ctx.reply("🔍 _Analysing group activity..._", { parse_mode: "Markdown" });

  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [latestMessages, botContext] = await Promise.all([
      db
        .select()
        .from(groupMessagesTable)
        .where(and(eq(groupMessagesTable.chatId, chatId), gte(groupMessagesTable.createdAt, since)))
        .orderBy(desc(groupMessagesTable.createdAt))
        .limit(300),
      buildBotContext(),
    ]);
    const messages = latestMessages.reverse();

    if (messages.length < 5) {
      await ctx.api.deleteMessage(chatId, thinking.message_id).catch(() => {});
      await ctx.reply("📊 Not enough live group messages recorded yet.\n\n_I need at least 5 messages from this group. Make sure the bot is an admin and that Telegram privacy mode is disabled in BotFather so it can receive normal group conversations._", { parse_mode: "Markdown" });
      return;
    }

    const transcript = messages
      .map((m) => `[${m.firstName ?? m.username ?? m.userId}]: ${m.message}`)
      .join("\n");

    const { reply } = await callOpenRouter([
      {
        role: "system",
        content: `You are CRESCENT, an expert group behaviour analyst and Bot-Command-Central operations analyst. Analyse the Telegram group and the bot snapshot provided below. Provide:
1. GROUP ACTIVITY — total messages, active users, peak times, and conversation themes
2. USER PROFILES — brief behaviour profile for each active user (tone, topics, activity level)
3. SENTIMENT — overall group mood
4. RED FLAGS — suspicious, spammy, or toxic patterns, clearly separating evidence from uncertainty
5. BOT OVERVIEW — explain what the bot's data and connected Harmony DB indicate about usage, health, and configuration
6. RECOMMENDATIONS — concrete actions for the admin

Use only the supplied data. Do not invent records, credentials, or database contents. Treat database metadata and logs as read-only context. Be concise, sharp, and insightful. Today: ${new Date().toDateString()}

${botContext}`
      },
      { role: "user", content: `Analyse this conversation from the last 24 hours:\n\n${transcript.slice(0, 8000)}` }
    ]);

    await ctx.api.deleteMessage(chatId, thinking.message_id).catch(() => {});

    const header = `📊 GROUP + BOT ANALYSIS REPORT\n━━━━━━━━━━━━━━━━━━\nLatest live window · ${messages.length} messages · ${new Set(messages.map((m) => m.userId)).size} users`;
    const chunks = split(`${header}\n\n${reply}`);
    for (const chunk of chunks) {
      await ctx.reply(chunk);
    }
  } catch (err) {
    logger.error({ err, chatId }, "Group analysis failed");
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
  bot.command("crescent", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    const input = ctx.match?.trim();
    if (!input) {
      const quota = await getCrescentQuotaStatus(ctx.from.id);
      const quotaText = quota.unlimited ? "Unlimited" : formatCrescentQuota(quota);
      await ctx.reply(
        `🤖 *CRESCENT AI AGENT*\n━━━━━━━━━━━━━━━━━━\n\n_Elite AI · Shop-aware · Group analyst · Task agent_\n\n📊 Quota: *${quotaText}*\n\nAsk me anything or use the menu:`,
        { parse_mode: "Markdown", reply_markup: hexagonMenuKeyboard() }
      );
      return;
    }
    await handleHexagonMessage(ctx, input);
  });

  bot.command("ai", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    const input = ctx.match?.trim();
    if (!input) { await ctx.reply("Usage: /ai [question]"); return; }
    await handleHexagonMessage(ctx, input);
  });

  bot.command("clearai", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    history.delete(ctx.from.id);
    await ctx.reply("🧹 Crescent memory cleared.");
  });

  bot.command("analyse", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    await runGroupAnalysis(ctx, bot);
  });
}

export function registerHexagonCallbacks(bot: MyBot): void {
  bot.callbackQuery("menu:hexagon", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    const quota = await getCrescentQuotaStatus(ctx.from.id);
    const quotaText = quota.unlimited ? "Unlimited" : formatCrescentQuota(quota);
    await ctx.editMessageText(
      `🤖 *CRESCENT AI AGENT*\n━━━━━━━━━━━━━━━━━━\n\n_Elite AI · Shop-aware · Group analyst · Task agent_\n\n📊 Quota: *${quotaText}*\n\nAsk me anything or use the menu:`,
      { parse_mode: "Markdown", reply_markup: hexagonMenuKeyboard() }
    );
  });

  bot.callbackQuery("crescent:topup", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) { await ctx.answerCallbackQuery("⛔"); return; }
    if (!process.env.CRYPTOBOT_API_TOKEN) {
      await ctx.answerCallbackQuery("Payments are not configured.");
      await ctx.reply("⚠️ Crypto payments are not configured yet. Please contact the owner.");
      return;
    }

    await ctx.answerCallbackQuery("⏳ Creating payment...");
    const userId = ctx.from.id;
    const asset: CryptoBotAsset = "USDT";
    const purchase = await createCrescentQuotaPurchase(userId, asset);

    try {
      const invoice = await createCryptoBotInvoice({
        asset,
        amount: CRESCENT_TOPUP_PRICE,
        purchaseId: purchase.id,
        productName: `Crescent +${CRESCENT_TOPUP_CREDITS} queries`,
        userId,
      });
      await attachCrescentQuotaInvoice(purchase.id, invoice.invoice_id);
      await ctx.editMessageText(
        `💳 *CRESCENT QUOTA TOP-UP*\n━━━━━━━━━━━━━━━━━━\n\n` +
          `Add *${CRESCENT_TOPUP_CREDITS} queries* for *$${CRESCENT_TOPUP_PRICE} USD*\n` +
          `Payment asset: *${asset}*\n\n` +
          `Your bonus queries are added automatically after CryptoBot confirms payment.`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .url("💳 Pay with CryptoBot", invoice.bot_invoice_url)
            .row()
            .text("🤖 Crescent", "menu:hexagon"),
        },
      );
    } catch (err) {
      logger.error({ err, purchaseId: purchase.id }, "Crescent quota invoice creation failed");
      await ctx.editMessageText("❌ Could not create the quota payment. Please try again later.", {
        reply_markup: new InlineKeyboard().text("🤖 Crescent", "menu:hexagon"),
      });
    }
  });

  bot.callbackQuery("hexagon:chat", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) { await ctx.answerCallbackQuery("⛔"); return; }
    ctx.session.pendingAction = "hexagon:input";
    await ctx.answerCallbackQuery();
    await ctx.reply("💬 *Chat with Crescent*\n\nType your message:", { parse_mode: "Markdown" });
  });

  bot.callbackQuery("hexagon:shop", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) { await ctx.answerCallbackQuery("⛔"); return; }
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
    if (!ctx.from || !(await checkCrescentAccess(ctx))) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    const quota = await getCrescentQuotaStatus(ctx.from.id);
    const quotaText = quota.unlimited ? "Unlimited" : formatCrescentQuota(quota);
    const bar = quota.unlimited ? "██████████" : "█".repeat(Math.min(10, Math.round((quota.used / quota.limit) * 10))) + "░".repeat(Math.max(0, 10 - Math.round((quota.used / quota.limit) * 10)));
    await ctx.editMessageText(
      `📊 *CRESCENT USAGE*\n━━━━━━━━━━━━━━━━━━\n\n${bar}\n*${quotaText}*\n\n_Resets midnight Nairobi time_\n_Free models: ${FREE_MODELS.length} in fallback pool_`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Back", "menu:hexagon") }
    );
  });

  bot.callbackQuery("hexagon:clear", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) { await ctx.answerCallbackQuery(); return; }
    history.delete(ctx.from.id);
    await ctx.answerCallbackQuery("🧹 Cleared");
    await ctx.editMessageText(
      `🤖 *CRESCENT*\n━━━━━━━━━━━━━━━━━━\n\n🧹 Memory cleared. Fresh start!`,
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

    const quota = await getCrescentQuotaStatus(userId);
    digest += `\n🤖 *CRESCENT AI*\n• Quota: ${quota.unlimited ? "Unlimited" : formatCrescentQuota(quota)}\n`;
    digest += `\n_Have a productive day! /crescent to chat._`;

    await bot.api.sendMessage(userId, digest, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error({ err }, "sendDailyDigest error");
  }
}

// ── askHexagon export (for email.ts) ─────────────────────────────────────────

export { askHexagon };
