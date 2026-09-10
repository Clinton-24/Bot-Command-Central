import { InlineKeyboard } from "grammy";
import { md, safeName, safeUsername } from "../utils/escape";
import { Pool } from "pg";
import { eq, desc } from "drizzle-orm";
import { db, externalDbLogsTable } from "@workspace/db";
import type { MyBot } from "../index";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";
import nodemailer from "nodemailer";

// ── Config ────────────────────────────────────────────────────────────────────

const SITE_NAME = "Harmony";
const EXTERNAL_DB_URL = process.env.EXTERNAL_DB_URL;
const STORAGE_LIMIT_MB = 1024 * 1024; // 1 TB in MB
const WARN_THRESHOLD = 0.80; // warn at 80%
const NOTIFY_EMAIL = "nullryns@atomicmail.io";

// Tables to check for integrity
const INTEGRITY_TABLES = (process.env.EXTERNAL_DB_INTEGRITY_TABLES ?? "users,sessions,bookings,payments,appointments")
  .split(",").map((t) => t.trim()).filter(Boolean);

// ── Email ─────────────────────────────────────────────────────────────────────

async function sendEmail(subject: string, body: string): Promise<void> {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    logger.warn("Email not configured — skipping email notification");
    return;
  }
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST ?? "smtp.atomicmail.com",
      port: Number(process.env.EMAIL_PORT ?? 587),
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
    });
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: NOTIFY_EMAIL,
      subject,
      text: body,
    });
    logger.info({ to: NOTIFY_EMAIL, subject }, "Email sent");
  } catch (err) {
    logger.error({ err }, "Failed to send email");
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(d = new Date()): string {
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

async function insertLog(payload: {
  site: string;
  checkType: string;
  status: string;
  message: string;
  details?: string | null;
  storageUsedMb?: number | null;
  storageLimitMb?: number | null;
}): Promise<void> {
  try {
    await db.insert(externalDbLogsTable).values({
      site: payload.site,
      checkType: payload.checkType,
      status: payload.status,
      message: payload.message,
      details: payload.details ?? null,
      storageUsedMb: payload.storageUsedMb ?? null,
      storageLimitMb: payload.storageLimitMb ?? null,
    });
  } catch (err) {
    logger.error({ err }, "insertLog error");
  }
}

async function notify(bot: MyBot, ownerId: number, telegramText: string, emailSubject: string, emailBody: string): Promise<void> {
  try {
    await bot.api.sendMessage(ownerId, telegramText, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error({ err }, "Telegram notify failed");
  }
  await sendEmail(emailSubject, emailBody);
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

function harmonyKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔌 Connection", "harmony:filter:connection")
    .text("💾 Backup", "harmony:filter:backup")
    .row()
    .text("📦 Storage", "harmony:filter:storage")
    .text("🧩 Integrity", "harmony:filter:integrity")
    .row()
    .text("📋 All Logs", "harmony:filter:all")
    .row()
    .text("🔔 Run All Checks", "harmony:check")
    .row()
    .text("💾 Backup Now", "harmony:backup")
    .row()
    .text("🔙 Hex Panel", "hex:main");
}

// ── Individual checks ─────────────────────────────────────────────────────────

async function checkConnection(bot: MyBot, ownerId: number): Promise<void> {
  if (!EXTERNAL_DB_URL) {
    const msg = `❌ *Harmony DB — Connection*\n━━━━━━━━━━━━━━━━━━\n\nToday, ${formatDate()} connection Failed...\n_No EXTERNAL\\_DB\\_URL set_`;
    await insertLog({ site: SITE_NAME, checkType: "connection", status: "failed", message: `Today, ${formatDate()} connection Failed...`, details: "No EXTERNAL_DB_URL set" });
    await notify(bot, ownerId, msg, `❌ Harmony DB — Connection Failed ${formatDate()}`, `Harmony DB connection check failed on ${formatDate()}.\nReason: No EXTERNAL_DB_URL configured.`);
    return;
  }

  const pool = new Pool({ connectionString: EXTERNAL_DB_URL, ssl: { rejectUnauthorized: false } });
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();

    const msg = `✅ *Harmony DB — Connection*\n━━━━━━━━━━━━━━━━━━\n\nToday, ${formatDate()} connection successful...`;
    await insertLog({ site: SITE_NAME, checkType: "connection", status: "success", message: `Today, ${formatDate()} connection successful...` });
    await notify(bot, ownerId, msg, `✅ Harmony DB — Connection OK ${formatDate()}`, `Harmony DB connection check passed on ${formatDate()}.`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    const msg = `❌ *Harmony DB — Connection*\n━━━━━━━━━━━━━━━━━━\n\nToday, ${formatDate()} connection Failed...\n_${detail}_`;
    await insertLog({ site: SITE_NAME, checkType: "connection", status: "failed", message: `Today, ${formatDate()} connection Failed...`, details: detail });
    await notify(bot, ownerId, msg, `❌ Harmony DB — Connection Failed ${formatDate()}`, `Harmony DB connection failed on ${formatDate()}.\nError: ${detail}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

async function checkStorage(bot: MyBot, ownerId: number): Promise<void> {
  if (!EXTERNAL_DB_URL) return;

  const pool = new Pool({ connectionString: EXTERNAL_DB_URL, ssl: { rejectUnauthorized: false } });
  try {
    const client = await pool.connect();
    const res = await client.query(`SELECT pg_database_size(current_database()) as bytes`);
    client.release();

    const usedBytes = Number(res.rows[0]?.bytes ?? 0);
    const usedMb = Math.round(usedBytes / 1024 / 1024);
    const usedGb = (usedMb / 1024).toFixed(2);
    const pct = Math.round((usedMb / STORAGE_LIMIT_MB) * 100);
    const isWarning = usedMb / STORAGE_LIMIT_MB >= WARN_THRESHOLD;

    const status = isWarning ? "warning" : "success";
    const message = isWarning
      ? `⚠️ Storage warning: ${pct}% used — ${usedGb} GB / 1 TB`
      : `Today, ${formatDate()} Storage: ${pct}% used — ${usedGb} GB / 1 TB`;

    const tgText = isWarning
      ? `⚠️ *Harmony DB — Storage Warning*\n━━━━━━━━━━━━━━━━━━\n\nToday, ${formatDate()} ${message}`
      : `✅ *Harmony DB — Storage*\n━━━━━━━━━━━━━━━━━━\n\nToday, ${formatDate()} ${message}`;

    await insertLog({ site: SITE_NAME, checkType: "storage", status, message, storageUsedMb: usedMb, storageLimitMb: STORAGE_LIMIT_MB });
    if (isWarning || !opts?.silentOnSuccess) await notify(
      bot, ownerId, tgText,
      `${isWarning ? "⚠️" : "✅"} Harmony DB — Storage ${formatDate()}`,
      `Harmony DB storage check on ${formatDate()}.\n${message}`
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    await insertLog({ site: SITE_NAME, checkType: "storage", status: "failed", message: `Today, ${formatDate()} storage check Failed...`, details: detail });
    await notify(bot, ownerId,
      `❌ *Harmony DB — Storage*\n━━━━━━━━━━━━━━━━━━\n\nToday, ${formatDate()} storage check Failed...\n_${detail}_`,
      `❌ Harmony DB — Storage Failed ${formatDate()}`,
      `Storage check failed on ${formatDate()}.\nError: ${detail}`
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

async function checkIntegrity(bot: MyBot, ownerId: number): Promise<void> {
  if (!EXTERNAL_DB_URL) return;

  const pool = new Pool({ connectionString: EXTERNAL_DB_URL, ssl: { rejectUnauthorized: false } });
  try {
    const client = await pool.connect();
    const missing: string[] = [];
    const empty: string[] = [];

    for (const t of INTEGRITY_TABLES) {
      const existsRes = await client.query(
        `SELECT to_regclass($1::text) IS NOT NULL as exists`, [t]
      );
      if (!existsRes.rows[0]?.exists) { missing.push(t); continue; }
      const cntRes = await client.query(`SELECT COUNT(*)::int as c FROM ${t} LIMIT 1`);
      if (Number(cntRes.rows[0]?.c ?? 0) === 0) empty.push(t);
    }
    client.release();

    const ok = missing.length === 0 && empty.length === 0;
    const status = ok ? "success" : "failed";
    const detail = ok ? null
      : [missing.length ? `Missing: ${missing.join(", ")}` : "", empty.length ? `Empty: ${empty.join(", ")}` : ""].filter(Boolean).join(" | ");
    const message = ok
      ? `Today, ${formatDate()} integrity check successful...`
      : `Today, ${formatDate()} integrity check Failed... ${detail}`;

    await insertLog({ site: SITE_NAME, checkType: "integrity", status, message, details: detail });
    if (!ok || !opts?.silentOnSuccess) await notify(
      bot, ownerId,
      `${ok ? "✅" : "❌"} *Harmony DB — Integrity*\n━━━━━━━━━━━━━━━━━━\n\n${message}`,
      `${ok ? "✅" : "❌"} Harmony DB — Integrity ${formatDate()}`,
      `Harmony DB integrity check on ${formatDate()}.\n${message}`
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    await insertLog({ site: SITE_NAME, checkType: "integrity", status: "failed", message: `Today, ${formatDate()} integrity check Failed...`, details: detail });
    await notify(bot, ownerId,
      `❌ *Harmony DB — Integrity*\n━━━━━━━━━━━━━━━━━━\n\nToday, ${formatDate()} integrity check Failed...\n_${detail}_`,
      `❌ Harmony DB — Integrity Failed ${formatDate()}`,
      `Integrity check failed on ${formatDate()}.\nError: ${detail}`
    );
  } finally {
    await pool.end().catch(() => {});
  }
}

// ── Automated backup: dumps Harmony DB via SQL queries → sends .sql file to owner DM ──

async function runAutomatedBackup(bot: MyBot, ownerId: number): Promise<void> {
  if (!EXTERNAL_DB_URL) {
    await insertLog({ site: SITE_NAME, checkType: "backup", status: "failed", message: `Today, ${formatDate()} backup Failed...`, details: "EXTERNAL_DB_URL not set" });
    await notify(bot, ownerId,
      `❌ *Harmony DB — Backup*\n━━━━━━━━━━━━━━━━━━\n\nToday, ${formatDate()} backup Failed...\n_EXTERNAL\_DB\_URL not configured on Render._`,
      `❌ Harmony DB — Backup Failed ${formatDate()}`,
      `Backup failed: EXTERNAL_DB_URL not set.`
    );
    return;
  }

  const startTime = Date.now();
  logger.info("Starting automated Harmony DB backup...");

  const pool = new Pool({ connectionString: EXTERNAL_DB_URL, ssl: { rejectUnauthorized: false } });

  try {
    const client = await pool.connect();

    // Get all table names
    const tablesRes = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      ORDER BY tablename
    `);
    const tables: string[] = tablesRes.rows.map((r: { tablename: string }) => r.tablename);

    let sql = `-- Harmony DB Backup\n-- Generated: ${new Date().toISOString()}\n-- Tables: ${tables.length}\n\n`;
    sql += `SET client_encoding = 'UTF8';\nSET standard_conforming_strings = on;\n\n`;

    let totalRows = 0;

    for (const table of tables) {
      try {
        // Get columns
        const colRes = await client.query(`
          SELECT column_name, data_type
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1
          ORDER BY ordinal_position
        `, [table]);

        const cols = colRes.rows.map((c: { column_name: string }) => c.column_name);
        const colList = cols.map((c: string) => `"${c}"`).join(", ");

        // Get rows
        const dataRes = await client.query(`SELECT * FROM "${table}"`);
        const rows = dataRes.rows;
        totalRows += rows.length;

        sql += `-- Table: ${table} (${rows.length} rows)\n`;

        if (rows.length > 0) {
          const valueLines = rows.map((row: Record<string, unknown>) => {
            const vals = cols.map((col: string) => {
              const v = row[col];
              if (v === null || v === undefined) return "NULL";
              if (typeof v === "number" || typeof v === "boolean") return String(v);
              if (v instanceof Date) return `'${v.toISOString()}'`;
              return `'${String(v).replace(/'/g, "''")}'`;
            });
            return `(${vals.join(", ")})`;
          });
          sql += `INSERT INTO "${table}" (${colList}) VALUES\n${valueLines.join(",\n")};\n\n`;
        } else {
          sql += `-- (empty table)\n\n`;
        }
      } catch (tableErr) {
        sql += `-- ERROR backing up ${table}: ${tableErr instanceof Error ? tableErr.message : "unknown"}\n\n`;
      }
    }

    client.release();

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const sizeKb = (Buffer.byteLength(sql, "utf8") / 1024).toFixed(1);
    const filename = `harmony-backup-${formatDate()}.sql`;

    // Send SQL file to owner DM via Telegram
    await bot.api.sendDocument(
      ownerId,
      new (await import("grammy")).InputFile(Buffer.from(sql, "utf8"), filename),
      {
        caption:
          `💾 *HARMONY DB BACKUP*\n━━━━━━━━━━━━━━━━━━\n\n` +
          `✅ Today, ${formatDate()} backup successful...\n\n` +
          `📊 Tables: *${tables.length}* · Rows: *${totalRows}*\n` +
          `📦 Size: *${sizeKb} KB*\n` +
          `⏱️ Duration: *${elapsed}s*`,
        parse_mode: "Markdown",
      }
    );

    // Log success
    await insertLog({
      site: SITE_NAME, checkType: "backup", status: "success",
      message: `Today, ${formatDate()} backup successful...`,
      details: `${tables.length} tables, ${totalRows} rows, ${sizeKb}KB, ${elapsed}s`,
    });

    // Email notification
    await sendEmail(
      `✅ Harmony DB — Backup OK ${formatDate()}`,
      `Harmony DB backup completed on ${formatDate()}.\nTables: ${tables.length}, Rows: ${totalRows}, Size: ${sizeKb}KB, Duration: ${elapsed}s\nBackup file sent to your Telegram DM.`
    );

    logger.info({ tables: tables.length, rows: totalRows, sizeKb, elapsed }, "Harmony backup complete");
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Unknown error";
    await insertLog({ site: SITE_NAME, checkType: "backup", status: "failed", message: `Today, ${formatDate()} backup Failed...`, details: detail });
    await notify(bot, ownerId,
      `❌ *Harmony DB — Backup*\n━━━━━━━━━━━━━━━━━━\n\nToday, ${formatDate()} backup Failed...\n_${detail}_`,
      `❌ Harmony DB — Backup Failed ${formatDate()}`,
      `Backup failed on ${formatDate()}.\nError: ${detail}`
    );
    logger.error({ err }, "Harmony backup failed");
  } finally {
    await pool.end().catch(() => {});
  }
}

// ── Public: run all checks ────────────────────────────────────────────────────

export async function runExternalDbChecks(bot: MyBot, notifyUserId: number, opts?: { silentOnSuccess?: boolean }): Promise<void> {
  logger.info("Running Harmony DB health checks...");
  await checkConnection(bot, notifyUserId);
  await runAutomatedBackup(bot, notifyUserId);
  await checkStorage(bot, notifyUserId);
  await checkIntegrity(bot, notifyUserId);
}

// ── Public: mark backup done (called from API route) ─────────────────────────

export async function markExternalBackup(details?: string, reporter?: string): Promise<void> {
  const message = `Today, ${formatDate()} backup successful...`;
  await insertLog({
    site: SITE_NAME,
    checkType: "backup",
    status: "success",
    message,
    details: reporter ? `Reported by: ${reporter}${details ? ` — ${details}` : ""}` : (details ?? null),
  });
}

// ── Register ──────────────────────────────────────────────────────────────────

export function registerExtDbLogsHandlers(bot: MyBot): void {
  bot.command("harmony", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.reply("⛔ Owner-only command."); return; }
    try {
      const recent = await db
        .select().from(externalDbLogsTable)
        .orderBy(desc(externalDbLogsTable.createdAt)).limit(8);

      const lines = recent.length === 0
        ? "_No checks run yet. Tap Run All Checks Now to start._"
        : recent.map((r) => `${statusEmoji(r.status)} *${r.checkType}* — ${r.message}`).join("\n\n");

      await ctx.reply(
        `🩺 *HARMONY DB — HEALTH MONITOR*\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
        { parse_mode: "Markdown", reply_markup: harmonyKeyboard() }
      );
    } catch (err) {
      await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  });
}

export function registerExtDbLogsCallbacks(bot: MyBot): void {
  // ── Main panel ──────────────────────────────────────────────────────────────
  bot.callbackQuery("extdblogs:main", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery();
    try {
      const recent = await db
        .select().from(externalDbLogsTable)
        .orderBy(desc(externalDbLogsTable.createdAt)).limit(8);

      const lines = recent.length === 0
        ? "_No checks run yet. Tap Run All Checks Now to start._"
        : recent.map((r) => `${statusEmoji(r.status)} *${r.checkType}* — ${r.message}`).join("\n\n");

      await ctx.editMessageText(
        `🩺 *HARMONY DB — HEALTH MONITOR*\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
        { parse_mode: "Markdown", reply_markup: harmonyKeyboard() }
      );
    } catch (err) {
      await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  });

  // ── Filtered views ──────────────────────────────────────────────────────────
  const filterLabels: Record<string, string> = {
    connection: "🔌 CONNECTION LOGS",
    backup: "💾 BACKUP LOGS",
    storage: "📦 STORAGE LOGS",
    integrity: "🧩 INTEGRITY LOGS",
    all: "📋 ALL LOGS",
  };

  bot.callbackQuery(/^harmony:filter:(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery();
    try {
      const type = ctx.match[1] as string;
      const rows = type === "all"
        ? await db.select().from(externalDbLogsTable).orderBy(desc(externalDbLogsTable.createdAt)).limit(20)
        : await db.select().from(externalDbLogsTable)
            .where(eq(externalDbLogsTable.checkType, type))
            .orderBy(desc(externalDbLogsTable.createdAt)).limit(15);

      const lines = rows.length === 0
        ? "_No entries found._"
        : rows.map((r) =>
            `${statusEmoji(r.status)} *${formatDate(new Date(r.createdAt))}* — ${r.message}` +
            (r.details ? `\n   ↳ _${r.details}_` : "")
          ).join("\n\n");

      await ctx.editMessageText(
        `🩺 *HARMONY DB — ${filterLabels[type] ?? "LOGS"}*\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Harmony DB", "extdblogs:main") }
      );
    } catch (err) {
      await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  });

  // ── Manual backup now ───────────────────────────────────────────────────────
  bot.callbackQuery("harmony:backup", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery("💾 Starting backup...");
    try {
      await ctx.editMessageText(
        `💾 *HARMONY DB — BACKUP*\n━━━━━━━━━━━━━━━━━━\n\n⏳ Backup in progress...\n_Dumping all tables and sending to your DM._`,
        { parse_mode: "Markdown" }
      );
      await runAutomatedBackup(bot, ctx.from.id);

      // Refresh panel
      const recent = await db.select().from(externalDbLogsTable)
        .orderBy(desc(externalDbLogsTable.createdAt)).limit(8);
      const lines = recent.map((r) => `${statusEmoji(r.status)} *${r.checkType}* — ${r.message}`).join("\n\n");
      await ctx.editMessageText(
        `🩺 *HARMONY DB — HEALTH MONITOR*\n━━━━━━━━━━━━━━━━━━\n\n${lines || "_No logs yet._"}`,
        { parse_mode: "Markdown", reply_markup: harmonyKeyboard() }
      );
    } catch (err) {
      await ctx.reply(`❌ Backup error: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  });

  // ── Run all checks ──────────────────────────────────────────────────────────
  bot.callbackQuery("harmony:check", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery("🔍 Running all checks...");
    try {
      await ctx.editMessageText(
        `🩺 *HARMONY DB — HEALTH MONITOR*\n━━━━━━━━━━━━━━━━━━\n\n⏳ Running checks — results will arrive as notifications...`,
        { parse_mode: "Markdown" }
      );
      await runExternalDbChecks(bot, ctx.from.id);

      const recent = await db
        .select().from(externalDbLogsTable)
        .orderBy(desc(externalDbLogsTable.createdAt)).limit(8);

      const lines = recent.map((r) => `${statusEmoji(r.status)} *${r.checkType}* — ${r.message}`).join("\n\n");
      await ctx.editMessageText(
        `🩺 *HARMONY DB — HEALTH MONITOR*\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
        { parse_mode: "Markdown", reply_markup: harmonyKeyboard() }
      );
    } catch (err) {
      await ctx.reply(`❌ Check failed: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  });
}
