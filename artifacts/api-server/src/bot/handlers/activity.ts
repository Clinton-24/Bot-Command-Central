/**
 * Owner activity alerts — notify when any non-owner uses the bot.
 * Debounced per user (default 5 min).
 */
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";
import { pool, accessTable, db } from "@workspace/db";
import { eq } from "drizzle-orm";

const COOLDOWN_MS = Number(process.env.ACTIVITY_ALERT_COOLDOWN_MS ?? 5 * 60 * 1000);

function ownerId(): number | null {
  const raw = process.env.BOT_OWNER_ID;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

async function getAccessLabel(userId: number): Promise<string> {
  try {
    const [row] = await db.select().from(accessTable).where(eq(accessTable.userId, userId));
    if (!row) return "no access row";
    if (row.tier === "blocked") return "blocked";
    if (!row.isApproved) return "pending";
    return `${row.tier || "free"} (approved)`;
  } catch {
    return "unknown";
  }
}

async function shouldAlert(userId: number): Promise<boolean> {
  try {
    const { rows } = await pool.query<{ last_alert_at: Date | null }>(
      `SELECT last_alert_at FROM user_activity_alerts WHERE user_id = $1`,
      [userId],
    );
    const last = rows[0]?.last_alert_at ? new Date(rows[0].last_alert_at).getTime() : 0;
    if (Date.now() - last < COOLDOWN_MS) {
      await pool.query(
        `INSERT INTO user_activity_alerts (user_id, last_seen_at)
         VALUES ($1, NOW())
         ON CONFLICT (user_id) DO UPDATE SET last_seen_at = NOW()`,
        [userId],
      );
      return false;
    }
    await pool.query(
      `INSERT INTO user_activity_alerts (user_id, last_seen_at, last_alert_at)
       VALUES ($1, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE
         SET last_seen_at = NOW(), last_alert_at = NOW()`,
      [userId],
    );
    return true;
  } catch (err) {
    logger.warn({ err, userId }, "activity alert check failed");
    return false;
  }
}

function describeUpdate(ctx: BotContext): string {
  if (ctx.message?.text) {
    const t = ctx.message.text.trim();
    if (t.startsWith("/")) return `command ${t.split(/\s+/)[0]}`;
    return `message: "${t.slice(0, 80)}${t.length > 80 ? "…" : ""}"`;
  }
  if (ctx.message?.photo) return "sent a photo";
  if (ctx.callbackQuery?.data) return `button: ${ctx.callbackQuery.data}`;
  if (ctx.inlineQuery) return `inline: "${(ctx.inlineQuery.query || "").slice(0, 60)}"`;
  if (ctx.message) return "sent an update";
  return "active";
}

export function activityAlertMiddleware(bot: MyBot) {
  return async (ctx: BotContext, next: () => Promise<void>) => {
    const uid = ctx.from?.id;
    const oid = ownerId();

    await next();

    if (!uid || !oid || isOwner(uid)) return;
    if (ctx.chat && ctx.chat.type !== "private" && !ctx.message?.text?.startsWith("/") && !ctx.callbackQuery) {
      return;
    }
    if (!ctx.message && !ctx.callbackQuery && !ctx.inlineQuery) return;

    try {
      const alert = await shouldAlert(uid);
      if (!alert) return;

      const name = ctx.from?.first_name ?? "User";
      const uname = ctx.from?.username ? `@${ctx.from.username}` : "no username";
      const what = describeUpdate(ctx);
      const access = await getAccessLabel(uid);
      const mins = Math.max(1, Math.round(COOLDOWN_MS / 60000));

      await bot.api
        .sendMessage(
          oid,
          `🔔 User active\n━━━━━━━━━━━━━━━━━━\n\n` +
            `👤 ${name} (${uname})\n` +
            `🆔 ${uid}\n` +
            `🔑 Access: ${access}\n` +
            `📍 ${what}\n\n` +
            `Next alert for this user in ~${mins} min if still active.`,
        )
        .catch((err) => logger.warn({ err }, "owner activity notify failed"));
    } catch (err) {
      logger.warn({ err }, "activity middleware error");
    }
  };
}

export function registerActivityCommands(bot: MyBot): void {
  bot.command("online", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner only.");
      return;
    }
    try {
      const { rows } = await pool.query<{ user_id: string; last_seen_at: Date }>(
        `SELECT user_id, last_seen_at
         FROM user_activity_alerts
         WHERE last_seen_at > NOW() - INTERVAL '24 hours'
         ORDER BY last_seen_at DESC
         LIMIT 30`,
      );
      if (rows.length === 0) {
        await ctx.reply("No user activity in the last 24 hours.");
        return;
      }
      const lines = rows.map((r) => {
        const seen = new Date(r.last_seen_at).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" });
        return `• ${r.user_id} — ${seen}`;
      });
      await ctx.reply(`👀 Active (24h)\n━━━━━━━━━━━━━━━━━━\n\n${lines.join("\n")}`);
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Failed"}`);
    }
  });
}
