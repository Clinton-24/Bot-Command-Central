/**
 * BANK LOGS — Bank Login Listings Panel (owner)
 * Add / list / edit (per-field) / check / delete / stats
 */
import { InlineKeyboard } from "grammy";
import { eq, desc } from "drizzle-orm";
import { db, bankLogsTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { canAccessFeature } from "./subscription";

const EDIT_FIELDS = [
  { key: "bank", label: "Bank", col: "bankName" as const },
  { key: "country", label: "Country", col: "country" as const },
  { key: "type", label: "Type", col: "accountType" as const },
  { key: "balance", label: "Balance", col: "balance" as const },
  { key: "price", label: "Price $", col: "price" as const },
  { key: "url", label: "URL", col: "loginUrl" as const },
  { key: "user", label: "Username", col: "username" as const },
  { key: "pass", label: "Password", col: "password" as const },
  { key: "extras", label: "Extras", col: "extras" as const },
  { key: "notes", label: "Notes", col: "notes" as const },
] as const;

type EditFieldKey = (typeof EDIT_FIELDS)[number]["key"];

function bankLogsMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("➕ Add Log", "banklogs:add")
    .text("✏️ Edit Log", "banklogs:edit")
    .row()
    .text("📋 All Logs", "banklogs:list:all")
    .text("✅ Available", "banklogs:list:available")
    .row()
    .text("💸 Sold", "banklogs:list:sold")
    .text("🔍 Check Log", "banklogs:check")
    .row()
    .text("🗑️ Delete Log", "banklogs:delete")
    .text("📊 Stats", "banklogs:stats")
    .row()
    .text("🏠 Main Menu", "menu:main");
}

function backKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🔙 Bank Logs", "banklogs:main");
}

function editFieldsKeyboard(id: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < EDIT_FIELDS.length; i += 2) {
    const a = EDIT_FIELDS[i]!;
    const b = EDIT_FIELDS[i + 1];
    kb.text(a.label, `banklogs:efield:${id}:${a.key}`);
    if (b) kb.text(b.label, `banklogs:efield:${id}:${b.key}`);
    kb.row();
  }
  kb.text("✅ Done", "banklogs:main");
  return kb;
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
    log.status === "available"
      ? "🟢"
      : log.status === "sold"
        ? "🔴"
        : log.status === "checked"
          ? "🟡"
          : "⚫";
  return (
    `${statusEmoji} #${log.id} — ${log.bankName} · ${log.country}\n` +
    `   Type: ${log.accountType}${log.balance ? ` · Bal: ${log.balance}` : ""}${log.price ? ` · $${log.price}` : ""}\n` +
    `   Added: ${log.addedAt.toDateString()}`
  );
}

function formatLogFull(log: typeof bankLogsTable.$inferSelect): string {
  return (
    `🏦 LOG #${log.id}\n━━━━━━━━━━━━━━━━━━\n\n` +
    `Bank: ${log.bankName}\n` +
    `Country: ${log.country}\n` +
    `Type: ${log.accountType}\n` +
    `Balance: ${log.balance ?? "—"}\n` +
    `Price: $${log.price ?? "—"}\n` +
    `URL: ${log.loginUrl ?? "—"}\n` +
    `User: ${log.username ?? "—"}\n` +
    `Pass: ${log.password ?? "—"}\n` +
    `Extras: ${log.extras ?? "—"}\n` +
    `Notes: ${log.notes ?? "—"}\n` +
    `Status: ${log.status}\n` +
    `Added: ${log.addedAt.toDateString()}`
  );
}

function fieldLabel(key: string): string {
  return EDIT_FIELDS.find((f) => f.key === key)?.label ?? key;
}

function currentFieldValue(log: typeof bankLogsTable.$inferSelect, key: EditFieldKey): string {
  switch (key) {
    case "bank":
      return log.bankName;
    case "country":
      return log.country;
    case "type":
      return log.accountType;
    case "balance":
      return log.balance ?? "";
    case "price":
      return log.price ?? "";
    case "url":
      return log.loginUrl ?? "";
    case "user":
      return log.username ?? "";
    case "pass":
      return log.password ?? "";
    case "extras":
      return log.extras ?? "";
    case "notes":
      return log.notes ?? "";
    default:
      return "";
  }
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
        await ctx.answerCallbackQuery("Access required");
        await ctx.reply("🔒 Bank Logs requires access.\n\nUpgrade:", {
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
        `Send one line. Type /done when finished.`,
      { reply_markup: new InlineKeyboard().text("❌ Cancel", "banklogs:main") },
    );
  });

  bot.callbackQuery("banklogs:edit", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    ctx.session.pendingAction = "banklogs:edit_pick";
    await ctx.answerCallbackQuery();
    try {
      const logs = await db
        .select()
        .from(bankLogsTable)
        .orderBy(desc(bankLogsTable.addedAt))
        .limit(15);
      if (logs.length === 0) {
        await ctx.reply("No logs yet. Add one first.", { reply_markup: bankLogsMainKeyboard() });
        return;
      }
      const kb = new InlineKeyboard();
      for (const log of logs) {
        const label = `✏️ #${log.id} ${log.bankName} · ${log.country}`;
        kb.text(label.slice(0, 60), `banklogs:editid:${log.id}`).row();
      }
      kb.text("🔙 Cancel", "banklogs:main");
      await ctx.reply(
        `✏️ EDIT BANK LOG\n━━━━━━━━━━━━━━━━━━\n\nTap a log, or send the Log ID.`,
        { reply_markup: kb },
      );
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  bot.callbackQuery(/^banklogs:editid:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    const id = parseInt(ctx.match![1]!, 10);
    await ctx.answerCallbackQuery();
    await showEditMenu(ctx, id);
  });

  bot.callbackQuery(/^banklogs:efield:(\d+):(\w+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    const id = parseInt(ctx.match![1]!, 10);
    const field = ctx.match![2]! as EditFieldKey;
    if (!EDIT_FIELDS.some((f) => f.key === field)) {
      await ctx.answerCallbackQuery("Unknown field");
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      const [log] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, id));
      if (!log) {
        await ctx.reply(`❌ Log #${id} not found.`);
        return;
      }
      const current = currentFieldValue(log, field);
      ctx.session.pendingAction = `banklogs:set:${id}:${field}`;
      await ctx.reply(
        `✏️ Edit ${fieldLabel(field)} — Log #${id}\n━━━━━━━━━━━━━━━━━━\n\n` +
          `Current: ${current || "(empty)"}\n\n` +
          `Send the new value only.\n` +
          (field === "price" ? "Numbers only, e.g. 150\n" : "") +
          `Type - to clear this field (except Bank / Country / Price).`,
        {
          reply_markup: new InlineKeyboard()
            .text("🔙 Fields", `banklogs:editid:${id}`)
            .text("❌ Cancel", "banklogs:main"),
        },
      );
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  bot.callbackQuery(/^banklogs:list:(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      const filter = ctx.match![1]!;
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
      if (logs.length === 0) {
        await ctx.editMessageText(`🏦 ${title}\n━━━━━━━━━━━━━━━━━━\n\nNo logs found.`, {
          reply_markup: backKeyboard(),
        });
        return;
      }
      const lines = logs.map(formatLog).join("\n\n");
      const kb = new InlineKeyboard();
      for (const log of logs.slice(0, 10)) {
        kb.text(`✏️ #${log.id}`, `banklogs:editid:${log.id}`)
          .text(`🔍 #${log.id}`, `banklogs:view:${log.id}`)
          .row();
      }
      kb.text("🔙 Bank Logs", "banklogs:main");
      await ctx.editMessageText(
        `🏦 ${title}\n━━━━━━━━━━━━━━━━━━\n\n${lines}\n\nTap ✏️ to edit one field, or 🔍 for details.`,
        { reply_markup: kb },
      );
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  bot.callbackQuery(/^banklogs:view:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    const id = parseInt(ctx.match![1]!, 10);
    await ctx.answerCallbackQuery();
    try {
      const [log] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, id));
      if (!log) {
        await ctx.reply(`❌ Log #${id} not found.`);
        return;
      }
      await ctx.reply(formatLogFull(log), {
        reply_markup: new InlineKeyboard()
          .text("✏️ Edit field", `banklogs:editid:${id}`)
          .text("🗑️ Delete", `banklogs:delid:${id}`)
          .row()
          .text("🔙 Bank Logs", "banklogs:main"),
      });
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  bot.callbackQuery(/^banklogs:delid:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    const id = parseInt(ctx.match![1]!, 10);
    await ctx.answerCallbackQuery();
    try {
      await db.delete(bankLogsTable).where(eq(bankLogsTable.id, id));
      await ctx.reply(`🗑️ Log #${id} deleted.`, { reply_markup: bankLogsMainKeyboard() });
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

async function showEditMenu(ctx: BotContext, id: number): Promise<void> {
  try {
    const [log] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, id));
    if (!log) {
      await ctx.reply(`❌ Log #${id} not found.`);
      return;
    }
    ctx.session.pendingAction = undefined;
    await ctx.reply(
      `${formatLogFull(log)}\n\n` +
        `✏️ EDIT LOG #${id}\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Tap the field you want to change. Only that field is updated.`,
      { reply_markup: editFieldsKeyboard(id) },
    );
  } catch (err) {
    await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
  }
}

function parseLogLine(text: string): {
  bankName: string;
  country: string;
  accountType: string;
  balance: string | null;
  price: string;
  loginUrl: string | null;
  username: string | null;
  password: string | null;
  extras: string | null;
  notes: string | null;
} | null {
  const parts = text.split("|").map((p) => p.trim());
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
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
  if (!Number.isFinite(priceNum) || priceNum <= 0) return null;
  return {
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
  };
}

export async function processBankLogInput(ctx: BotContext, action: string, text: string): Promise<void> {
  if (action === "banklogs:add") {
    try {
      if (text.trim().toLowerCase() === "/done" || text.trim().toLowerCase() === "done") {
        ctx.session.pendingAction = undefined;
        await ctx.reply("✅ Finished adding logs.", { reply_markup: bankLogsMainKeyboard() });
        return;
      }
      const parsed = parseLogLine(text);
      if (!parsed) {
        await ctx.reply(
          "❌ Invalid format. Need at least:\n\nBANK | COUNTRY | ... | PRICE | ...\n\nExample:\nChase | US | Checking | $12,500 | 150 | chase.com | user | pass | | Fresh",
        );
        ctx.session.pendingAction = "banklogs:add";
        return;
      }
      const [row] = await db
        .insert(bankLogsTable)
        .values({
          ...parsed,
          status: "available",
          isSold: false,
        })
        .returning();
      ctx.session.pendingAction = "banklogs:add";
      await ctx.reply(
        `✅ Log #${row?.id ?? "?"} added\n━━━━━━━━━━━━━━━━━━\n\n` +
          `🏦 ${parsed.bankName} · ${parsed.country} · ${parsed.accountType}\n` +
          (parsed.balance ? `💰 Balance: ${parsed.balance}\n` : "") +
          `💵 Price: $${parsed.price}\n\n` +
          `Send the next log, or type /done.`,
        {
          reply_markup: new InlineKeyboard()
            .text("➕ Keep adding", "banklogs:add")
            .text("✏️ Edit fields", `banklogs:editid:${row?.id ?? 0}`)
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
  } else if (action === "banklogs:edit_pick") {
    const id = parseInt(text.trim(), 10);
    if (isNaN(id)) {
      await ctx.reply("❌ Send a numeric Log ID, or use the Edit Log buttons.");
      ctx.session.pendingAction = "banklogs:edit_pick";
      return;
    }
    await showEditMenu(ctx, id);
  } else if (action.startsWith("banklogs:set:")) {
    // banklogs:set:{id}:{field}
    const parts = action.split(":");
    const id = parseInt(parts[2] ?? "", 10);
    const field = (parts[3] ?? "") as EditFieldKey;
    if (isNaN(id) || !EDIT_FIELDS.some((f) => f.key === field)) {
      await ctx.reply("❌ Invalid edit. Open Edit Log again.");
      ctx.session.pendingAction = undefined;
      return;
    }
    try {
      const [existing] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, id));
      if (!existing) {
        await ctx.reply(`❌ Log #${id} not found.`);
        ctx.session.pendingAction = undefined;
        return;
      }

      let value = text.trim();
      if (value === "-") value = "";

      if (field === "bank" || field === "country") {
        if (!value) {
          await ctx.reply(`❌ ${fieldLabel(field)} cannot be empty. Send a value.`);
          ctx.session.pendingAction = `banklogs:set:${id}:${field}`;
          return;
        }
      }

      if (field === "price") {
        const priceNum = parseFloat(value.replace(/[^0-9.]/g, ""));
        if (!Number.isFinite(priceNum) || priceNum <= 0) {
          await ctx.reply("❌ Price must be a number greater than 0, e.g. 150");
          ctx.session.pendingAction = `banklogs:set:${id}:${field}`;
          return;
        }
        value = priceNum.toFixed(2);
      }

      const patch: Record<string, string | null> = {};
      switch (field) {
        case "bank":
          patch.bankName = value;
          break;
        case "country":
          patch.country = value;
          break;
        case "type":
          patch.accountType = value || "Checking";
          break;
        case "balance":
          patch.balance = value || null;
          break;
        case "price":
          patch.price = value;
          break;
        case "url":
          patch.loginUrl = value || null;
          break;
        case "user":
          patch.username = value || null;
          break;
        case "pass":
          patch.password = value || null;
          break;
        case "extras":
          patch.extras = value || null;
          break;
        case "notes":
          patch.notes = value || null;
          break;
      }

      await db.update(bankLogsTable).set(patch).where(eq(bankLogsTable.id, id));
      ctx.session.pendingAction = undefined;

      const [updated] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, id));
      await ctx.reply(
        `✅ ${fieldLabel(field)} updated on Log #${id}\n` +
          `New value: ${value || "(cleared)"}\n\n` +
          (updated ? formatLogFull(updated) : ""),
        { reply_markup: editFieldsKeyboard(id) },
      );
    } catch (err) {
      ctx.session.pendingAction = `banklogs:set:${id}:${field}`;
      await ctx.reply(`❌ Update failed: ${err instanceof Error ? err.message : "Unknown"}`);
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
      await ctx.reply(formatLogFull(log), {
        reply_markup: new InlineKeyboard()
          .text("✏️ Edit field", `banklogs:editid:${id}`)
          .row()
          .text("🔙 Bank Logs", "banklogs:main"),
      });
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
