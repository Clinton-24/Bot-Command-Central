import { InlineKeyboard } from "grammy";
import {
  db,
  usersTable,
  ordersTable,
  productsTable,
  paymentRequestsTable,
  accessTable,
} from "@workspace/db";
import { eq, count } from "drizzle-orm";
import { pool } from "@workspace/db";
import type { MyBot } from "../index";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";
import { getKillStatus, activateKill, deactivateKill } from "./kill";
import { isGmailOAuthAppConfigured } from "../../lib/gmail";

async function buildAnalyticsText(): Promise<string> {
  const [
    [userCount],
    [totalOrders],
    [pendingOrders],
    [claimedOrders],
    [confirmedOrders],
    [cancelledOrders],
    [activeProducts],
    [totalProducts],
  ] = await Promise.all([
    db.select({ n: count() }).from(usersTable),
    db.select({ n: count() }).from(ordersTable),
    db.select({ n: count() }).from(ordersTable).where(eq(ordersTable.status, "pending")),
    db.select({ n: count() }).from(ordersTable).where(eq(ordersTable.status, "claimed")),
    db.select({ n: count() }).from(ordersTable).where(eq(ordersTable.status, "confirmed")),
    db.select({ n: count() }).from(ordersTable).where(eq(ordersTable.status, "cancelled")),
    db.select({ n: count() }).from(productsTable).where(eq(productsTable.isActive, true)),
    db.select({ n: count() }).from(productsTable),
  ]);

  let approved = 0;
  let gmailLinked = 0;
  let pendingReminders = 0;
  let aiMemory = 0;

  try {
    const accessRows = await db.select().from(accessTable);
    approved = accessRows.filter((r) => r.isApproved && r.tier !== "blocked").length;
  } catch {
    /* ignore */
  }

  try {
    const g = await pool.query(`SELECT COUNT(*)::int AS n FROM user_gmail_tokens`);
    gmailLinked = g.rows[0]?.n ?? 0;
  } catch {
    /* ignore */
  }
  try {
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM bot_reminders WHERE sent_at IS NULL`);
    pendingReminders = r.rows[0]?.n ?? 0;
  } catch {
    /* ignore */
  }
  try {
    const m = await pool.query(`SELECT COUNT(*)::int AS n FROM ai_memory`);
    aiMemory = m.rows[0]?.n ?? 0;
  } catch {
    /* ignore */
  }

  const confirmedPayments = await db
    .select({ amount: paymentRequestsTable.amount, coin: paymentRequestsTable.coin })
    .from(paymentRequestsTable)
    .where(eq(paymentRequestsTable.status, "confirmed"))
    .catch(() => []);

  const revenueMap: Record<string, number> = {};
  for (const p of confirmedPayments) {
    revenueMap[p.coin] = (revenueMap[p.coin] ?? 0) + parseFloat(String(p.amount));
  }
  const revenueLines =
    Object.entries(revenueMap)
      .map(([coin, amt]) => `   • ${coin}: ${amt.toFixed(2)}`)
      .join("\n") || "   None yet";

  const kill = getKillStatus();
  const uptimeH = (process.uptime() / 3600).toFixed(1);

  return (
    `🎛️ ADMIN CONTROL\n━━━━━━━━━━━━━━━━━━\n` +
    `Status: ${kill.killed ? "⛔ KILLED" : "✅ LIVE"}\n` +
    `Uptime: ${uptimeH}h\n` +
    `Gmail OAuth app: ${isGmailOAuthAppConfigured() ? "configured" : "NOT set"}\n\n` +
    `👥 Users\n` +
    `   Registered: ${userCount?.n ?? 0}\n` +
    `   Approved access: ${approved}\n` +
    `   Gmail linked: ${gmailLinked}\n\n` +
    `📦 Products: ${activeProducts?.n ?? 0} active / ${totalProducts?.n ?? 0} total\n\n` +
    `📋 Orders\n` +
    `   Pending: ${pendingOrders?.n ?? 0} | Claimed: ${claimedOrders?.n ?? 0}\n` +
    `   Confirmed: ${confirmedOrders?.n ?? 0} | Cancelled: ${cancelledOrders?.n ?? 0}\n` +
    `   Total: ${totalOrders?.n ?? 0}\n\n` +
    `⏰ Pending reminders: ${pendingReminders}\n` +
    `🧠 AI memory rows: ${aiMemory}\n\n` +
    `💰 Revenue (confirmed)\n${revenueLines}`
  );
}

function adminKeyboard() {
  const kill = getKillStatus();
  return new InlineKeyboard()
    .text("📊 Refresh analytics", "admin:analytics")
    .row()
    .text(kill.killed ? "✅ Unkill (go live)" : "🛑 Soft kill", kill.killed ? "admin:unkill" : "admin:kill")
    .text("☠️ Hard kill", "admin:killhard")
    .row()
    .text("🔮 Hex Panel", "hex:main")
    .text("📋 Orders", "hex:orders");
}

export function registerOwnerHandlers(bot: MyBot): void {
  bot.command("admin", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner-only command.");
      return;
    }
    try {
      const text = await buildAnalyticsText();
      await ctx.reply(text, { reply_markup: adminKeyboard() });
    } catch (err) {
      logger.error({ err }, "admin panel error");
      await ctx.reply("❌ Failed to load admin panel.");
    }
  });

  bot.callbackQuery("admin:analytics", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      const text = await buildAnalyticsText();
      await ctx.editMessageText(text, { reply_markup: adminKeyboard() });
    } catch (err) {
      logger.error({ err }, "admin analytics refresh");
      await ctx.reply("❌ Refresh failed.");
    }
  });

  bot.callbackQuery("admin:kill", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    activateKill(`admin:${ctx.from.id}`);
    await ctx.answerCallbackQuery("Killed");
    const text = await buildAnalyticsText();
    await ctx.editMessageText(text, { reply_markup: adminKeyboard() });
  });

  bot.callbackQuery("admin:unkill", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    deactivateKill();
    await ctx.answerCallbackQuery("Live again");
    const text = await buildAnalyticsText();
    await ctx.editMessageText(text, { reply_markup: adminKeyboard() });
  });

  bot.callbackQuery("admin:killhard", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    activateKill(`hard:${ctx.from.id}`);
    await ctx.answerCallbackQuery("Exiting…");
    await ctx.editMessageText("☠️ Hard kill — process exiting in 2s (Render may restart).");
    logger.error({ by: ctx.from.id }, "HARD KILL from /admin");
    setTimeout(() => process.exit(1), 2000);
  });

  bot.command("broadcast", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner-only command.");
      return;
    }

    const msg = ctx.match?.trim();
    if (!msg) {
      await ctx.reply("📢 Broadcast\n━━━━━━━━━━━━━━━━━━\n\nUsage: /broadcast [message]");
      return;
    }

    const users = await db.select({ id: usersTable.id }).from(usersTable).catch(() => []);
    if (users.length === 0) {
      await ctx.reply("⚠️ No users registered yet.");
      return;
    }

    const statusMsg = await ctx.reply(`📢 Broadcasting to ${users.length} users...`);
    let sent = 0;
    let failed = 0;

    for (const user of users) {
      try {
        await ctx.api.sendMessage(user.id, `📢 MESSAGE FROM ADMIN\n━━━━━━━━━━━━━━━━━━\n\n${msg}`);
        sent++;
      } catch {
        failed++;
      }
      if (sent % 20 === 0) await new Promise((r) => setTimeout(r, 1000));
    }

    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `📢 BROADCAST COMPLETE\n━━━━━━━━━━━━━━━━━━\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}\n📊 Total: ${users.length}`,
      )
      .catch(() => {});
  });

  bot.command("stats", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner-only command.");
      return;
    }
    try {
      const text = await buildAnalyticsText();
      await ctx.reply(text, { reply_markup: adminKeyboard() });
    } catch (err) {
      logger.error({ err }, "stats command error");
      await ctx.reply("❌ Failed to fetch stats.");
    }
  });
}
