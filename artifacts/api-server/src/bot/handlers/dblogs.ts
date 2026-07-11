/**
 * BANK LOGS — Bank Login Listings Panel
 * ──────────────────────────────────────
 * Owner-only panel to manage, add, view, and track bank login listings.
 * Nothing to do with database health — that's in extdblogs.ts (Harmony DB).
 */

import { InlineKeyboard } from "grammy";
import { eq, desc, and } from "drizzle-orm";
import { db, bankLogsTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

// ── Keyboards ─────────────────────────────────────────────────────────────────

function bankLogsMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Add Log", "banklogs:add")
    .text("📋 All Logs", "banklogs:list:all")
    .row()
    .text("✅ Available", "banklogs:list:available")
    .text("💸 Sold", "banklogs:list:sold")
    .row()
    .text("🔍 Check Log", "banklogs:check")
    .text("🗑️ Delete Log", "banklogs:delete")
    .row()
    .text("📊 Stats", "banklogs:stats")
    .row()
    .text("🏠 Main Menu", "menu:main");
}

function backKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🔙 Bank Logs", "banklogs:main");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatLog(log: { id: number; bankName: string; country: string; accountType: string; balance?: string | null; price?: string | null; status: string; addedAt: Date }): string {
  const statusEmoji = log.status === "available" ? "🟢" : log.status === "sold" ? "🔴" : log.status === "checked" ? "🟡" : "⚫";
  return `${statusEmoji} *#${log.id}* — ${log.bankName} · ${log.country}\n` +
    `   Type: ${log.accountType}${log.balance ? ` · Bal: ${log.balance}` : ""}${log.price ? ` · $${log.price}` : ""}\n` +
    `   Added: ${log.addedAt.toDateString()}`;
}

// ── Register ──────────────────────────────────────────────────────────────────

export function registerDbLogsHandlers(bot: MyBot): void {
  bot.command("banklogs", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.reply("⛔ Owner only."); return; }
    await showMain(ctx);
  });
}

async function showMain(ctx: BotContext): Promise<void> {
  try {
    const total = await db.select().from(bankLogsTable);
    const available = total.filter((l) => l.status === "available").length;
    const sold = total.filter((l) => l.isSold).length;

    await ctx.reply(
      `🏦 *BANK LOGS PANEL*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `📦 Total: *${total.length}* logs\n` +
      `🟢 Available: *${available}*\n` +
      `🔴 Sold: *${sold}*\n\n` +
      `_Manage your bank login listings below:_`,
      { parse_mode: "Markdown", reply_markup: bankLogsMainKeyboard() }
    );
  } catch (err) {
    await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : "Unknown"}`);
  }
}

export function registerDbLogsCallbacks(bot: MyBot): void {
  // Main panel
  bot.callbackQuery("dblogs:main", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    try {
      const total = await db.select().from(bankLogsTable);
      const available = total.filter((l) => l.status === "available").length;
      const sold = total.filter((l) => l.isSold).length;
      await ctx.editMessageText(
        `🏦 *BANK LOGS PANEL*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `📦 Total: *${total.length}* logs\n🟢 Available: *${available}*\n🔴 Sold: *${sold}*\n\n_Manage your bank login listings:_`,
        { parse_mode: "Markdown", reply_markup: bankLogsMainKeyboard() }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  bot.callbackQuery("banklogs:main", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    try {
      const total = await db.select().from(bankLogsTable);
      const available = total.filter((l) => l.status === "available").length;
      const sold = total.filter((l) => l.isSold).length;
      await ctx.editMessageText(
        `🏦 *BANK LOGS PANEL*\n━━━━━━━━━━━━━━━━━━\n\n📦 Total: *${total.length}* · 🟢 *${available}* available · 🔴 *${sold}* sold\n\n_Select an action:_`,
        { parse_mode: "Markdown", reply_markup: bankLogsMainKeyboard() }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  // Add log — prompts for input
  bot.callbackQuery("banklogs:add", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    ctx.session.pendingAction = "banklogs:add";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `➕ *ADD BANK LOG*\n━━━━━━━━━━━━━━━━━━\n\nSend the log in this format:\n\n\`BANK | COUNTRY | TYPE | BALANCE | PRICE | URL | USER | PASS | EXTRAS | NOTES\`\n\nExample:\n\`Chase | US | Checking | $12,500 | 150 | chase.com | john@email.com | Pass123! | DOB:1990-01-01 | Fresh log\`\n\n_Fields: Bank, Country, Type, Balance, Price($), URL, Username, Password, Extras, Notes_`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("❌ Cancel", "banklogs:main") }
    );
  });

  // List by status
  bot.callbackQuery(/^banklogs:list:(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    try {
      const filter = ctx.match[1] as string;
      const logs = filter === "all"
        ? await db.select().from(bankLogsTable).orderBy(desc(bankLogsTable.addedAt)).limit(20)
        : await db.select().from(bankLogsTable).where(eq(bankLogsTable.status, filter)).orderBy(desc(bankLogsTable.addedAt)).limit(20);

      const title = filter === "all" ? "📋 ALL LOGS" : filter === "available" ? "🟢 AVAILABLE LOGS" : "🔴 SOLD LOGS";
      const lines = logs.length === 0
        ? "_No logs found._"
        : logs.map(formatLog).join("\n\n");

      await ctx.editMessageText(
        `🏦 *${title}*\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
        { parse_mode: "Markdown", reply_markup: backKeyboard() }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  // Check / mark sold
  bot.callbackQuery("banklogs:check", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    ctx.session.pendingAction = "banklogs:check";
    await ctx.answerCallbackQuery();
    await ctx.reply("🔍 *CHECK LOG*\n\nSend the Log ID to view full details or mark as sold:\n\n_Format: `<id>` or `<id> sold`_", { parse_mode: "Markdown" });
  });

  // Delete
  bot.callbackQuery("banklogs:delete", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    ctx.session.pendingAction = "banklogs:delete";
    await ctx.answerCallbackQuery();
    await ctx.reply("🗑️ *DELETE LOG*\n\nSend the Log ID to permanently delete it:\n\n_Format: `<id>`_", { parse_mode: "Markdown" });
  });

  // Stats
  bot.callbackQuery("banklogs:stats", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    try {
      const all = await db.select().from(bankLogsTable);
      const available = all.filter((l) => l.status === "available");
      const sold = all.filter((l) => l.isSold);
      const countries = [...new Set(all.map((l) => l.country))];
      const banks = [...new Set(all.map((l) => l.bankName))];

      // Revenue estimate
      const revenue = sold.reduce((sum, l) => sum + (parseFloat(l.price ?? "0") || 0), 0);
      const potential = available.reduce((sum, l) => sum + (parseFloat(l.price ?? "0") || 0), 0);

      await ctx.editMessageText(
        `📊 *BANK LOGS STATS*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `📦 Total logs: *${all.length}*\n` +
        `🟢 Available: *${available.length}*\n` +
        `🔴 Sold: *${sold.length}*\n\n` +
        `🌍 Countries: *${countries.length}* (${countries.slice(0, 5).join(", ")})\n` +
        `🏦 Banks: *${banks.length}* (${banks.slice(0, 5).join(", ")})\n\n` +
        `💰 Revenue: *$${revenue.toFixed(2)}*\n` +
        `📈 Potential: *$${potential.toFixed(2)}*`,
        { parse_mode: "Markdown", reply_markup: backKeyboard() }
      );
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });
}

// ── Input processor (called from menu.ts interceptor) ────────────────────────

export async function processBankLogInput(ctx: BotContext, action: string, text: string): Promise<void> {
  if (action === "banklogs:add") {
    try {
      const parts = text.split("|").map((p) => p.trim());
      if (parts.length < 2) {
        await ctx.reply("❌ Invalid format. Need at least: `BANK | COUNTRY`", { parse_mode: "Markdown" });
        return;
      }
      const [bankName = "", country = "", accountType = "checking", balance, price, loginUrl, username, password, extras, notes] = parts;
      await db.insert(bankLogsTable).values({
        bankName, country, accountType,
        balance: balance ?? null,
        price: price ?? null,
        loginUrl: loginUrl ?? null,
        username: username ?? null,
        password: password ?? null,
        extras: extras ?? null,
        notes: notes ?? null,
        status: "available",
      });
      await ctx.reply(`✅ *Log added successfully!*\n\n🏦 ${bankName} · ${country} · ${accountType}${balance ? `\n💰 Balance: ${balance}` : ""}${price ? `\n💵 Price: $${price}` : ""}`, { parse_mode: "Markdown", reply_markup: bankLogsMainKeyboard() });
    } catch (err) {
      await ctx.reply(`❌ Failed to add log: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  } else if (action === "banklogs:check") {
    try {
      const parts = text.trim().split(/\s+/);
      const id = parseInt(parts[0] ?? "");
      const markSold = parts[1]?.toLowerCase() === "sold";

      if (isNaN(id)) { await ctx.reply("❌ Invalid ID."); return; }

      const [log] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, id));
      if (!log) { await ctx.reply(`❌ Log #${id} not found.`); return; }

      if (markSold) {
        await db.update(bankLogsTable).set({ status: "sold", isSold: true, soldAt: new Date() }).where(eq(bankLogsTable.id, id));
        await ctx.reply(`🔴 Log #${id} marked as *SOLD*.`, { parse_mode: "Markdown" });
        return;
      }

      const details =
        `🏦 *LOG #${log.id} DETAILS*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Bank: *${log.bankName}*\nCountry: *${log.country}*\nType: *${log.accountType}*\n` +
        (log.balance ? `Balance: *${log.balance}*\n` : "") +
        (log.price ? `Price: *$${log.price}*\n` : "") +
        `Status: *${log.status}*\n\n` +
        (log.loginUrl ? `🔗 URL: \`${log.loginUrl}\`\n` : "") +
        (log.username ? `👤 User: \`${log.username}\`\n` : "") +
        (log.password ? `🔑 Pass: \`${log.password}\`\n` : "") +
        (log.extras ? `📝 Extras: ${log.extras}\n` : "") +
        (log.notes ? `💬 Notes: ${log.notes}\n` : "") +
        `\n📅 Added: ${log.addedAt.toDateString()}`;

      const kb = new InlineKeyboard();
      if (log.status !== "sold") kb.text("🔴 Mark Sold", `banklogs:marksold:${id}`).row();
      kb.text("🗑️ Delete", `banklogs:confirmdelete:${id}`).text("🔙 Back", "banklogs:main");

      await ctx.reply(details, { parse_mode: "Markdown", reply_markup: kb });
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  } else if (action === "banklogs:delete") {
    try {
      const id = parseInt(text.trim());
      if (isNaN(id)) { await ctx.reply("❌ Invalid ID."); return; }
      await db.delete(bankLogsTable).where(eq(bankLogsTable.id, id));
      await ctx.reply(`🗑️ Log #${id} deleted.`, { reply_markup: bankLogsMainKeyboard() });
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  }
}
