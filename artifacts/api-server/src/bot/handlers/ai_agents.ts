/**
 * AI AGENTS — Powered by AgentRouter
 * ────────────────────────────────────────────────────────────────────────────
 * 10 AI-powered features using the AgentRouter API key:
 *
 *  1. Harmony DB health summary (daily AI-written report)
 *  2. Bank log auto-pricer
 *  3. CardShop product description writer
 *  4. Group moderation AI (warn/kick/ban decisions)
 *  5. Order dispute handler
 *  6. Smart broadcast writer
 *  7. Customer support agent (answers user DMs)
 *  8. Daily business report
 *  9. Invite code tier suggester
 * 10. Harmony DB natural language query assistant
 */

import { InlineKeyboard } from "grammy";
import { eq, desc, gte, and, sql } from "drizzle-orm";
import { Pool } from "pg";
import {
  db, productsTable, ordersTable, usersTable,
  groupMessagesTable, bankLogsTable, externalDbLogsTable,
  accessTable, inviteCodesTable,
} from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

// ── AgentRouter call (shared) ─────────────────────────────────────────────────

const API_KEY = process.env.AGENTROUTER_API_KEY ?? "";
const BASE = "https://agentrouter.org/v1";
const MODEL = "claude-sonnet-4-5-20250929";
const FALLBACK = "gpt-4o";

async function ask(
  system: string,
  user: string,
  model = MODEL
): Promise<string> {
  if (!API_KEY) throw new Error("AGENTROUTER_API_KEY not set on Render.");
  for (const m of [model, FALLBACK, "deepseek-chat", "gemini-2.0-flash"]) {
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: m, max_tokens: 1024, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      });
      if (!res.ok) continue;
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
      const reply = data.choices?.[0]?.message?.content?.trim() ?? "";
      if (reply) return reply;
    } catch { continue; }
  }
  throw new Error("All AgentRouter models failed.");
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. HARMONY DB HEALTH SUMMARY
// ─────────────────────────────────────────────────────────────────────────────

export async function generateHarmonyHealthSummary(bot: MyBot, ownerId: number): Promise<void> {
  const url = process.env.EXTERNAL_DB_URL;
  if (!url) return;

  try {
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();

    const [sizeRes, tableRes, connRes] = await Promise.all([
      client.query(`SELECT pg_size_pretty(pg_database_size(current_database())) as size, pg_database_size(current_database())::float / (1024*1024*1024) as gb`),
      client.query(`SELECT tablename, (SELECT COUNT(*) FROM information_schema.columns WHERE table_name = tablename AND table_schema = 'public') as cols FROM pg_tables WHERE schemaname='public' ORDER BY tablename`),
      client.query(`SELECT count(*) as active FROM pg_stat_activity WHERE state = 'active'`),
    ]);

    client.release();
    await pool.end();

    const sizeGb = parseFloat(sizeRes.rows[0]?.gb ?? 0);
    const pct = ((sizeGb / 1024) * 100).toFixed(2);
    const tables = tableRes.rows.map((r: { tablename: string; cols: number }) => `${r.tablename}(${r.cols} cols)`).join(", ");
    const activeConn = connRes.rows[0]?.active ?? 0;

    const summary = await ask(
      `You are a database health analyst. Write a concise Telegram-formatted DB health report. Use *bold* for key metrics. Max 200 words. Be direct and professional.`,
      `Harmony DB stats:\n- Size: ${sizeRes.rows[0]?.size} (${pct}% of 1TB limit)\n- Active connections: ${activeConn}\n- Tables: ${tables}\n- Date: ${new Date().toDateString()}\n\nWrite a health summary with: overall status, storage trend, any warnings, and one recommendation.`
    );

    await bot.api.sendMessage(
      ownerId,
      `🩺 *HARMONY DB — AI HEALTH REPORT*\n━━━━━━━━━━━━━━━━━━\n\n${summary}`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    logger.error({ err }, "generateHarmonyHealthSummary failed");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. BANK LOG AUTO-PRICER
// ─────────────────────────────────────────────────────────────────────────────

export async function priceBankLog(log: {
  bankName: string; country: string; accountType: string;
  balance?: string | null; extras?: string | null;
}): Promise<string> {
  return ask(
    `You are a bank log pricing expert. Return ONLY a dollar amount like "$75" or "$120-150". No explanation. Just the price.`,
    `Price this bank log:\nBank: ${log.bankName}\nCountry: ${log.country}\nType: ${log.accountType}\nBalance: ${log.balance ?? "unknown"}\nExtras: ${log.extras ?? "none"}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. CARDSHOP PRODUCT DESCRIPTION WRITER
// ─────────────────────────────────────────────────────────────────────────────

export async function generateProductDescription(product: {
  name: string; category: string; price: string; deliveryType: string;
}): Promise<string> {
  return ask(
    `You are a copywriter for a Telegram digital goods shop. Write a short punchy product description for a Telegram bot shop listing. Max 2 sentences. No emojis. Be specific and enticing.`,
    `Product: ${product.name}\nCategory: ${product.category}\nPrice: $${product.price}\nDelivery: ${product.deliveryType === "auto" ? "Instant auto-delivery" : "Manual delivery"}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. GROUP MODERATION AI
// ─────────────────────────────────────────────────────────────────────────────

export type ModDecision = "warn" | "kick" | "ban" | "ignore";

export async function getModDecision(message: string, context: {
  username?: string; previousWarnings?: number; isSpam?: boolean;
}): Promise<{ decision: ModDecision; reason: string }> {
  const raw = await ask(
    `You are a Telegram group moderator AI. Analyze messages and return ONLY valid JSON like: {"decision":"warn","reason":"..."}\nDecisions: warn (first offense), kick (repeated/moderate), ban (severe/spam/illegal), ignore (fine).\nNo markdown, no explanation, just JSON.`,
    `Message: "${message}"\nUser: ${context.username ?? "unknown"}\nPrior warnings: ${context.previousWarnings ?? 0}\nSpam detected: ${context.isSpam ?? false}`
  );
  try {
    return JSON.parse(raw.replace(/```json|```/g, "").trim()) as { decision: ModDecision; reason: string };
  } catch {
    return { decision: "warn", reason: raw.slice(0, 100) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. ORDER DISPUTE HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export async function handleOrderDispute(dispute: {
  orderId: number; productName: string; customerMessage: string;
  orderStatus: string; paymentMethod?: string;
}): Promise<string> {
  return ask(
    `You are a customer service agent for a digital goods Telegram shop. Draft a professional, empathetic reply to a customer dispute. Keep it under 100 words. Be solution-focused.`,
    `Order #${dispute.orderId} — ${dispute.productName}\nStatus: ${dispute.orderStatus}\nPayment: ${dispute.paymentMethod ?? "unknown"}\nCustomer says: "${dispute.customerMessage}"`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. SMART BROADCAST WRITER
// ─────────────────────────────────────────────────────────────────────────────

export async function writeBroadcast(intent: string, context?: string): Promise<string> {
  return ask(
    `You are writing a Telegram broadcast message for a digital goods shop. Format it for Telegram using *bold* and _italic_. Keep it under 150 words. Make it engaging and clear. Do NOT add a subject line.`,
    `Write a broadcast about: ${intent}${context ? `\nContext: ${context}` : ""}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. CUSTOMER SUPPORT AGENT
// ─────────────────────────────────────────────────────────────────────────────

export async function handleSupportMessage(message: string, products: string): Promise<string> {
  return ask(
    `You are a helpful customer support agent for a digital goods Telegram shop called Crescent. Answer questions about products, orders, and payments. Be friendly and concise. If you don't know, say "Contact the admin for more details." Max 100 words.`,
    `Customer message: "${message}"\n\nAvailable products:\n${products}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. DAILY BUSINESS REPORT
// ─────────────────────────────────────────────────────────────────────────────

export async function generateBusinessReport(bot: MyBot, ownerId: number): Promise<void> {
  try {
    const since = new Date(); since.setHours(0, 0, 0, 0);

    const [allProducts, todayOrders, allOrders, totalUsers] = await Promise.all([
      db.select().from(productsTable).where(eq(productsTable.isActive, true)),
      db.select().from(ordersTable).where(gte(ordersTable.createdAt, since)),
      db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(50),
      db.select({ count: sql<number>`count(*)` }).from(usersTable),
    ]);

    const revenue = allOrders
      .filter((o) => o.status === "confirmed")
      .reduce((sum, o) => sum + parseFloat(o.totalAmount ?? "0"), 0);

    const todayRevenue = todayOrders
      .filter((o) => o.status === "confirmed")
      .reduce((sum, o) => sum + parseFloat(o.totalAmount ?? "0"), 0);

    const lowStock = allProducts.filter((p) => Number(p.stock) > 0 && Number(p.stock) <= 5);
    const outOfStock = allProducts.filter((p) => Number(p.stock) === 0);

    const statusCounts = todayOrders.reduce((acc, o) => {
      acc[o.status] = (acc[o.status] ?? 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const report = await ask(
      `You are a business analyst. Write a concise daily business report for a Telegram digital goods shop. Use *bold* for numbers. Max 250 words. Be insightful — spot trends, flag issues, give one actionable tip.`,
      `Business data for ${new Date().toDateString()}:\n` +
      `- Active products: ${allProducts.length}\n` +
      `- Total users: ${totalUsers[0]?.count ?? 0}\n` +
      `- Today's orders: ${todayOrders.length} (${JSON.stringify(statusCounts)})\n` +
      `- Today's revenue: $${todayRevenue.toFixed(2)}\n` +
      `- All-time revenue: $${revenue.toFixed(2)}\n` +
      `- Low stock items: ${lowStock.map((p) => p.name).join(", ") || "none"}\n` +
      `- Out of stock: ${outOfStock.map((p) => p.name).join(", ") || "none"}`
    );

    await bot.api.sendMessage(
      ownerId,
      `📊 *DAILY BUSINESS REPORT*\n━━━━━━━━━━━━━━━━━━\n_${new Date().toDateString()}_\n\n${report}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("🛍️ CardShop", "cardshop:main")
          .text("📋 Orders", "hex:orders"),
      }
    );
  } catch (err) {
    logger.error({ err }, "generateBusinessReport failed");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. INVITE CODE TIER SUGGESTER
// ─────────────────────────────────────────────────────────────────────────────

export async function suggestAccessTier(requestMessage: string): Promise<{
  tier: "free" | "premium" | "vip"; reason: string;
}> {
  const raw = await ask(
    `You manage access to a private Telegram shop. Based on an access request message, suggest an appropriate tier.\nTiers:\n- free: general users, no spending history mentioned\n- premium: mentions referral, past purchases, or business intent\n- vip: mentions high volume, bulk orders, or strong credentials\n\nReturn ONLY JSON: {"tier":"free","reason":"..."} No markdown.`,
    `Access request: "${requestMessage}"`
  );
  try {
    return JSON.parse(raw.replace(/```json|```/g, "").trim()) as { tier: "free" | "premium" | "vip"; reason: string };
  } catch {
    return { tier: "free", reason: "Could not analyse" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. HARMONY DB NATURAL LANGUAGE QUERY
// ─────────────────────────────────────────────────────────────────────────────

export async function queryHarmonyDB(naturalQuestion: string): Promise<string> {
  const url = process.env.EXTERNAL_DB_URL;
  if (!url) return "❌ EXTERNAL_DB_URL not configured.";

  try {
    const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    const client = await pool.connect();

    // Get schema info
    const schemaRes = await client.query(`
      SELECT table_name, string_agg(column_name || ' ' || data_type, ', ') as columns
      FROM information_schema.columns
      WHERE table_schema = 'public'
      GROUP BY table_name ORDER BY table_name
    `);
    const schema = schemaRes.rows
      .map((r: { table_name: string; columns: string }) => `${r.table_name}: ${r.columns}`)
      .join("\n");

    // Generate SQL
    const sqlQuery = await ask(
      `You are a PostgreSQL expert. Given a database schema and a natural language question, write a safe read-only SQL query.\nRules:\n- SELECT only (no INSERT/UPDATE/DELETE/DROP)\n- Return ONLY the SQL query, no explanation, no markdown\n- Use LIMIT 20 for safety\n- If the question can't be answered with the schema, return: SELECT 'Cannot answer this question' as result`,
      `Schema:\n${schema}\n\nQuestion: ${naturalQuestion}`
    );

    const cleanSQL = sqlQuery.replace(/```sql|```/g, "").trim();

    // Safety check
    const forbidden = ["insert", "update", "delete", "drop", "alter", "truncate", "create"];
    if (forbidden.some((w) => cleanSQL.toLowerCase().includes(w))) {
      client.release();
      await pool.end();
      return "⛔ Query blocked — only SELECT queries allowed.";
    }

    const result = await client.query(cleanSQL);
    client.release();
    await pool.end();

    if (result.rows.length === 0) return "📭 Query returned no results.";

    const formatted = result.rows
      .slice(0, 10)
      .map((row: Record<string, unknown>, i) =>
        `*${i + 1}.* ${Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(" | ")}`
      )
      .join("\n");

    return `📊 *Query Results* (${result.rows.length} rows)\n\`\`\`sql\n${cleanSQL}\n\`\`\`\n\n${formatted}`;
  } catch (err) {
    logger.error({ err }, "queryHarmonyDB failed");
    return `❌ Query failed: ${err instanceof Error ? err.message : "Unknown error"}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTER ALL AGENT CALLBACKS & COMMANDS
// ─────────────────────────────────────────────────────────────────────────────

export function registerAIAgentHandlers(bot: MyBot): void {

  // ── /broadcast — Smart broadcast writer ────────────────────────────────────
  bot.command("broadcast", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    const input = ctx.match?.trim();
    if (!input) {
      ctx.session.pendingAction = "ai:broadcast";
      await ctx.reply(
        `📢 *SMART BROADCAST*\n━━━━━━━━━━━━━━━━━━\n\nDescribe what you want to broadcast and I'll write it:\n\n_e.g. "Shop is closed for maintenance today" or "New VPN products added, 20% off"_`,
        { parse_mode: "Markdown" }
      );
      return;
    }
    await handleBroadcastFlow(ctx, bot, input);
  });

  // ── /support — Customer support AI ────────────────────────────────────────
  bot.command("support", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    ctx.session.pendingAction = "ai:support_test";
    await ctx.reply(
      `🎧 *SUPPORT AGENT TEST*\n━━━━━━━━━━━━━━━━━━\n\nSend a customer message to test the AI support response:`,
      { parse_mode: "Markdown" }
    );
  });

  // ── /report — Daily business report ───────────────────────────────────────
  bot.command("report", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    await ctx.reply("📊 _Generating business report..._", { parse_mode: "Markdown" });
    await generateBusinessReport(bot, ctx.from.id);
  });

  // ── /dbquery — Natural language DB query ──────────────────────────────────
  bot.command("dbquery", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    const input = ctx.match?.trim();
    if (!input) {
      ctx.session.pendingAction = "ai:dbquery";
      await ctx.reply(
        `🔍 *HARMONY DB QUERY*\n━━━━━━━━━━━━━━━━━━\n\nAsk a question about Harmony DB in plain English:\n\n_e.g. "How many users signed up this month?" or "Show me the 5 most recent orders"_`,
        { parse_mode: "Markdown" }
      );
      return;
    }
    const thinking = await ctx.reply("🔍 _Querying Harmony DB..._", { parse_mode: "Markdown" });
    const result = await queryHarmonyDB(input);
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(result, { parse_mode: "Markdown" });
  });

  // ── /harmony_report — AI DB health summary ────────────────────────────────
  bot.command("harmony_report", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    await ctx.reply("🩺 _Generating Harmony DB health report..._", { parse_mode: "Markdown" });
    await generateHarmonyHealthSummary(bot, ctx.from.id);
  });

  // ── Callback: AI price bank log ────────────────────────────────────────────
  bot.callbackQuery(/^ai:price_log:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery("💡 Getting AI price...");
    const id = parseInt(ctx.match[1]!);
    const [log] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, id));
    if (!log) { await ctx.reply("❌ Log not found."); return; }

    const price = await priceBankLog(log).catch(() => "N/A");
    await ctx.reply(
      `💡 *AI SUGGESTED PRICE*\n━━━━━━━━━━━━━━━━━━\n\n🏦 ${log.bankName} · ${log.country}\nBalance: ${log.balance ?? "unknown"}\n\n💰 Suggested: *${price}*`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✅ Set This Price", `ai:setprice:${id}:${price.replace(/[$\s]/g, "")}`)
          .text("🔙 Back", "banklogs:main"),
      }
    );
  });

  // ── Callback: Set AI suggested price ──────────────────────────────────────
  bot.callbackQuery(/^ai:setprice:(\d+):(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const id = parseInt(ctx.match[1]!);
    const price = ctx.match[2]!;
    await db.update(bankLogsTable).set({ price }).where(eq(bankLogsTable.id, id));
    await ctx.answerCallbackQuery(`✅ Price set to $${price}`);
    await ctx.editMessageText(
      `✅ *Price Updated*\n\nLog #${id} price set to *$${price}*`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Bank Logs", "banklogs:main") }
    );
  });

  // ── Callback: AI write product description ─────────────────────────────────
  bot.callbackQuery(/^ai:describe:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery("✍️ Writing description...");
    const id = parseInt(ctx.match[1]!);
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, id));
    if (!p) { await ctx.reply("❌ Product not found."); return; }

    const desc = await generateProductDescription(p).catch(() => "Could not generate description.");
    await db.update(productsTable).set({ description: desc, updatedAt: new Date() }).where(eq(productsTable.id, id));
    await ctx.editMessageText(
      `✍️ *AI Description Written*\n━━━━━━━━━━━━━━━━━━\n\n📦 ${p.name}\n\n_${desc}_\n\n✅ Saved to product.`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Products", "hex:products") }
    );
  });

  // ── Callback: AI dispute response ──────────────────────────────────────────
  bot.callbackQuery(/^ai:dispute:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    ctx.session.pendingAction = `ai:dispute_reply:${ctx.match[1]}`;
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `📝 *ORDER DISPUTE*\n━━━━━━━━━━━━━━━━━━\n\nPaste the customer's complaint and I'll draft a reply:`,
      { parse_mode: "Markdown" }
    );
  });

  // ── Callback: AI tier suggestion for access request ────────────────────────
  bot.callbackQuery(/^ai:suggest_tier:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery("🤖 Analysing...");
    const userId = parseInt(ctx.match[1]!);
    const [record] = await db.select().from(accessTable).where(eq(accessTable.userId, userId));
    if (!record?.requestMessage) { await ctx.reply("❌ No request message found."); return; }

    const { tier, reason } = await suggestAccessTier(record.requestMessage);
    const emoji = tier === "vip" ? "👑" : tier === "premium" ? "💎" : "🟢";

    await ctx.reply(
      `🤖 *AI TIER SUGGESTION*\n━━━━━━━━━━━━━━━━━━\n\n${emoji} Suggested: *${tier.toUpperCase()}*\n💬 Reason: _${reason}_`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✅ Approve as Suggested", `access:approve:${userId}:${tier}`)
          .row()
          .text("🟢 Free", `access:approve:${userId}:free`)
          .text("💎 Premium", `access:approve:${userId}:premium`)
          .text("👑 VIP", `access:approve:${userId}:vip`)
          .row()
          .text("🚫 Deny", `access:deny:${userId}`),
      }
    );
  });

  // ── AI-powered user support (non-owner DMs) ────────────────────────────────
  // This hooks into the message middleware — called from menu.ts
}

// ── Input processor (called from menu.ts interceptor) ─────────────────────────

export async function processAIAgentInput(bot: MyBot, ctx: BotContext, action: string, text: string): Promise<void> {
  const userId = ctx.from!.id;

  // Broadcast flow
  if (action === "ai:broadcast") {
    await handleBroadcastFlow(ctx, bot, text);
    return;
  }

  // Support test
  if (action === "ai:support_test") {
    const products = await db.select().from(productsTable).where(eq(productsTable.isActive, true)).limit(20);
    const productList = products.map((p) => `- ${p.name} ($${p.price}): ${p.description ?? "no description"}`).join("\n");
    const thinking = await ctx.reply("🎧 _Support agent thinking..._", { parse_mode: "Markdown" });
    const reply = await handleSupportMessage(text, productList).catch(() => "Service unavailable.");
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(`🎧 *AI Support Response:*\n\n${reply}`, { parse_mode: "Markdown" });
    return;
  }

  // DB query
  if (action === "ai:dbquery") {
    const thinking = await ctx.reply("🔍 _Querying..._", { parse_mode: "Markdown" });
    const result = await queryHarmonyDB(text);
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(result, { parse_mode: "Markdown" });
    return;
  }

  // Order dispute reply
  if (action.startsWith("ai:dispute_reply:")) {
    const orderId = parseInt(action.split(":")[2] ?? "0");
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    const [product] = order ? await db.select().from(productsTable).where(eq(productsTable.id, order.productId)) : [null];

    const reply = await handleOrderDispute({
      orderId,
      productName: product?.name ?? "Unknown Product",
      customerMessage: text,
      orderStatus: order?.status ?? "unknown",
    }).catch(() => "Could not generate response.");

    await ctx.reply(
      `📝 *AI DISPUTE RESPONSE*\n━━━━━━━━━━━━━━━━━━\n\n${reply}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("📤 Send to Customer", `ai:send_dispute:${orderId}`)
          .text("✏️ Edit First", `ai:edit_dispute:${orderId}`),
      }
    );
    ctx.session["disputeReply"] = reply;
    return;
  }
}

// ── Auto customer support for non-owner users ──────────────────────────────────

export async function handleUserSupportMessage(bot: MyBot, ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  const text = ctx.message?.text;
  if (!userId || !text || isOwner(userId)) return;

  // Only respond in private chats to approved users
  if (ctx.chat?.type !== "private") return;

  try {
    const products = await db.select().from(productsTable).where(eq(productsTable.isActive, true)).limit(20);
    const productList = products.map((p) => `- ${p.name} ($${p.price}): ${p.description ?? ""}`).join("\n");
    const reply = await handleSupportMessage(text, productList);
    await ctx.reply(reply, {
      reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main").text("📞 Contact Admin", "menu:help"),
    });
  } catch {
    // Silent fail — don't break non-AI flows
  }
}

// ── Broadcast helper ───────────────────────────────────────────────────────────

async function handleBroadcastFlow(ctx: BotContext, bot: MyBot, intent: string): Promise<void> {
  const thinking = await ctx.reply("✍️ _Writing broadcast..._", { parse_mode: "Markdown" });
  try {
    const message = await writeBroadcast(intent);
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    ctx.session["pendingBroadcast"] = message;

    await ctx.reply(
      `📢 *BROADCAST PREVIEW*\n━━━━━━━━━━━━━━━━━━\n\n${message}\n\n━━━━━━━━━━━━━━━━━━\n_Send to all users?_`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("📤 Send Now", "ai:broadcast:confirm")
          .text("✏️ Rewrite", "ai:broadcast:rewrite")
          .text("❌ Cancel", "menu:main"),
      }
    );
  } catch (err) {
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(`❌ Failed: ${err instanceof Error ? err.message : "Unknown"}`);
  }
}
