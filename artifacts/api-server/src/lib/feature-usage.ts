/**
 * Daily per-feature usage counters (card tools, etc.)
 */
import { pool } from "@workspace/db";
import { logger } from "./logger";
import { isOwner } from "../bot/helpers";

function todayKey(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
}

async function getTier(userId: number): Promise<string> {
  try {
    const { getAccess } = await import("../bot/handlers/access");
    const access = await getAccess(userId);
    if (!access?.isApproved || access.tier === "blocked") return "blocked";
    return (access.tier || "free").toLowerCase();
  } catch {
    return "free";
  }
}

/** Free 4 / Premium 50 / VIP 999 / Owner unlimited */
export async function cardToolsDailyLimit(userId: number): Promise<number> {
  if (isOwner(userId)) return Number.POSITIVE_INFINITY;
  const tier = await getTier(userId);
  if (tier === "blocked") return 0;
  if (tier === "vip") return 999;
  if (tier === "premium") return 50;
  return 4;
}

export async function getFeatureUsage(
  userId: number,
  feature: string,
): Promise<{ used: number; limit: number; allowed: boolean }> {
  const limit = feature === "card_tools" ? await cardToolsDailyLimit(userId) : 0;
  if (!Number.isFinite(limit)) {
    return { used: 0, limit: Number.POSITIVE_INFINITY, allowed: true };
  }
  if (limit <= 0) return { used: 0, limit: 0, allowed: false };

  try {
    const day = todayKey();
    const { rows } = await pool.query<{ used: number }>(
      `SELECT used FROM feature_daily_usage WHERE user_id = $1 AND feature = $2 AND day = $3`,
      [userId, feature, day],
    );
    const used = Number(rows[0]?.used ?? 0);
    return { used, limit, allowed: used < limit };
  } catch (err) {
    logger.warn({ err, userId, feature }, "getFeatureUsage failed");
    return { used: 0, limit, allowed: true };
  }
}

/** Returns false if over limit (does not increment when blocked). */
export async function consumeFeatureUse(
  userId: number,
  feature: string,
): Promise<{ allowed: boolean; used: number; limit: number }> {
  const limit = feature === "card_tools" ? await cardToolsDailyLimit(userId) : 0;
  if (!Number.isFinite(limit)) {
    return { allowed: true, used: 0, limit: Number.POSITIVE_INFINITY };
  }
  if (limit <= 0) return { allowed: false, used: 0, limit: 0 };

  const day = todayKey();
  try {
    const { rows } = await pool.query<{ used: number }>(
      `INSERT INTO feature_daily_usage (user_id, feature, day, used)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (user_id, feature, day)
       DO UPDATE SET used = feature_daily_usage.used + 1
       WHERE feature_daily_usage.used < $4
       RETURNING used`,
      [userId, feature, day, limit],
    );
    if (!rows[0]) {
      const cur = await getFeatureUsage(userId, feature);
      return { allowed: false, used: cur.used, limit };
    }
    return { allowed: true, used: Number(rows[0].used), limit };
  } catch (err) {
    logger.warn({ err, userId, feature }, "consumeFeatureUse failed");
    return { allowed: true, used: 0, limit };
  }
}
