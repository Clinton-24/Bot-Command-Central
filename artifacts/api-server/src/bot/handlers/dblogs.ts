import { InlineKeyboard } from "grammy";
import { desc, eq } from "drizzle-orm";
import { db, dbLogsTable } from "@workspace/db";
import type { MyBot } from "../index";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function statusEmoji(status: string): string {
  if (status === "success") return "✅";
  if (status === "failed") return "❌";
  return "⚠️";
}

function buildNotificationText(log: { status: string; message: string; details?: string | null; createdAt: Date }): string {
  const emoji = statusEmoji(log.status);
  const dateStr = formatDate(log.createdAt);
  let text = `${emoji} *DB ALERT*\n━━━━━━━━━━━━━━━━━━\n\nToday, ${dateStr} ${log.message}`;
  if (log.details) text += `\n\n📋 _${log.details}_`;
  return text;
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

function dbLogsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Successes", "dblogs:filter:success")
    .text("❌ Failures", "dblogs:filter:failed")
    .row()
    .text("⚠️ Warnings", "dblogs:filter:warning")
    .text("📋 All Logs", "dblogs:filter:all")
    .row()
    .text("🔔 Run Check Now", "dblogs:check")
    .text("🌐 External Site DB", "extdblogs:main")
    .row()
    .text("🔙 Hex Panel", "hex:main");
}

// ── DB check logic ────────────────────────────────────────────────────────────

export async function runDbCheck(bot: MyBot, notifyUserId?: number): Promise<void> {
  const now = new Date();
  let status: "success" | "failed" | "warning" = "success";
  let message = "backup successful";
  let details: string | undefined;

  try {
    await db.select().from(dbLogsTable).limit(1);
  } catch (err) {
    status = "failed";
    message = "backup Failed";
    details = err instanceof Error ? err.message : "Unknown error";
    logger.error({ err }, "DB check failed");
  }

  try {
    const [log] = await db
      .insert(dbLogsTable)
      .values({ status, message, details: details ?? null, createdAt: now })
      .returning();

    if (!log) return;

    if (notifyUserId) {
      const text = buildNotificationText(log);
      try {
        await bot.api.sendMessage(notifyUserId, text, { parse_mode: "Markdown" });
        await db
          .update(dbLogsTable)
          .set({ notifiedAt: new Date(), notifiedTo: notifyUserId })
          .where(eq(dbLogsTable.id, log.id));
      } catch (notifyErr) {
        logger.error({ notifyErr }, "Failed to send DB log notification");
      }
    }
  } catch (err) {
    logger.error({ err }, "Failed to insert DB log");
  }
}

export async function insertDbLog(
  status: "success" | "failed" | "warning",
  message: string,
  details?: string
): Promise<void> {
  await db.insert(dbLogsTable).values({ status, message, details: details ?? null }).catch((err) => {
    logger.error({ err }, "insertDbLog failed");
  });
}

// ── Register ──────────────────────────────────────────────────────────────────

export function registerDbLogsHandlers(bot: MyBot): void {
  bot.command("dblogs", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner-only command.");
      return;
    }
    try {
      const recent = await db
        .select()
        .from(dbLogsTable)
        .orderBy(desc(dbLogsTable.createdAt))
        .limit(5);

      const summary =
        recent.length === 0
          ? "_No logs yet. Run a check to get started._"
          : recent.map((l) => `${statusEmoji(l.status)} ${formatDate(l.createdAt)} — ${l.message}`).join("\n");

      await ctx.reply(
        `🗄️ *BANK LOGS — DB MONITOR*\n━━━━━━━━━━━━━━━━━━\n\n${summary}\n\n_Last ${recent.length} entries shown_`,
        { parse_mode: "Markdown", reply_markup: dbLogsKeyboard() }
      );
    } catch (err) {
      logger.error({ err }, "dblogs command error");
      await ctx.reply(`❌ Error loading logs: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  });
}

export function registerDbLogsCallbacks(bot: MyBot): void {
  // ── Main panel ──────────────────────────────────────────────────────────────
  bot.callbackQuery("dblogs:main", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      const recent = await db
        .select()
        .from(dbLogsTable)
        .orderBy(desc(dbLogsTable.createdAt))
        .limit(5);

      const summary =
        recent.length === 0
          ? "_No logs yet. Run a check to get started._"
          : recent.map((l) => `${statusEmoji(l.status)} ${formatDate(l.createdAt)} — ${l.message}`).join("\n");

      await ctx.editMessageText(
        `🗄️ *BANK LOGS — DB MONITOR*\n━━━━━━━━━━━━━━━━━━\n\n${summary}\n\n_Last ${recent.length} entries shown_`,
        { parse_mode: "Markdown", reply_markup: dbLogsKeyboard() }
      );
    } catch (err) {
      logger.error({ err }, "dblogs:main callback error");
      await ctx.reply(`❌ DB Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  });

  // ── Filtered view ───────────────────────────────────────────────────────────
  bot.callbackQuery(/^dblogs:filter:(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    await ctx.answerCallbackQuery();
    try {
      const filter = ctx.match[1] as string;
      const isAll = filter === "all";

      const logs = await (isAll
        ? db.select().from(dbLogsTable).orderBy(desc(dbLogsTable.createdAt)).limit(20)
        : db.select().from(dbLogsTable).where(eq(dbLogsTable.status, filter)).orderBy(desc(dbLogsTable.createdAt)).limit(20));

      const titleMap: Record<string, string> = {
        success: "✅ SUCCESSFUL BACKUPS",
        failed: "❌ FAILED BACKUPS",
        warning: "⚠️ STORAGE WARNINGS",
        all: "📋 ALL DB LOGS",
      };

      const lines =
        logs.length === 0
          ? "_No entries found._"
          : logs
              .map((l) =>
                `${statusEmoji(l.status)} *${formatDate(l.createdAt)}* — ${l.message}` +
                (l.details ? `\n   ↳ _${l.details}_` : "")
              )
              .join("\n\n");

      await ctx.editMessageText(
        `🗄️ *${titleMap[filter] ?? "📋 DB LOGS"}*\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Bank Logs", "dblogs:main") }
      );
    } catch (err) {
      logger.error({ err }, "dblogs:filter callback error");
      await ctx.reply(`❌ DB Error: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  });

  // ── Run check now ───────────────────────────────────────────────────────────
  bot.callbackQuery("dblogs:check", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    await ctx.answerCallbackQuery("🔍 Running check...");
    try {
      await runDbCheck(bot, ctx.from.id);

      const recent = await db
        .select()
        .from(dbLogsTable)
        .orderBy(desc(dbLogsTable.createdAt))
        .limit(5);

      const summary = recent
        .map((l) => `${statusEmoji(l.status)} ${formatDate(l.createdAt)} — ${l.message}`)
        .join("\n");

      await ctx.editMessageText(
        `🗄️ *BANK LOGS — DB MONITOR*\n━━━━━━━━━━━━━━━━━━\n\n${summary}`,
        { parse_mode: "Markdown", reply_markup: dbLogsKeyboard() }
      );
    } catch (err) {
      logger.error({ err }, "dblogs:check callback error");
      await ctx.reply(`❌ Check failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    }
  });
}
