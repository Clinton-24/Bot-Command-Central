import { InlineKeyboard } from "grammy";
import { Pool } from "pg";
import { and, eq, gte } from "drizzle-orm";
import { db, externalDbLogsTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";
import nodemailer from "nodemailer";

const SITE_NAME = process.env.EXTERNAL_DB_SITE_NAME ?? "Harmony";
const EXTERNAL_DB_URL = process.env.EXTERNAL_DB_URL ?? process.env.DATABASE_URL;
const EXTERNAL_DB_LIMIT_MB = parseInt(process.env.EXTERNAL_DB_LIMIT_MB || String(1024 * 1024), 10); // default 1 TB

function formatDate(d = new Date()): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function extDbLogsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔌 Connection", "extdblogs:filter:connection")
    .text("💾 Backup", "extdblogs:filter:backup")
    .row()
    .text("📦 Storage", "extdblogs:filter:storage")
    .text("🧩 Integrity", "extdblogs:filter:integrity")
    .row()
    .text("📋 All Logs", "extdblogs:filter:all")
    .row()
    .text("🔔 Run All Checks Now", "extdblogs:check")
    .row()
    .text("🔙 Bank Logs", "hex:main");
}

async function insertLog(payload: Partial<any>) {
  try {
    await db.insert(externalDbLogsTable).values(payload as any).returning();
  } catch (err) {
    logger.error({ err }, "insertExternalDbLog error");
  }
}

export async function runExternalDbChecks(bot: MyBot, notifyUserId: number) {
  // connection check
  await checkExternalConnection(bot, notifyUserId);
  await checkExternalBackup(bot, notifyUserId);
  await checkExternalStorage(bot, notifyUserId);
  await checkExternalIntegrity(bot, notifyUserId);
}

async function checkExternalConnection(bot: MyBot, notifyUserId: number) {
  const site = SITE_NAME;
  if (!EXTERNAL_DB_URL) {
    const msg = `❌ ${site} connection string not configured`;
    await insertLog({ site, checkType: "connection", status: "failed", message: msg });
    await bot.api.sendMessage(notifyUserId, `❌ DB ALERT — ${site}\n━━━━━━━━━━━━━━━━━━\n\n${msg}`, { parse_mode: "Markdown" }).catch(() => {});
    return;
  }

  const pool = new Pool({ connectionString: EXTERNAL_DB_URL, ssl: { rejectUnauthorized: false } });
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    const message = `✅ Connection OK to ${site}`;
    await insertLog({ site, checkType: "connection", status: "success", message });
    await bot.api.sendMessage(notifyUserId, `✅ DB ALERT — ${site}\n━━━━━━━━━━━━━━━━━━\n\nToday, ${formatDate()} connection successful...`, { parse_mode: "Markdown" }).catch(() => {});
  } catch (err) {
    logger.error({ err }, "external DB connection failed");
    const message = `❌ Connection failed: ${(err as Error).message}`;
    await insertLog({ site, checkType: "connection", status: "failed", message });
    await bot.api.sendMessage(notifyUserId, `❌ DB ALERT — ${site}\n━━━━━━━━━━━━━━━━━━\n\nToday, ${formatDate()} connection Failed...\n${message}`, { parse_mode: "Markdown" }).catch(() => {});
  } finally {
    await pool.end().catch(() => {});
  }
}

async function checkExternalBackup(bot: MyBot, notifyUserId: number) {
  const site = SITE_NAME;
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const rows = await db
      .select()
      .from(externalDbLogsTable)
      .where(and(eq(externalDbLogsTable.site, site), eq(externalDbLogsTable.checkType, "backup")));

    const foundToday = rows.some((r: any) => new Date(r.createdAt) >= today && r.status === "success");
    if (foundToday) {
      const message = `Today, ${formatDate()} backup successful...`;
      await insertLog({ site, checkType: "backup", status: "success", message });
      await bot.api.sendMessage(notifyUserId, `✅ DB ALERT — ${site}\n━━━━━━━━━━━━━━━━━━\n\n${message}`, { parse_mode: "Markdown" }).catch(() => {});
    } else {
      const message = `Today, ${formatDate()} backup Failed...`;
      await insertLog({ site, checkType: "backup", status: "failed", message });
      await bot.api.sendMessage(notifyUserId, `❌ DB ALERT — ${site}\n━━━━━━━━━━━━━━━━━━\n\n${message}`, { parse_mode: "Markdown" }).catch(() => {});
    }
  } catch (err) {
    logger.error({ err }, "checkExternalBackup error");
  }
}

async function checkExternalStorage(bot: MyBot, notifyUserId: number) {
  const site = SITE_NAME;
  if (!EXTERNAL_DB_URL) return;
  const pool = new Pool({ connectionString: EXTERNAL_DB_URL, ssl: { rejectUnauthorized: false } });
  try {
    const client = await pool.connect();
    const res = await client.query(`SELECT pg_database_size(current_database()) as bytes`);
    client.release();
    const usedBytes = Number(res.rows[0]?.bytes || 0);
    const usedMb = Math.round(usedBytes / 1024 / 1024);
    const limitMb = EXTERNAL_DB_LIMIT_MB;
    const pct = Math.round((usedMb / limitMb) * 100);
    const status = pct >= 80 ? "warning" : "success";
    const message = status === "warning" ? `⚠️ Storage warning: usage at ${pct}% — ${usedMb}MB/${limitMb}MB` : `✅ Storage usage at ${pct}% — ${usedMb}MB/${limitMb}MB`;
    await insertLog({ site, checkType: "storage", status, message, storageUsedMb: usedMb, storageLimitMb: limitMb });
    await bot.api.sendMessage(notifyUserId, `✅ DB ALERT — ${site}\n━━━━━━━━━━━━━━━━━━\n\n${message}`, { parse_mode: "Markdown" }).catch(() => {});
  } catch (err) {
    logger.error({ err }, "checkExternalStorage error");
    await insertLog({ site, checkType: "storage", status: "failed", message: (err as Error).message });
  } finally {
    await pool.end().catch(() => {});
  }
}

async function checkExternalIntegrity(bot: MyBot, notifyUserId: number) {
  const site = SITE_NAME;
  if (!EXTERNAL_DB_URL) return;
  const pool = new Pool({ connectionString: EXTERNAL_DB_URL, ssl: { rejectUnauthorized: false } });
  try {
    const client = await pool.connect();
    const tableListEnv = process.env.EXTERNAL_DB_INTEGRITY_TABLES || "users,orders,payments";
    const tables = tableListEnv.split(",").map((s) => s.trim()).filter(Boolean);
    const missing: string[] = [];
    const empty: string[] = [];
    for (const t of tables) {
      const existsRes = await client.query(
        `SELECT to_regclass($1) IS NOT NULL as exists`,
        [t]
      );
      const exists = existsRes.rows[0]?.exists;
      if (!exists) {
        missing.push(t);
        continue;
      }
      const cntRes = await client.query(`SELECT count(*)::int as c FROM ${t} LIMIT 1`);
      const c = Number(cntRes.rows[0]?.c || 0);
      if (c === 0) empty.push(t);
    }
    client.release();

    let status = "success";
    let message = `Integrity OK for tables: ${tables.join(", ")}`;
    if (missing.length || empty.length) {
      status = "failed";
      message = `${missing.length ? `Missing tables: ${missing.join(", ")}. ` : ""}${empty.length ? `Empty tables: ${empty.join(", ")}.` : ""}`;
    }
    await insertLog({ site, checkType: "integrity", status, message });
    await bot.api.sendMessage(notifyUserId, `✅ DB ALERT — ${site}\n━━━━━━━━━━━━━━━━━━\n\n${message}`, { parse_mode: "Markdown" }).catch(() => {});
  } catch (err) {
    logger.error({ err }, "checkExternalIntegrity error");
    await insertLog({ site, checkType: "integrity", status: "failed", message: (err as Error).message });
  } finally {
    await pool.end().catch(() => {});
  }
}

export function registerExtDbLogsHandlers(bot: MyBot): void {
  bot.command("extdblogs", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.reply("⛔ Owner-only command."); return; }
    await ctx.reply(`🌐 *External DB — ${SITE_NAME}*\n━━━━━━━━━━━━━━━━━━\n\nManage external DB health checks.`, { parse_mode: "Markdown", reply_markup: extDbLogsKeyboard() });
  });
}

export function registerExtDbLogsCallbacks(bot: MyBot): void {
  bot.callbackQuery("extdblogs:main", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`🌐 *External DB — ${SITE_NAME}*\n━━━━━━━━━━━━━━━━━━\n\nManage external DB health checks.`, { parse_mode: "Markdown", reply_markup: extDbLogsKeyboard() });
  });

  bot.callbackQuery("extdblogs:filter:all", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery();
    const rows = await db.select().from(externalDbLogsTable).orderBy();
    const text = `📋 *Last External DB Logs*\n━━━━━━━━━━━━━━━━━━\n\n` + (rows.length === 0 ? "No logs yet." : rows.slice(-20).map((r: any) => `• [${r.checkType}] ${r.status} — ${new Date(r.createdAt).toLocaleString()} \n${r.message}`).join("\n\n"));
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: extDbLogsKeyboard() });
  });

  const types = ["connection", "backup", "storage", "integrity"];
  for (const t of types) {
    bot.callbackQuery(`extdblogs:filter:${t}`, async (ctx) => {
      if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
      await ctx.answerCallbackQuery();
      const rows = await db.select().from(externalDbLogsTable).where(eq(externalDbLogsTable.checkType, t)).orderBy();
      const text = `📋 *${t.toUpperCase()} Logs*\n━━━━━━━━━━━━━━━━━━\n\n` + (rows.length === 0 ? "No logs yet." : rows.slice(-10).map((r: any) => `• ${r.status} — ${new Date(r.createdAt).toLocaleString()}\n${r.message}`).join("\n\n"));
      await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: extDbLogsKeyboard() });
    });
  }

  bot.callbackQuery("extdblogs:check", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery();
    const ownerId = Number(process.env.BOT_OWNER_ID);
    if (!ownerId) { await ctx.reply("Owner ID not configured."); return; }
    await ctx.reply("🔔 Running external DB checks...");
    await runExternalDbChecks(bot, ownerId);
    await ctx.reply("✅ External DB checks completed.");
  });
}

// Expose an API helper to mark backup from external scripts
export async function markExternalBackup(site = SITE_NAME, details?: string, reporter?: string) {
  try {
    await insertLog({ site, checkType: "backup", status: "success", message: `Backup reported${reporter ? ` by ${reporter}` : ""}`, details: details ?? null });
  } catch (err) {
    logger.error({ err }, "markExternalBackup error");
  }
}

// optional email helper
export async function notifyByEmail(subject: string, text: string) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return;
  try {
    const transporter = nodemailer.createTransport({ host: "smtp.atomicmail.com", port: 587, secure: false, auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS } });
    await transporter.sendMail({ from: process.env.EMAIL_USER, to: process.env.NOTIFY_EMAIL ?? "Nullryns@atomicmail.com", subject, text });
  } catch (err) {
    logger.error({ err }, "notifyByEmail error");
  }
}
