/**
 * CRESCENT — AI Agent for Bot-Command-Central
 * ─────────────────────────────────────────────
 * • Shop-aware: live product + order context in every prompt
 * • Daily quota: 50 queries/day (resets midnight Nairobi)
 * • Group analyst + digests
 * • Persistent AI memory
 */

import { InlineKeyboard } from "grammy";
import { eq, desc, gte, and, count } from "drizzle-orm";
import {
  db,
  groupMessagesTable,
  ordersTable,
  productsTable,
} from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { checkCrescentAccess } from "./access";
import { logger } from "../../lib/logger";
import {
  consumeCrescentQuota,
  formatCrescentQuota,
  getCrescentQuotaStatus,
} from "./crescent-quota";
import { buildMemoryContext, clearMemory, rememberExchange } from "../../lib/ai-memory";
import { routeChat, type ChatMessage } from "../../lib/model-router";
import type { TaskType } from "../../lib/model-config";

// ── Shop context (live catalog + recent orders) ───────────────────────────────

async function buildShopContext(): Promise<string> {
  try {
    const [products, orders] = await Promise.all([
      db.select().from(productsTable).where(eq(productsTable.isActive, true)).limit(40),
      db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(15),
    ]);

    const productLines =
      products.length === 0
        ? "No active products."
        : products
            .map((p) => {
              const stock = Number(p.stock);
              const availability =
                stock === 0 ? "Unlimited" : stock > 0 ? `${p.stock} available` : "Out of stock";
              const delivery =
                p.deliveryType === "auto" && p.deliveryContent
                  ? "Digital auto-delivery"
                  : "Manual delivery";
              return `• ${p.name} | $${p.price} | ${availability} | ${delivery} | Category: ${p.category ?? "general"}`;
            })
            .join("\n");

    const orderLines =
      orders.length === 0
        ? "No recent orders."
        : orders
            .map(
              (o) =>
                `• Order #${o.id} | Product:${o.productId} | Qty:${o.quantity} | Status:${o.status}`,
            )
            .join("\n");

    return `LIVE SHOP DATA:\n${productLines}\n\nRECENT ORDERS:\n${orderLines}`;
  } catch (err) {
    logger.warn({ err }, "Crescent could not build shop context");
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

    const byUser = new Map<number, { name: string; count: number; samples: string[] }>();
    for (const m of messages) {
      const entry =
        byUser.get(m.userId) ?? {
          name: m.firstName ?? m.username ?? String(m.userId),
          count: 0,
          samples: [],
        };
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

async function buildSystemPrompt(ctx?: BotContext): Promise<string> {
  const shopCtx = await buildShopContext();
  const groupCtx =
    ctx?.chat?.type !== "private" && ctx?.chat?.id
      ? await buildGroupContext(ctx.chat.id)
      : "";

  const today = new Date().toLocaleDateString("en-KE", {
    timeZone: "Africa/Nairobi",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `You are CRESCENT, an elite AI agent embedded in a private Telegram bot called Bot-Command-Central.

PERSONALITY: Sharp, direct, intelligent, slightly futuristic. No fluff. You are a high-performance assistant.

YOUR CAPABILITIES:
1. GENERAL AI — Answer anything: research, writing, analysis, coding, math, advice.
2. SHOP AGENT — Full awareness of the bot's product catalog and order history. Use the live shop data below. Never invent prices, stock, or delivery methods.
3. GROUP ANALYST — Analyse group conversations when group context is provided.
4. TASK AGENT — When the user asks for an actionable task, end with a JSON action block:
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
- Today: ${today}`;
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function crescentMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💬 Chat", "hexagon:chat")
    .text("🛍️ Shop Q&A", "hexagon:shop")
    .row()
    .text("🧹 Clear memory", "hexagon:clear")
    .text("🏠 Main Menu", "menu:main");
}

async function crescentIntroText(userId: number): Promise<string> {
  const quota = await getCrescentQuotaStatus(userId);
  const quotaText = quota.unlimited ? "Unlimited" : formatCrescentQuota(quota);
  return (
    `🤖 *CRESCENT AI AGENT*\n━━━━━━━━━━━━━━━━━━\n\n` +
    `_Elite AI · Shop-aware · Group analyst · Task agent_\n\n` +
    `📊 Quota: *${quotaText}*\n\n` +
    `Ask me anything — type a message, use Shop Q&A, or /crescent your question`
  );
}

// ── Daily digest ──────────────────────────────────────────────────────────────

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

// ── Core ask ──────────────────────────────────────────────────────────────────

async function askHexagon(
  userId: number,
  userMessage: string,
  ctx?: BotContext,
  task: TaskType = "chat",
): Promise<{ reply: string; model: string }> {
  const [system, memory] = await Promise.all([
    buildSystemPrompt(ctx),
    buildMemoryContext(userId, userMessage),
  ]);
  const response = await routeChat(task, [
    { role: "system", content: `${system}\n\n${memory}` },
    { role: "user", content: userMessage },
  ]);
  void rememberExchange(userId, userMessage, response.reply, task);
  return { reply: response.reply, model: response.model };
}

export { askHexagon };

export async function handleHexagonMessage(ctx: BotContext, input: string): Promise<void> {
  const userId = ctx.from!.id;
  if (!(await checkCrescentAccess(ctx))) return;

  // Keep chat mode active for follow-up messages
  ctx.session.pendingAction = "hexagon:input";

  const thinking = await ctx.reply(`🧠 _Crescent thinking..._`, { parse_mode: "Markdown" });
  try {
    const consumed = await consumeCrescentQuota(userId);
    if (!consumed.allowed) {
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
      await ctx.reply(
        `⚠️ *Quota exceeded*\n\n${formatCrescentQuota(consumed)}\n\nResets at midnight Nairobi time.`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    const { reply } = await askHexagon(userId, input, ctx, "chat");
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(`🤖 *CRESCENT*\n━━━━━━━━━━━━━━━━━━\n\n${reply}`, {
      parse_mode: "Markdown",
    });
  } catch (err) {
    logger.error({ err, userId }, "handleHexagonMessage failed");
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(
      `❌ *Crescent error*\n\n${err instanceof Error ? err.message : "Unknown error"}`,
      { parse_mode: "Markdown" },
    );
  }
}

// ── Register commands + callbacks ─────────────────────────────────────────────

export function registerHexagonHandlers(bot: MyBot): void {
  bot.command("crescent", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    const input = ctx.match?.trim();
    if (!input) {
      ctx.session.pendingAction = "hexagon:input";
      await ctx.reply(await crescentIntroText(ctx.from.id), {
        parse_mode: "Markdown",
        reply_markup: crescentMenuKeyboard(),
      });
      return;
    }
    await handleHexagonMessage(ctx, input);
  });

  bot.command("ai", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    const input = ctx.match?.trim();
    if (!input) {
      ctx.session.pendingAction = "hexagon:input";
      await ctx.reply("Usage: /ai [question]\nOr just type your message now.");
      return;
    }
    await handleHexagonMessage(ctx, input);
  });

  bot.command("clearai", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    await clearMemory(ctx.from.id);
    await ctx.reply("🧹 Crescent memory cleared.");
  });
}

export function registerHexagonCallbacks(bot: MyBot): void {
  bot.callbackQuery("menu:hexagon", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "hexagon:input";
    await ctx.editMessageText(await crescentIntroText(ctx.from.id), {
      parse_mode: "Markdown",
      reply_markup: crescentMenuKeyboard(),
    });
  });

  bot.callbackQuery("hexagon:chat", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "hexagon:input";
    await ctx.reply("💬 *Chat with Crescent*\n\nType your message:", { parse_mode: "Markdown" });
  });

  bot.callbackQuery("hexagon:shop", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "hexagon:input";
    await ctx.reply(
      `🛍️ *Shop Q&A*\n\nAsk about products, orders, pricing, or stock.\n\n_e.g. "Which products are low on stock?"_`,
      { parse_mode: "Markdown" },
    );
  });

  bot.callbackQuery("hexagon:clear", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) {
      await ctx.answerCallbackQuery();
      return;
    }
    await clearMemory(ctx.from.id);
    await ctx.answerCallbackQuery("🧹 Cleared");
    ctx.session.pendingAction = "hexagon:input";
    await ctx.editMessageText(
      `🤖 *CRESCENT*\n━━━━━━━━━━━━━━━━━━\n\n🧹 Memory cleared. Fresh start!\n\nType a message to chat.`,
      { parse_mode: "Markdown", reply_markup: crescentMenuKeyboard() },
    );
  });
}

// ── Group helpers ─────────────────────────────────────────────────────────────

export async function logGroupMessage(ctx: BotContext): Promise<void> {
  const message = ctx.message;
  if (!message || !ctx.from || ctx.chat?.type === "private") return;
  const text =
    "text" in message ? message.text : "caption" in message ? message.caption : undefined;
  if (!text?.trim()) return;
  try {
    await db.insert(groupMessagesTable).values({
      chatId: ctx.chat!.id,
      userId: ctx.from.id,
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
      message: text.slice(0, 2000),
    });
  } catch (err) {
    logger.warn({ err }, "logGroupMessage failed");
  }
}

export async function sendDailyGroupDigest(
  bot: MyBot,
  chatId: number,
  ownerId: number,
): Promise<void> {
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
      const e = byUser.get(m.userId) ?? {
        name: m.firstName ?? m.username ?? String(m.userId),
        count: 0,
      };
      e.count++;
      byUser.set(m.userId, e);
    }
    const top = Array.from(byUser.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5);

    const digest =
      `📊 *DAILY GROUP DIGEST*\n━━━━━━━━━━━━━━━━━━\n_${new Date().toDateString()}_\n\n` +
      `📨 Total messages: *${messages.length}*\n` +
      `👥 Active users: *${byUser.size}*\n\n` +
      `🏆 *Top Contributors*\n` +
      top.map(([, v], i) => `${i + 1}. ${v.name} — ${v.count} msgs`).join("\n");

    await bot.api.sendMessage(ownerId, digest, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error({ err }, "sendDailyGroupDigest failed");
  }
}

export function scheduleReminder(
  bot: MyBot,
  userId: number,
  label: string,
  fireAt: Date,
): string {
  const id = `${userId}-${Date.now()}`;
  const delay = fireAt.getTime() - Date.now();
  if (delay <= 0) return "";
  setTimeout(async () => {
    await bot.api
      .sendMessage(userId, `⏰ *REMINDER*\n\n${label}`, { parse_mode: "Markdown" })
      .catch(() => {});
  }, delay);
  return id;
}

export function clearAllReminders(_userId: number): number {
  return 0;
}
