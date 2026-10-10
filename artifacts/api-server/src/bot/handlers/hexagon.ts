/**
 * CRESCENT — AI Agent for Bot-Command-Central
 * ─────────────────────────────────────────────
 * • Daily quota: 50 queries/day (resets midnight Nairobi)
 * • Shop-aware + memory via model-router
 * • Group analyst + digests
 */

import { InlineKeyboard } from "grammy";
import { eq, desc, gte, and, count } from "drizzle-orm";
import {
  db,
  groupMessagesTable,
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

function crescentMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💬 Chat", "hexagon:chat")
    .text("🧹 Clear memory", "hexagon:clear")
    .row()
    .text("🏠 Main Menu", "menu:main");
}

async function crescentIntroText(userId: number): Promise<string> {
  const quota = await getCrescentQuotaStatus(userId);
  const quotaText = quota.unlimited ? "Unlimited" : formatCrescentQuota(quota);
  return (
    `🤖 *CRESCENT AI AGENT*\n━━━━━━━━━━━━━━━━━━\n\n` +
    `_Elite AI · Shop-aware · Group analyst · Task agent_\n\n` +
    `📊 Quota: *${quotaText}*\n\n` +
    `Ask me anything — type a message or use /crescent your question`
  );
}

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

    const system =
      "You are CRESCENT, an elite AI agent in Bot-Command-Central. " +
      "Be sharp, concise, and helpful. Use *bold* sparingly for Telegram Markdown.";
    const memory = await buildMemoryContext(userId, input);
    const messages: ChatMessage[] = [
      { role: "system", content: `${system}\n\n${memory}` },
      { role: "user", content: input },
    ];
    const response = await routeChat("chat", messages);
    void rememberExchange(userId, input, response.reply, "chat");

    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(`🤖 *CRESCENT*\n━━━━━━━━━━━━━━━━━━\n\n${response.reply}`, {
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

async function askHexagon(
  userId: number,
  userMessage: string,
  _ctx?: BotContext,
  task: TaskType = "chat",
): Promise<{ reply: string; model: string }> {
  const memory = await buildMemoryContext(userId, userMessage);
  const response = await routeChat(task, [
    { role: "system", content: `You are CRESCENT.\n\n${memory}` },
    { role: "user", content: userMessage },
  ]);
  void rememberExchange(userId, userMessage, response.reply, task);
  return { reply: response.reply, model: response.model };
}

export { askHexagon };
