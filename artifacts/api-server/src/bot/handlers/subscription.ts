/**
 * SUBSCRIPTION & TIER SYSTEM
 * ─────────────────────────────────────────────────────────────────────────────
 * Free  — Referral required (inviter must be active user), limited features
 * Premium — $10/month — full shop + AI access
 * VIP    — $10/month — everything + priority + Harmony DB access
 *
 * Payment flow: user selects Premium/VIP → shown crypto addresses → confirms payment
 * → owner verifies → tier upgraded
 *
 * Free tier limits:
 * - 5 AI queries/day (vs 50 for premium/vip)
 * - No Harmony DB access
 * - No Bank Logs access
 * - Can browse shop and buy products
 * - Must provide referral (active user) on signup
 */

import { InlineKeyboard } from "grammy";
import { md, safeName, safeUsername } from "../utils/escape";
import { eq, desc } from "drizzle-orm";
import { db, accessTable, paymentSettingsTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { TIER_EMOJI, TIER_LABEL, getAccess } from "./access";
import { logger } from "../../lib/logger";

// ── Tier config ───────────────────────────────────────────────────────────────

export const TIER_PRICES: Record<string, { monthly: number; label: string }> = {
  free:    { monthly: 0,  label: "Free" },
  premium: { monthly: 10, label: "Premium — $10/month" },
  vip:     { monthly: 10, label: "VIP — $10/month" },
};

export const TIER_FEATURES: Record<string, string[]> = {
  free: [
    "✅ Browse & buy products",
    "✅ 5 AI queries per day",
    "✅ Basic bot features",
    "❌ Harmony DB access",
    "❌ Bank Logs panel",
    "❌ Advanced AI features",
    "❌ Priority support",
  ],
  premium: [
    "✅ Everything in Free",
    "✅ 50 AI queries per day",
    "✅ Full shop access",
    "✅ Bank Logs panel",
    "✅ Advanced AI features",
    "✅ Priority support",
    "❌ Harmony DB access",
  ],
  vip: [
    "✅ Everything in Premium",
    "✅ Unlimited AI queries",
    "✅ Harmony DB access",
    "✅ Group analyst",
    "✅ Agent mode",
    "✅ Daily business reports",
    "✅ VIP priority support",
  ],
};

// ── Free tier daily AI limit ──────────────────────────────────────────────────

export const FREE_AI_LIMIT = 5;
export const PREMIUM_AI_LIMIT = 50;

export async function getTierAILimit(userId: number): Promise<number> {
  if (isOwner(userId)) return 999;
  const rec = await getAccess(userId);
  if (!rec || !rec.isApproved) return 0;
  if (rec.tier === "vip") return 999;
  if (rec.tier === "premium") return PREMIUM_AI_LIMIT;
  return FREE_AI_LIMIT;
}

export async function canAccessFeature(userId: number, feature: "harmony_db" | "bank_logs" | "ai_advanced" | "agent"): Promise<boolean> {
  if (isOwner(userId)) return true;
  const rec = await getAccess(userId);
  if (!rec?.isApproved) return false;

  const featureTiers: Record<string, string[]> = {
    harmony_db:  ["vip"],
    bank_logs:   ["premium", "vip"],
    ai_advanced: ["premium", "vip"],
    agent:       ["vip"],
  };

  return (featureTiers[feature] ?? []).includes(rec.tier);
}

// ── Payment helper ────────────────────────────────────────────────────────────

async function getPaymentAddresses(): Promise<{ bnb?: string; trc20?: string; btc?: string; eth?: string } | null> {
  const ownerId = parseInt(process.env.BOT_OWNER_ID ?? "0");
  if (!ownerId) return null;
  try {
    const [settings] = await db.select().from(paymentSettingsTable).where(eq(paymentSettingsTable.ownerId, ownerId));
    if (!settings) return null;
    return {
      bnb:   settings.bnbAddress ?? undefined,
      trc20: settings.trc20Address ?? undefined,
      btc:   settings.btcAddress ?? undefined,
      eth:   settings.ethAddress ?? undefined,
    };
  } catch { return null; }
}

// ── Subscription panel keyboard ───────────────────────────────────────────────

function subscriptionKeyboard(currentTier: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (currentTier !== "premium") {
    kb.text("💎 Upgrade to Premium — $10/mo", "sub:buy:premium").row();
  }
  if (currentTier !== "vip") {
    kb.text("👑 Upgrade to VIP — $10/mo", "sub:buy:vip").row();
  }
  if (currentTier === "free") {
    kb.text("🟢 Stay Free (Limited)", "sub:stay_free").row();
  }
  kb.text("🔙 Back", "menu:main");
  return kb;
}

// ── Register handlers ─────────────────────────────────────────────────────────

export function registerSubscriptionHandlers(bot: MyBot): void {

  // ── /subscribe — show tier options ────────────────────────────────────────
  bot.command("subscribe", async (ctx) => {
    if (!ctx.from) return;
    const rec = await getAccess(ctx.from.id);
    if (!rec?.isApproved && !isOwner(ctx.from.id)) {
      await ctx.reply("🔐 You need access first. Use /start to request.");
      return;
    }
    const tier = rec?.tier ?? "free";
    await showSubscriptionPanel(ctx, tier);
  });

  // ── Show subscription panel callback ──────────────────────────────────────
  bot.callbackQuery("sub:panel", async (ctx) => {
    await ctx.answerCallbackQuery();
    const rec = await getAccess(ctx.from.id);
    await showSubscriptionPanel(ctx, rec?.tier ?? "free");
  });

  // ── Buy Premium or VIP ────────────────────────────────────────────────────
  bot.callbackQuery(/^sub:buy:(premium|vip)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const targetTier = ctx.match[1] as "premium" | "vip";
    const userId = ctx.from.id;
    const emoji = TIER_EMOJI[targetTier] ?? "";
    const label = TIER_LABEL[targetTier] ?? targetTier;
    const price = TIER_PRICES[targetTier]?.monthly ?? 10;

    const addresses = await getPaymentAddresses();

    if (!addresses || Object.values(addresses).every((v) => !v)) {
      await ctx.editMessageText(
        "⚠️ Payment addresses not configured yet.\n\nContact the owner to complete your upgrade.",
        { reply_markup: new InlineKeyboard().text("🔙 Back", "sub:panel") }
      );
      return;
    }

    // Build payment instructions
    const lines = [
      `${emoji} UPGRADE TO ${label.toUpperCase()}`,
      "━━━━━━━━━━━━━━━━━━",
      "",
      `Amount: $${price} USD equivalent`,
      "Duration: 1 month",
      "",
      "Send payment to any of these addresses:",
      "",
    ];

    if (addresses.trc20) lines.push(`USDT (TRC20):\n${addresses.trc20}`);
    if (addresses.bnb)   lines.push(`BNB/USDT (BEP20):\n${addresses.bnb}`);
    if (addresses.btc)   lines.push(`BTC:\n${addresses.btc}`);
    if (addresses.eth)   lines.push(`ETH:\n${addresses.eth}`);

    lines.push("");
    lines.push("After paying tap the button below.");
    lines.push("Include your Telegram ID in the memo if possible.");

    // Notify owner of pending payment
    const ownerIdStr = process.env.BOT_OWNER_ID;
    if (ownerIdStr) {
      const name = ctx.from.first_name ?? "User";
      const username = ctx.from.username ? ` (@${ctx.from.username})` : "";
      bot.api.sendMessage(
        parseInt(ownerIdStr),
        [
          "💳 PAYMENT INTENT",
          "━━━━━━━━━━━━━━━━━━",
          "",
          `👤 ${md(name)}${safeUsername(username?.replace("@",""))}`,
          `🆔 ${userId}`,
          `🎯 Wants: ${label}`,
          `💰 Amount: $${price}`,
          "",
          "Approve once payment is confirmed:",
        ].join("\n"),
        {
          reply_markup: new InlineKeyboard()
            .text(`${emoji} Confirm & Upgrade`, `sub:confirm:${userId}:${targetTier}`)
            .text("🚫 Reject", `sub:reject:${userId}`),
        }
      ).catch(() => {});
    }

    await ctx.editMessageText(
      lines.join("\n"),
      {
        reply_markup: new InlineKeyboard()
          .text("✅ I Have Paid", `sub:paid:${targetTier}`)
          .row()
          .text("🔙 Back", "sub:panel"),
      }
    );
  });

  // ── User confirms payment sent ─────────────────────────────────────────────
  bot.callbackQuery(/^sub:paid:(premium|vip)$/, async (ctx) => {
    await ctx.answerCallbackQuery("✅ Payment confirmed — awaiting verification");
    const targetTier = ctx.match[1] as "premium" | "vip";
    const userId = ctx.from.id;
    const name = ctx.from.first_name ?? "User";
    const username = ctx.from.username ? ` (@${ctx.from.username})` : "";
    const emoji = TIER_EMOJI[targetTier] ?? "";
    const label = TIER_LABEL[targetTier] ?? targetTier;

    await ctx.editMessageText(
      [
        "⏳ PAYMENT SUBMITTED",
        "━━━━━━━━━━━━━━━━━━",
        "",
        `You've marked your ${label} payment as sent.`,
        "",
        "The owner will verify and upgrade your account.",
        "You'll receive a notification once confirmed.",
      ].join("\n"),
      { reply_markup: new InlineKeyboard().text("🔙 Main Menu", "menu:main") }
    );

    // Remind owner
    const ownerIdStr = process.env.BOT_OWNER_ID;
    if (ownerIdStr) {
      bot.api.sendMessage(
        parseInt(ownerIdStr),
        [
          "💰 PAYMENT CLAIMED",
          "━━━━━━━━━━━━━━━━━━",
          "",
          `👤 ${md(name)}${safeUsername(username?.replace("@",""))}`,
          `🆔 ${userId}`,
          `${emoji} Claims to have paid for ${label}`,
          "",
          "Verify payment then confirm:",
        ].join("\n"),
        {
          reply_markup: new InlineKeyboard()
            .text(`${emoji} Confirm Upgrade`, `sub:confirm:${userId}:${targetTier}`)
            .text("🚫 Reject", `sub:reject:${userId}`),
        }
      ).catch(() => {});
    }
  });

  // ── Owner: confirm upgrade ────────────────────────────────────────────────
  bot.callbackQuery(/^sub:confirm:(\d+):(premium|vip)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    const tier = ctx.match[2] as "premium" | "vip";
    const emoji = TIER_EMOJI[tier] ?? "";
    const label = TIER_LABEL[tier] ?? tier;

    try {
      // Set expiry 30 days from now
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 30);

      await db.update(accessTable)
        .set({ tier, isApproved: true, approvedAt: new Date(), approvedBy: ctx.from.id, expiresAt })
        .where(eq(accessTable.userId, userId));

      await ctx.answerCallbackQuery(`${emoji} Upgraded to ${label}`);
      await ctx.editMessageText(
        `${emoji} CONFIRMED\n\nUser ${userId} upgraded to ${label}\nExpires: ${expiresAt.toDateString()}`,
        { reply_markup: new InlineKeyboard() }
      ).catch(() => {});

      // Notify user
      await bot.api.sendMessage(
        userId,
        [
          `${emoji} SUBSCRIPTION ACTIVATED`,
          "━━━━━━━━━━━━━━━━━━",
          "",
          `Your ${label} subscription is now active!`,
          `Valid until: ${expiresAt.toDateString()}`,
          "",
          "Tap below to access all features:",
        ].join("\n"),
        { reply_markup: new InlineKeyboard().text("⚡ Open Bot Panel", "menu:main") }
      ).catch(() => {});
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  // ── Owner: reject payment ─────────────────────────────────────────────────
  bot.callbackQuery(/^sub:reject:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    await ctx.answerCallbackQuery("🚫 Rejected");
    await ctx.editMessageText("🚫 Payment rejected.", { reply_markup: new InlineKeyboard() }).catch(() => {});
    await bot.api.sendMessage(
      userId,
      "🚫 Your payment could not be verified.\n\nPlease contact the owner or try again.",
      { reply_markup: new InlineKeyboard().text("💳 Try Again", "sub:panel") }
    ).catch(() => {});
  });

  // ── Stay free ─────────────────────────────────────────────────────────────
  bot.callbackQuery("sub:stay_free", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      [
        "🟢 FREE TIER",
        "━━━━━━━━━━━━━━━━━━",
        "",
        "You're staying on Free.",
        "",
        "Free includes:",
        ...TIER_FEATURES.free,
        "",
        "Upgrade anytime for full access.",
      ].join("\n"),
      { reply_markup: new InlineKeyboard().text("💎 Upgrade", "sub:panel").text("🔙 Menu", "menu:main") }
    );
  });
}

// ── Show subscription panel ───────────────────────────────────────────────────

async function showSubscriptionPanel(ctx: BotContext, currentTier: string): Promise<void> {
  const emoji = TIER_EMOJI[currentTier] ?? "🟢";
  const label = TIER_LABEL[currentTier] ?? currentTier;
  const features = TIER_FEATURES[currentTier] ?? [];

  const text = [
    "💳 SUBSCRIPTION",
    "━━━━━━━━━━━━━━━━━━",
    "",
    `Current tier: ${emoji} ${label}`,
    "",
    "Your features:",
    ...features,
    "",
    "━━━━━━━━━━━━━━━━━━",
    "💎 Premium — $10/mo",
    "👑 VIP — $10/mo (includes Harmony DB)",
  ].join("\n");

  const kb = subscriptionKeyboard(currentTier);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { reply_markup: kb }).catch(() =>
      ctx.reply(text, { reply_markup: kb })
    );
  } else {
    await ctx.reply(text, { reply_markup: kb });
  }
}
