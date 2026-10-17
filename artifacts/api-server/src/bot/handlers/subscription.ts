/**
 * SUBSCRIPTION & TIER SYSTEM
 * Free — auto on /start; bank logs + AI 10/day + card tools 4/day
 * Premium / VIP — full shop categories + higher limits
 * Owner — unlimited, no upgrade UI
 */

import { InlineKeyboard } from "grammy";
import { eq } from "drizzle-orm";
import { db, accessTable, paymentSettingsTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { TIER_EMOJI, TIER_LABEL, getAccess } from "./access";
import { logger } from "../../lib/logger";

export const TIER_PRICES: Record<string, { monthly: number; label: string }> = {
  free: { monthly: 0, label: "Free" },
  premium: { monthly: 20, label: "Premium — $20/month" },
  vip: { monthly: 10, label: "VIP — $10/month" },
};

export const TIER_FEATURES: Record<string, string[]> = {
  free: [
    "✅ Bank Logs (shop)",
    "✅ Crescent AI — 10 queries/day",
    "✅ Card Tools — 4 uses/day",
    "❌ Product categories (Premium+)",
    "❌ Higher AI quota",
  ],
  premium: [
    "✅ Everything in Free",
    "✅ Full product categories",
    "✅ Crescent AI — 100 queries/day",
    "✅ Card Tools — 50 uses/day",
    "✅ Priority support",
  ],
  vip: [
    "✅ Everything in Premium",
    "✅ Crescent AI — 200 queries/day",
    "✅ Card Tools — 999 uses/day",
    "✅ Group analyst & agent mode",
    "✅ VIP priority support",
  ],
};

export const FREE_AI_LIMIT = 10;
export const PREMIUM_AI_LIMIT = 100;
export const VIP_AI_LIMIT = 200;

export async function getTierAILimit(userId: number): Promise<number> {
  if (isOwner(userId)) return Number.POSITIVE_INFINITY;
  const rec = await getAccess(userId);
  if (!rec || !rec.isApproved) return 0;
  if (rec.tier === "vip") return VIP_AI_LIMIT;
  if (rec.tier === "premium") return PREMIUM_AI_LIMIT;
  return FREE_AI_LIMIT;
}

export async function canAccessFeature(
  userId: number,
  feature: "harmony_db" | "bank_logs" | "ai_advanced" | "agent" | "shop_categories",
): Promise<boolean> {
  if (isOwner(userId)) return true;
  const rec = await getAccess(userId);
  if (!rec?.isApproved || rec.tier === "blocked") return false;

  const featureTiers: Record<string, string[]> = {
    bank_logs: ["free", "premium", "vip"],
    shop_categories: ["premium", "vip"],
    harmony_db: ["vip"],
    ai_advanced: ["premium", "vip"],
    agent: ["vip"],
  };

  return (featureTiers[feature] ?? []).includes(rec.tier);
}

async function getPaymentAddresses(): Promise<{
  bnb?: string;
  trc20?: string;
  btc?: string;
  eth?: string;
} | null> {
  const ownerId = parseInt(process.env.BOT_OWNER_ID ?? "0");
  if (!ownerId) return null;
  try {
    const [settings] = await db
      .select()
      .from(paymentSettingsTable)
      .where(eq(paymentSettingsTable.ownerId, ownerId));
    if (!settings) return null;
    return {
      bnb: settings.bnbAddress ?? undefined,
      trc20: settings.trc20Address ?? undefined,
      btc: settings.btcAddress ?? undefined,
      eth: settings.ethAddress ?? undefined,
    };
  } catch {
    return null;
  }
}

function subscriptionKeyboard(currentTier: string, asOwner: boolean): InlineKeyboard {
  if (asOwner) {
    return new InlineKeyboard().text("🏠 Main Menu", "menu:main");
  }
  const kb = new InlineKeyboard();
  if (currentTier !== "premium") {
    kb.text("💎 Upgrade to Premium — $20/mo", "sub:buy:premium").row();
  }
  if (currentTier !== "vip") {
    kb.text("👑 Upgrade to VIP — $10/mo", "sub:buy:vip").row();
  }
  if (currentTier === "free") {
    kb.text("🟢 Stay Free (Limited)", "sub:stay_free").row();
  }
  kb.text("🏠 Main Menu", "menu:main");
  return kb;
}

export function registerSubscriptionHandlers(bot: MyBot): void {
  bot.command("plans", async (ctx) => {
    if (!ctx.from) return;
    if (isOwner(ctx.from.id)) {
      await showSubscriptionPanel(ctx, "owner", true);
      return;
    }
    const rec = await getAccess(ctx.from.id).catch(() => null);
    await showSubscriptionPanel(ctx, rec?.tier ?? "free", false);
  });

  bot.command("subscribe", async (ctx) => {
    if (!ctx.from) return;
    if (isOwner(ctx.from.id)) {
      await showSubscriptionPanel(ctx, "owner", true);
      return;
    }
    const rec = await getAccess(ctx.from.id).catch(() => null);
    await showSubscriptionPanel(ctx, rec?.tier ?? "free", false);
  });

  bot.callbackQuery("sub:panel", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (isOwner(ctx.from!.id)) {
      await showSubscriptionPanel(ctx, "owner", true);
      return;
    }
    const rec = await getAccess(ctx.from!.id).catch(() => null);
    await showSubscriptionPanel(ctx, rec?.tier ?? "free", false);
  });

  bot.callbackQuery(/^sub:buy:(premium|vip)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (isOwner(ctx.from!.id)) {
      await ctx.reply("👑 You are the owner — unlimited access. No upgrade needed.");
      return;
    }
    const targetTier = ctx.match![1] as "premium" | "vip";
    const emoji = TIER_EMOJI[targetTier] ?? "";
    const label = TIER_LABEL[targetTier] ?? targetTier;
    const price = TIER_PRICES[targetTier]?.monthly ?? 10;
    const addrs = await getPaymentAddresses();

    let payText =
      `${emoji} ${label}\n━━━━━━━━━━━━━━━━━━\n\n` +
      `Price: $${price} / 30 days\n\n`;

    if (addrs && (addrs.bnb || addrs.trc20 || addrs.btc || addrs.eth)) {
      payText += "Pay to one of these addresses, then tap I've Paid:\n\n";
      if (addrs.bnb) payText += `BNB/BEP20:\n${addrs.bnb}\n\n`;
      if (addrs.trc20) payText += `USDT-TRC20:\n${addrs.trc20}\n\n`;
      if (addrs.btc) payText += `BTC:\n${addrs.btc}\n\n`;
      if (addrs.eth) payText += `ETH:\n${addrs.eth}\n\n`;
    } else {
      payText +=
        "Payment addresses not configured yet.\nUse CryptoBot from Access Plans or contact the owner.\n\n";
    }

    await ctx.editMessageText(payText, {
      reply_markup: new InlineKeyboard()
        .text("✅ I've Paid", `sub:paid:${targetTier}`)
        .row()
        .text("🔙 Plans", "sub:panel"),
    });
  });

  bot.callbackQuery(/^sub:paid:(premium|vip)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Notifying owner…");
    if (isOwner(ctx.from!.id)) return;
    const targetTier = ctx.match![1] as "premium" | "vip";
    const userId = ctx.from!.id;
    const emoji = TIER_EMOJI[targetTier] ?? "";
    const label = TIER_LABEL[targetTier] ?? targetTier;
    const ownerId = parseInt(process.env.BOT_OWNER_ID ?? "0");

    await ctx.editMessageText(
      `⏳ Payment claim sent.\n\nOwner will confirm ${label} access shortly.`,
      { reply_markup: new InlineKeyboard().text("🏠 Menu", "menu:main") },
    );

    if (ownerId) {
      await bot.api
        .sendMessage(
          ownerId,
          `💳 SUBSCRIPTION CLAIM\n━━━━━━━━━━━━━━━━━━\n\n` +
            `User: ${ctx.from!.first_name ?? "?"} (${userId})\n` +
            `Tier: ${emoji} ${label}\n\nConfirm after verifying payment:`,
          {
            reply_markup: new InlineKeyboard()
              .text(`${emoji} Confirm Upgrade`, `sub:confirm:${userId}:${targetTier}`)
              .row()
              .text("🚫 Reject", `sub:reject:${userId}`),
          },
        )
        .catch((err) => logger.error({ err }, "sub paid notify failed"));
    }
  });

  bot.callbackQuery(/^sub:confirm:(\d+):(premium|vip)$/, async (ctx) => {
    if (!isOwner(ctx.from!.id)) {
      await ctx.answerCallbackQuery("Owner only");
      return;
    }
    const userId = parseInt(ctx.match![1]!, 10);
    const tier = ctx.match![2]!;
    const emoji = TIER_EMOJI[tier] ?? "";
    const label = TIER_LABEL[tier] ?? tier;
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    try {
      await db
        .insert(accessTable)
        .values({
          userId,
          tier,
          isApproved: true,
          isPending: false,
          approvedAt: new Date(),
          approvedBy: ctx.from!.id,
          expiresAt,
        })
        .onConflictDoUpdate({
          target: accessTable.userId,
          set: {
            tier,
            isApproved: true,
            isPending: false,
            approvedAt: new Date(),
            approvedBy: ctx.from!.id,
            expiresAt,
          },
        });

      await ctx.answerCallbackQuery("Upgraded");
      await ctx.editMessageText(`✅ User ${userId} → ${emoji} ${label}`);

      await bot.api
        .sendMessage(
          userId,
          `✅ ${emoji} ${label} is now active!\nValid until: ${expiresAt.toDateString()}\n\nTap below to open the panel:`,
          { reply_markup: new InlineKeyboard().text("⚡ Open Bot Panel", "menu:main") },
        )
        .catch(() => {});
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  bot.callbackQuery(/^sub:reject:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from!.id)) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    const userId = parseInt(ctx.match![1]!, 10);
    await ctx.answerCallbackQuery("Rejected");
    await ctx.editMessageText("🚫 Payment rejected.").catch(() => {});
    await bot.api
      .sendMessage(
        userId,
        "🚫 Your payment could not be verified.\n\nPlease contact the owner or try again.",
        { reply_markup: new InlineKeyboard().text("💳 Try Again", "sub:panel") },
      )
      .catch(() => {});
  });

  bot.callbackQuery("sub:stay_free", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (isOwner(ctx.from!.id)) {
      await showSubscriptionPanel(ctx, "owner", true);
      return;
    }
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
      {
        reply_markup: new InlineKeyboard()
          .text("💎 Upgrade", "sub:panel")
          .text("🔙 Menu", "menu:main"),
      },
    );
  });
}

async function showSubscriptionPanel(
  ctx: BotContext,
  currentTier: string,
  asOwner = false,
): Promise<void> {
  if (asOwner || currentTier === "owner") {
    const text = [
      "👑 OWNER",
      "━━━━━━━━━━━━━━━━━━",
      "",
      "You are the bot owner.",
      "Tier: Unlimited (not Free / Premium / VIP)",
      "",
      "• Crescent AI — unlimited",
      "• Card Tools — unlimited",
      "• Full shop + Hex panel",
      "• No upgrade required",
    ].join("\n");
    const kb = subscriptionKeyboard("owner", true);
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { reply_markup: kb }).catch(() =>
        ctx.reply(text, { reply_markup: kb }),
      );
    } else {
      await ctx.reply(text, { reply_markup: kb });
    }
    return;
  }

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
    "💎 Premium — $20/mo",
    "👑 VIP — $10/mo",
  ].join("\n");

  const kb = subscriptionKeyboard(currentTier, false);

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { reply_markup: kb }).catch(() =>
      ctx.reply(text, { reply_markup: kb }),
    );
  } else {
    await ctx.reply(text, { reply_markup: kb });
  }
}
