/**
 * BANK LOGS — Bank Login Listings Panel
 */
import { InlineKeyboard } from "grammy";
import { eq, desc } from "drizzle-orm";
import { db, bankLogsTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { canAccessFeature } from "./subscription";

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

function formatLog(log: {
  id: number;
  bankName: string;
  country: string;
  accountType: string;
  balance?: string | null;
  price?: string | null;
  status: string;
  addedAt: Date;
}): string {
  const statusEmoji =
    log.status === "available" ? "🟢" : log.status === "sold" ? "🔴" : log.status === "checked" ? "🟡" : "⚫";
  return (
    `${statusEmoji} #${log.id} — ${log.bankName} · ${log.country}\n` +
    `   Type: ${log.accountType}${log.balance ? ` · Bal: ${log.balance}` : ""}${log.price ? ` · $${log.price}` : ""}\n` +
    `   Added: ${log.addedAt.toDateString()}`
  );
}

export function registerDbLogsHandlers(bot: MyBot): void {
  bot.command("banklogs", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner only.");
      return;
    }
    await showMain(ctx);
  });
}

async function showMain(ctx: BotContext): Promise<void> {
  try {
    const total = await db.select().from(bankLogsTable);
    const available = total.filter((l) => l.status === "available").length;
    const sold = total.filter((l) => l.isSold).length;
    await ctx.reply(
      `🏦 BANK LOGS PANEL\n━━━━━━━━━━━━━━━━━━\n\n` +
        `📦 Total: ${total.length} logs\n` +
        `🟢 Available: ${available}\n` +
        `🔴 Sold: ${sold}\n\n` +
        `Manage your bank login listings below:`,
      { reply_markup: bankLogsMainKeyboard() },
    );
  } catch (err) {
    await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : "Unknown"}`);
  }
}

export function registerDbLogsCallbacks(bot: MyBot): void {
  bot.callbackQuery("dblogs:main", async (ctx) => {
    if (!ctx.from) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    if (!isOwner(ctx.from.id)) {
      const ok = await canAccessFeature(ctx.from.id, "bank_logs");
      if (!ok) {
        await ctx.answerCallbackQuery("💎 Premium+ required");
        await ctx.reply("🔒 Bank Logs requires Premium or VIP.\n\nUpgrade to access:", {
          reply_markup: new InlineKeyboard().text("💎 Upgrade", "sub:panel"),
        });
        return;
      }
    }
    await ctx.answerCallbackQuery();
    try {
      const total = await db.select().from(bankLogsTable);
      const available = total.filter((l) => l.status === "available").length;
      const sold = total.filter((l) => l.isSold).length;
      await ctx.editMessageText(
        `🏦 BANK LOGS PANEL\n━━━━━━━━━━━━━━━━━━\n\n` +
          `📦 Total: ${total.length} logs\n🟢 Available: ${available}\n🔴 Sold: ${sold}\n\nManage listings:`,
        { reply_markup: bankLogsMainKeyboard() },
      );
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  bot.callbackQuery("banklogs:main", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    ctx.session.pendingAction = undefined;
    await ctx.answerCallbackQuery();
    try {
      const total = await db.select().from(bankLogsTable);
      const available = total.filter((l) => l.status === "available").length;
      const sold = total.filter((l) => l.isSold).length;
      await ctx.editMessageText(
        `🏦 BANK LOGS PANEL\n━━━━━━━━━━━━━━━━━━\n\n📦 Total: ${total.length} · 🟢 ${available} available · 🔴 ${sold} sold\n\nSelect an action:`,
        { reply_markup: bankLogsMainKeyboard() },
      );
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  bot.callbackQuery("banklogs:add", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    ctx.session.pendingAction = "banklogs:add";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `➕ ADD BANK LOG\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Send ONE log per message in this format:\n\n` +
        `BANK | COUNTRY | TYPE | BALANCE | PRICE | URL | USER | PASS | EXTRAS | NOTES\n\n` +
        `Example:\n` +
        `Chase | US | Checking | $12,500 | 150 | chase.com | john@email.com | Pass123! | DOB:1990-01-01 | Fresh log\n\n` +
        `Fields (in order):\n` +
        `1. Bank name (required)\n` +
        `2. Country (required)\n` +
        `3. Type — Checking / Savings / Business\n` +
        `4. Balance\n` +
        `5. Price in $ (required, e.g. 150)\n` +
        `6. Login URL\n` +
        `7. Username\n` +
        `8. Password\n` +
        `9. Extras (DOB, SSN, etc.)\n` +
        `10. Notes\n\n` +
        `Send one line. After it saves you can send the next log the same way.\n` +
        `Type /done when finished.`,
      { reply_markup: new InlineKeyboard().text("❌ Cancel", "banklogs:main") },
    );
  });

  bot.callbackQuery(/^banklogs:list:(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      const filter = ctx.match[1] as string;
      const logs =
        filter === "all"
          ? await db.select().from(bankLogsTable).orderBy(desc(bankLogsTable.addedAt)).limit(20)
          : await db
              .select()
              .from(bankLogsTable)
              .where(eq(bankLogsTable.status, filter))
              .orderBy(desc(bankLogsTable.addedAt))
              .limit(20);
      const title =
        filter === "all" ? "📋 ALL LOGS" : filter === "available" ? "🟢 AVAILABLE LOGS" : "🔴 SOLD LOGS";
      const lines = logs.length === 0 ? "No logs found." : logs.map(formatLog).join("\n\n");
      await ctx.editMessageText(`🏦 ${title}\n━━━━━━━━━━━━━━━━━━\n\n${lines}`, {
        reply_markup: backKeyboard(),
      });
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  bot.callbackQuery("banklogs:check", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    ctx.session.pendingAction = "banklogs:check";
    await ctx.answerCallbackQuery();
    await ctx.reply("🔍 CHECK LOG\n\nSend the Log ID:\n\nFormat: <id> or <id> sold");
  });

  bot.callbackQuery("banklogs:delete", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    ctx.session.pendingAction = "banklogs:delete";
    await ctx.answerCallbackQuery();
    await ctx.reply("🗑️ DELETE LOG\n\nSend the Log ID to permanently delete it.");
  });

  bot.callbackQuery("banklogs:stats", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      const all = await db.select().from(bankLogsTable);
      const available = all.filter((l) => l.status === "available");
      const sold = all.filter((l) => l.isSold);
      const countries = [...new Set(all.map((l) => l.country))];
      const banks = [...new Set(all.map((l) => l.bankName))];
      const revenue = sold.reduce((sum, l) => sum + (parseFloat(l.price ?? "0") || 0), 0);
      const potential = available.reduce((sum, l) => sum + (parseFloat(l.price ?? "0") || 0), 0);
      await ctx.editMessageText(
        `📊 BANK LOGS STATS\n━━━━━━━━━━━━━━━━━━\n\n` +
          `📦 Total: ${all.length}\n🟢 Available: ${available.length}\n🔴 Sold: ${sold.length}\n\n` +
          `🌍 Countries: ${countries.length}\n🏦 Banks: ${banks.length}\n\n` +
          `💰 Revenue: $${revenue.toFixed(2)}\n📈 Potential: $${potential.toFixed(2)}`,
        { reply_markup: backKeyboard() },
      );
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });
}

export async function processBankLogInput(ctx: BotContext, action: string, text: string): Promise<void> {
  if (action === "banklogs:add") {
    try {
      if (text.trim().toLowerCase() === "/done" || text.trim().toLowerCase() === "done") {
        ctx.session.pendingAction = undefined;
        await ctx.reply("✅ Finished adding logs.", { reply_markup: bankLogsMainKeyboard() });
        return;
      }
      const parts = text.split("|").map((p) => p.trim());
      if (parts.length < 2 || !parts[0] || !parts[1]) {
        await ctx.reply(
          "❌ Invalid format. Need at least:\n\nBANK | COUNTRY | ... | PRICE | ...\n\nExample:\nChase | US | Checking | $12,500 | 150 | chase.com | user | pass | | Fresh",
        );
        ctx.session.pendingAction = "banklogs:add";
        return;
      }
      const [
        bankName = "",
        country = "",
        accountType = "Checking",
        balance,
        priceRaw,
        loginUrl,
        username,
        password,
        extras,
        notes,
      ] = parts;
      const priceNum = parseFloat(String(priceRaw ?? "").replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(priceNum) || priceNum <= 0) {
        await ctx.reply("❌ Price is required (field 5). Example: ... | 150 | ...\n\nSend the full line again.");
        ctx.session.pendingAction = "banklogs:add";
        return;
      }
      const [row] = await db
        .insert(bankLogsTable)
        .values({
          bankName,
          country,
          accountType: accountType || "Checking",
          balance: balance || null,
          price: priceNum.toFixed(2),
          loginUrl: loginUrl || null,
          username: username || null,
          password: password || null,
          extras: extras || null,
          notes: notes || null,
          status: "available",
          isSold: false,
        })
        .returning();
      ctx.session.pendingAction = "banklogs:add";
      await ctx.reply(
        `✅ Log #${row?.id ?? "?"} added\n━━━━━━━━━━━━━━━━━━\n\n` +
          `🏦 ${bankName} · ${country} · ${accountType || "Checking"}\n` +
          (balance ? `💰 Balance: ${balance}\n` : "") +
          `💵 Price: $${priceNum.toFixed(2)}\n\n` +
          `Users can buy it under CardShop → Bank Logs.\n\n` +
          `Send the next log in the same format, or type /done.`,
        {
          reply_markup: new InlineKeyboard()
            .text("➕ Keep adding", "banklogs:add")
            .text("📋 Available", "banklogs:list:available")
            .row()
            .text("✅ Done", "banklogs:main"),
        },
      );
    } catch (err) {
      ctx.session.pendingAction = "banklogs:add";
      await ctx.reply(
        `❌ Failed to add log: ${err instanceof Error ? err.message : "Unknown"}\n\nTry again with the pipe format.`,
      );
    }
  } else if (action === "banklogs:check") {
    try {
      const parts = text.trim().split(/\s+/);
      const id = parseInt(parts[0] ?? "");
      const markSold = parts[1]?.toLowerCase() === "sold";
      if (isNaN(id)) {
        await ctx.reply("❌ Invalid ID.");
        return;
      }
      const [log] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, id));
      if (!log) {
        await ctx.reply(`❌ Log #${id} not found.`);
        return;
      }
      if (markSold) {
        await db
          .update(bankLogsTable)
          .set({ status: "sold", isSold: true, soldAt: new Date() })
          .where(eq(bankLogsTable.id, id));
        await ctx.reply(`🔴 Log #${id} marked as SOLD.`);
        return;
      }
      const details =
        `🏦 LOG #${log.id} DETAILS\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Bank: ${log.bankName}\nCountry: ${log.country}\nType: ${log.accountType}\n` +
        (log.balance ? `Balance: ${log.balance}\n` : "") +
        (log.price ? `Price: $${log.price}\n` : "") +
        `Status: ${log.status}\n\n` +
        (log.loginUrl ? `URL: ${log.loginUrl}\n` : "") +
        (log.username ? `User: ${log.username}\n` : "") +
        (log.password ? `Pass: ${log.password}\n` : "") +
        (log.extras ? `Extras: ${log.extras}\n` : "") +
        (log.notes ? `Notes: ${log.notes}\n` : "") +
        `\nAdded: ${log.addedAt.toDateString()}`;
      await ctx.reply(details, { reply_markup: backKeyboard() });
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  } else if (action === "banklogs:delete") {
    try {
      const id = parseInt(text.trim());
      if (isNaN(id)) {
        await ctx.reply("❌ Invalid ID.");
        return;
      }
      await db.delete(bankLogsTable).where(eq(bankLogsTable.id, id));
      await ctx.reply(`🗑️ Log #${id} deleted.`, { reply_markup: bankLogsMainKeyboard() });
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  }
}
