import { InlineKeyboard } from "grammy";
import {
  db,
  usersTable,
  ordersTable,
  productsTable,
  paymentRequestsTable,
  accessTable,
  pool,
} from "@workspace/db";
import { eq, count } from "drizzle-orm";
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
  try {
    const accessRows = await db.select().from(accessTable);
    approved = accessRows.filter((r) => r.isApproved && r.tier !== "blocked").length;
  } catch { /* ignore */ }

  const kill = getKillStatus();
  const uptimeH = (process.uptime() / 3600).toFixed(1);

  return (
    `🎛️ ADMIN CONTROL\n━━━━━━━━━━━━━━━━━━\n` +
    `Status: ${kill.killed ? "⛔ KILLED" : "✅ LIVE"}\n` +
    `Uptime: ${uptimeH}h\n` +
    `Gmail OAuth app: ${isGmailOAuthAppConfigured() ? "configured" : "NOT set"}\n\n` +
    `👥 Users — Registered: ${userCount?.n ?? 0} | Approved: ${approved}\n` +
    `📦 Products: ${activeProducts?.n ?? 0} active / ${totalProducts?.n ?? 0} total\n` +
    `📋 Orders — P:${pendingOrders?.n ?? 0} Cl:${claimedOrders?.n ?? 0} Co:${confirmedOrders?.n ?? 0} Ca:${cancelledOrders?.n ?? 0} T:${totalOrders?.n ?? 0}`
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
    const msg = (typeof ctx.match === "string" ? ctx.match.trim() : "") || "";
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

  bot.command("announce", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner-only command.");
      return;
    }
    const raw =
      (typeof ctx.match === "string" ? ctx.match.trim() : "") ||
      (ctx.message?.text ?? "").replace(/^\/announce(@\w+)?\s*/i, "").trim();
    if (!raw) {
      await ctx.reply(
        "🆕 ANNOUNCE UPDATE\n━━━━━━━━━━━━━━━━━━\n\n" +
          "After you ship features, push a note to every user.\n\n" +
          "Usage:\n/announce Short title | Full details\n\n" +
          "Example:\n/announce Image gen | /imagine uses FLUX. Run /updates anytime.\n\n" +
          "Users can re-read with /updates.",
      );
      return;
    }
    let title = "Crescent update";
    let body = raw;
    if (raw.includes("|")) {
      const parts = raw.split("|");
      title = parts[0]!.trim() || title;
      body = parts.slice(1).join("|").trim() || raw;
    }
    try {
      await pool.query(
        `INSERT INTO bot_announcements (title, body, created_by) VALUES ($1, $2, $3)`,
        [title.slice(0, 120), body.slice(0, 3500), ctx.from.id],
      );
    } catch (err) {
      logger.error({ err }, "announce insert failed");
      await ctx.reply("❌ Could not save announcement. Wait for migrate/deploy, then retry.");
      return;
    }
    const plain =
      `🆕 CRESCENT UPDATE\n━━━━━━━━━━━━━━━━━━\n\n` +
      `${title}\n\n` +
      `${body.slice(0, 3000)}\n\n` +
      `See all recent changes: /updates`;
    const users = await db.select({ id: usersTable.id }).from(usersTable).catch(() => []);
    const accessUsers = await db.select({ userId: accessTable.userId }).from(accessTable).catch(() => []);
    const ids = new Set<number>();
    for (const u of users) ids.add(Number(u.id));
    for (const a of accessUsers) ids.add(Number(a.userId));
    ids.delete(ctx.from.id);
    if (ids.size === 0) {
      await ctx.reply("✅ Announcement saved. No other users to notify yet.\nThey can still use /updates.");
      return;
    }
    const statusMsg = await ctx.reply(`🆕 Announcing to ${ids.size} users...`);
    let sent = 0;
    let failed = 0;
    for (const uid of ids) {
      try {
        await ctx.api.sendMessage(uid, plain);
        sent++;
      } catch {
        failed++;
      }
      if ((sent + failed) % 20 === 0) await new Promise((r) => setTimeout(r, 1000));
    }
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        statusMsg.message_id,
        `🆕 ANNOUNCE COMPLETE\n━━━━━━━━━━━━━━━━━━\n\n✅ Sent: ${sent}\n❌ Failed: ${failed}\n📌 Saved for /updates`,
      )
      .catch(() => {});
  });

  bot.command("updates", async (ctx) => {
    try {
      const res = await pool.query(
        `SELECT title, body, created_at FROM bot_announcements ORDER BY id DESC LIMIT 5`,
      );
      const rows = res.rows as Array<{ title: string | null; body: string; created_at: Date }>;
      if (!rows.length) {
        await ctx.reply(
          "🆕 UPDATES\n━━━━━━━━━━━━━━━━━━\n\nNo published updates yet.\nThe owner posts them with /announce after shipping features.",
        );
        return;
      }
      let text = "🆕 CRESCENT UPDATES\n━━━━━━━━━━━━━━━━━━\n\n";
      for (const r of rows) {
        const when = r.created_at
          ? new Date(r.created_at).toLocaleString("en-KE", {
              timeZone: "Africa/Nairobi",
              dateStyle: "medium",
              timeStyle: "short",
            })
          : "";
        text += `• ${r.title || "Update"} — ${when}\n${(r.body || "").slice(0, 400)}\n\n`;
      }
      text += "You'll also get a DM when a new update is announced.";
      await ctx.reply(text.slice(0, 4000));
    } catch (err) {
      logger.error({ err }, "updates command failed");
      await ctx.reply("❌ Could not load updates right now.");
    }
  });
}
