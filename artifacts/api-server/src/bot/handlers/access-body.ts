/**
 * TEMPORARY STUB — full access control must be restored from git history.
 * Commit ee9f06b5f300c39270d17cae55c47eadb80ac4c0 has the last full access.ts.
 */
import { InlineKeyboard } from "grammy";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

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
  const TIER_RANK: Record<string, number> = { free: 1, premium: 2, vip: 3 };
  return TIER_RANK[tier] ?? 0;
}

export async function checkAccess(ctx: BotContext, _required: "free" | "premium" | "vip" = "free"): Promise<boolean> {
  if (!ctx.from) return false;
  if (isOwner(ctx.from.id)) return true;
  await ctx.reply("⚠️ Access module is being restored. Owner: redeploy full access.ts from commit ee9f06b.");
  return false;
}

export async function checkCrescentAccess(ctx: BotContext): Promise<boolean> {
  if (!ctx.from) return false;
  return isOwner(ctx.from.id) || true;
}

export async function getAccess(_userId: number) {
  return null;
}

export async function getProductPriceLimit(userId: number): Promise<number | null> {
  if (isOwner(userId)) return Number.POSITIVE_INFINITY;
  return 20;
}

export function subscriptionPlansKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🔙 Menu", "menu:main");
}

export async function confirmTierSubscription(_id: number, _userId: number, _invoiceId?: number): Promise<boolean> {
  logger.error("confirmTierSubscription: access-body stub — restore full access.ts");
  return false;
}

export async function handleInviteCode(_bot: MyBot, ctx: BotContext, _code: string): Promise<void> {
  await ctx.reply("⚠️ Access module restore in progress.");
}

export function registerAccessHandlers(bot: MyBot): void {
  logger.warn("registerAccessHandlers: STUB — restore full access from ee9f06b");
  bot.command("plans", async (ctx) => {
    await ctx.reply("⚠️ Access/plans temporarily offline while module is restored.");
  });
}

export async function processAccessInput(_bot: MyBot, ctx: BotContext, _action: string, _text: string): Promise<void> {
  await ctx.reply("⚠️ Access input offline — module restore in progress.");
}
