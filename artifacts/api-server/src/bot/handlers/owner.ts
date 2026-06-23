import { InlineKeyboard } from "grammy";
import {
  db,
  usersTable,
  ordersTable,
  productsTable,
  paymentRequestsTable,
} from "@workspace/db";
import { eq, count } from "drizzle-orm";
import type { MyBot } from "../index";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

export function registerOwnerHandlers(bot: MyBot): void {
  // ── /broadcast ────────────────────────────────────────────────────────────
  bot.command("broadcast", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner-only command.");
      return;
    }

    const msg = ctx.match?.trim();
    if (!msg) {
      await ctx.reply(
        "📢 *Broadcast*\n━━━━━━━━━━━━━━━━━━\n\nUsage: /broadcast [message]\n\nYour message will be sent to all registered users.",
        { parse_mode: "Markdown" }
      );
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
        await ctx.api.sendMessage(
          user.id,
          `📢 *MESSAGE FROM ADMIN*\n━━━━━━━━━━━━━━━━━━\n\n${msg}`,
          { parse_mode: "Markdown" }
        );
        sent++;
      } catch {
        failed++;
      }
      // Rate limit: 20 messages/sec max
      if (sent % 20 === 0) await new Promise((r) => setTimeout(r, 1000));
    }

    await ctx.api
      .editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        `📢 *BROADCAST COMPLETE*\n━━━━━━━━━━━━━━━━━━\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}\n📊 Total: ${users.length}`,
        { parse_mode: "Markdown" }
      )
      .catch(() => {});
  });

  // ── /stats ─────────────────────────────────────────────────────────────────
  bot.command("stats", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner-only command.");
      return;
    }

    try {
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

      // Revenue from confirmed payments
      const confirmedPayments = await db
        .select({ amount: paymentRequestsTable.amount, coin: paymentRequestsTable.coin })
        .from(paymentRequestsTable)
        .where(eq(paymentRequestsTable.status, "confirmed"));

      const revenueMap: Record<string, number> = {};
      for (const p of confirmedPayments) {
        revenueMap[p.coin] = (revenueMap[p.coin] ?? 0) + parseFloat(p.amount);
      }
      const revenueLines =
        Object.entries(revenueMap)
          .map(([coin, amt]) => `   • ${coin}: ${amt.toFixed(2)}`)
          .join("\n") || "   None yet";

      await ctx.reply(
        `📊 *BOT STATISTICS*\n━━━━━━━━━━━━━━━━━━\n\n` +
          `👥 *Users*\n` +
          `   Total registered: ${userCount?.n ?? 0}\n\n` +
          `📦 *Products*\n` +
          `   Active: ${activeProducts?.n ?? 0} / ${totalProducts?.n ?? 0}\n\n` +
          `📋 *Orders*\n` +
          `   ⏳ Pending: ${pendingOrders?.n ?? 0}\n` +
          `   🔔 Claimed: ${claimedOrders?.n ?? 0}\n` +
          `   ✅ Confirmed: ${confirmedOrders?.n ?? 0}\n` +
          `   ❌ Cancelled: ${cancelledOrders?.n ?? 0}\n` +
          `   📊 Total: ${totalOrders?.n ?? 0}\n\n` +
          `💰 *Revenue (confirmed)*\n${revenueLines}`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("🔮 Hex Panel", "hex:main")
            .text("📋 Orders", "hex:orders"),
        }
      );
    } catch (err) {
      logger.error({ err }, "stats command error");
      await ctx.reply("❌ Failed to fetch stats.");
    }
  });
}
