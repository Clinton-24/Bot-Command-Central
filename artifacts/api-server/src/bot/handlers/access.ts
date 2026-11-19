/**
 * ACCESS CONTROL SYSTEM
 * Tiers: free | premium | vip | blocked
 * Invites: owner codes OR referral @username / Telegram ID
 */

import { InlineKeyboard } from "grammy";
import { eq, desc, sql } from "drizzle-orm";
import { HDNodeWallet } from "ethers";
import { db, accessTable, inviteCodesTable, usersTable, paymentSettingsTable, tierSubscriptionsTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";
import { checkCryptoBotInvoice, createCryptoBotInvoice, CRYPTOBOT_ASSETS, type CryptoBotAsset } from "./cryptobot";

const TIER_RANK: Record<string, number> = { free: 1, premium: 2, vip: 3 };
export const TIER_EMOJI: Record<string, string> = { free: "🟢", premium: "💎", vip: "👑", blocked: "🚫" };
export const TIER_LABEL: Record<string, string> = { free: "Free", premium: "Premium", vip: "VIP", blocked: "Blocked" };
export const VIP_MONTHLY_PRICE = 10;
export const PREMIUM_MONTHLY_PRICE_DEFAULT = 20;

export function premiumMonthlyPrice(): number {
  const configured = Number(process.env["PREMIUM_MONTHLY_PRICE"] ?? String(PREMIUM_MONTHLY_PRICE_DEFAULT));
  return Number.isFinite(configured) && configured > 0 ? configured : PREMIUM_MONTHLY_PRICE_DEFAULT;
}

export function tierMonthlyPrice(tier: "premium" | "vip"): number {
  return tier === "vip" ? VIP_MONTHLY_PRICE : premiumMonthlyPrice();
}

export function tierRank(tier: string): number {
  return TIER_RANK[tier] ?? 0;
}

export async function checkAccess(
  ctx: BotContext,
  requiredTier: "free" | "premium" | "vip" = "free"
): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (isOwner(userId)) return true;

  try {
    const [record] = await db.select().from(accessTable).where(eq(accessTable.userId, userId));

    if (!record) {
      await sendRequestAccessMessage(ctx);
      return false;
    }

    if (record.tier === "blocked") {
      await ctx.reply(
        `🚫 *Access Denied*\n━━━━━━━━━━━━━━━━━━\n\nYour account has been blocked.\n${record.blockedReason ? `_Reason: ${record.blockedReason}_` : ""}`,
        { parse_mode: "Markdown" }
      );
      return false;
    }

    if (!record.isApproved) {
      if (record.isPending) {
        await ctx.reply(
          `⏳ *Pending Approval*\n━━━━━━━━━━━━━━━━━━\n\nYour access request is being reviewed.\n\n_You'll receive a notification once approved._`,
          { parse_mode: "Markdown" }
        );
      } else {
        await sendRequestAccessMessage(ctx);
      }
      return false;
    }

    if (record.expiresAt && record.expiresAt < new Date()) {
      await db.update(accessTable).set({ isApproved: false, isPending: false }).where(eq(accessTable.userId, userId));
      await ctx.reply(
        `⏰ *Access Expired*\n━━━━━━━━━━━━━━━━━━\n\nYour access has expired. Request renewal below.`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔑 Request Renewal", "access:request") }
      );
      return false;
    }

    if (tierRank(record.tier) < tierRank(requiredTier)) {
      await ctx.reply(
        `💎 *${TIER_LABEL[requiredTier] ?? requiredTier} Required*\n━━━━━━━━━━━━━━━━━━\n\nThis feature requires *${TIER_LABEL[requiredTier]}* access.\nYour current tier: ${TIER_EMOJI[record.tier] ?? ""} *${TIER_LABEL[record.tier] ?? record.tier}*\n\n_Contact the owner to upgrade._`,
        { parse_mode: "Markdown" }
      );
      return false;
    }

    await db.update(accessTable)
      .set({ lastSeenAt: new Date(), totalMessages: (record.totalMessages ?? 0) + 1 })
      .where(eq(accessTable.userId, userId))
      .catch(() => {});

    return true;
  } catch (err) {
    logger.error({ err }, "checkAccess error");
    return false;
  }
}

export * from "./access-body";
