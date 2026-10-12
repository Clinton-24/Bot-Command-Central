/**
 * ACCESS CONTROL SYSTEM
 * ──────────────────────────────────────────────────────────────────
 * Tiers:  free (approved) | premium | vip | blocked
 * Flow:   /start → request access → owner approves → user unlocked
 * Invites: owner generates codes → user starts with /start <code>
 * Guard:  checkAccess(ctx, "premium") → blocks if not high enough tier
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

// ── Tier hierarchy ────────────────────────────────────────────────────────────

const TIER_RANK: Record<string, number> = { free: 1, premium: 2, vip: 3 };
export const TIER_EMOJI: Record<string, string> = { free: "🟢", premium: "💎", vip: "👑", blocked: "🚫" };
export const TIER_LABEL: Record<string, string> = { free: "Free", premium: "Premium", vip: "VIP", blocked: "Blocked" };
/** VIP plan: $10 / 30 days */
export const VIP_MONTHLY_PRICE = 10;
/** Premium plan: $20 / 30 days (override with PREMIUM_MONTHLY_PRICE env) */
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

// ── Core access check ─────────────────────────────────────────────────────────

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

export async function checkCrescentAccess(ctx: BotContext): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (isOwner(userId)) return true;

  try {
    const [record] = await db.select().from(accessTable).where(eq(accessTable.userId, userId));

    if (record?.tier === "blocked") {
      await ctx.reply(
        `🚫 *Access Denied*\n━━━━━━━━━━━━━━━━━━\n\nYour account has been blocked.${record.blockedReason ? `\n_Reason: ${record.blockedReason}_` : ""}`,
        { parse_mode: "Markdown" },
      );
      return false;
    }

    if (record?.expiresAt && record.expiresAt < new Date()) {
      await db.update(accessTable).set({ isApproved: false, isPending: false }).where(eq(accessTable.userId, userId));
      await ctx.reply("⏰ *Crescent access expired.*\n\nPlease contact the owner to renew access.", { parse_mode: "Markdown" });
      return false;
    }

    if (record) {
      await db.update(accessTable)
        .set({ lastSeenAt: new Date(), totalMessages: (record.totalMessages ?? 0) + 1 })
        .where(eq(accessTable.userId, userId))
        .catch(() => {});
    }

    return true;
  } catch (err) {
    logger.warn({ err, userId }, "Crescent access lookup unavailable; allowing chat access");
    return true;
  }
}

export async function getAccess(userId: number) {
  const [record] = await db.select().from(accessTable).where(eq(accessTable.userId, userId));
  if (record?.expiresAt && record.expiresAt < new Date()) {
    await db.update(accessTable).set({ isApproved: false, isPending: false }).where(eq(accessTable.userId, userId));
    return { ...record, isApproved: false, isPending: false };
  }
  return record ?? null;
}

export async function getProductPriceLimit(userId: number): Promise<number | null> {
  if (isOwner(userId)) return Number.POSITIVE_INFINITY;
  const access = await getAccess(userId);
  if (!access || !access.isApproved || access.tier === "blocked") return null;
  if (access.tier === "premium") return Number.POSITIVE_INFINITY;
  if (access.tier === "vip") return 50;
  return 20;
}

async function getSubscriptionCoins(): Promise<string[]> {
  const ownerId = Number(process.env["BOT_OWNER_ID"] ?? "0");
  if (!ownerId) return [];
  const [settings] = await db.select().from(paymentSettingsTable).where(eq(paymentSettingsTable.ownerId, ownerId));
  if (!settings) return [];
  const coins: string[] = [];
  if (settings.bnbAddress || settings.bnbXpub) coins.push("USDT-BEP20", "BNB");
  if (settings.trc20Address) coins.push("USDT-TRC20");
  if (settings.btcAddress) coins.push("BTC");
  if (settings.ethAddress) coins.push("ETH");
  return coins;
}

function subscriptionAddress(settings: typeof paymentSettingsTable.$inferSelect, coin: string, subscriptionId: number): string {
  if ((coin === "USDT-BEP20" || coin === "BNB") && settings.bnbXpub) {
    try {
      return HDNodeWallet.fromExtendedKey(settings.bnbXpub).deriveChild(0).deriveChild(subscriptionId % 0x7fffffff).address;
    } catch (err) {
      logger.error({ err }, "subscription xpub derivation failed");
    }
  }
  if (coin === "USDT-BEP20" || coin === "BNB") return settings.bnbAddress ?? "";
  if (coin === "USDT-TRC20") return settings.trc20Address ?? "";
  if (coin === "BTC") return settings.btcAddress ?? "";
  if (coin === "ETH") return settings.ethAddress ?? "";
  return "";
}

async function createManualSubscription(userId: number, tier: "premium" | "vip", coin: string) {
  const ownerId = Number(process.env["BOT_OWNER_ID"] ?? "0");
  const [settings] = await db.select().from(paymentSettingsTable).where(eq(paymentSettingsTable.ownerId, ownerId));
  if (!settings) return null;

  const baseAmount = tierMonthlyPrice(tier);
  const [subscription] = await db.insert(tierSubscriptionsTable).values({
    userId,
    tier,
    amount: baseAmount.toFixed(2),
    coin,
    address: "pending",
    reference: `SUB-PENDING-${userId}-${Date.now()}`,
  }).returning();
  if (!subscription) return null;

  const address = subscriptionAddress(settings, coin, subscription.id);
  if (!address) {
    await db.update(tierSubscriptionsTable).set({ status: "cancelled" }).where(eq(tierSubscriptionsTable.id, subscription.id));
    return null;
  }

  const usesUniqueAddress = (coin === "USDT-BEP20" || coin === "BNB") && !!settings.bnbXpub;
  const amount = usesUniqueAddress ? baseAmount : baseAmount + ((subscription.id % 99) + 1) / 100;
  const actualAmount = amount.toFixed(2);
  const reference = `SUB-${subscription.id}`;
  await db.update(tierSubscriptionsTable).set({ address, amount: actualAmount, reference }).where(eq(tierSubscriptionsTable.id, subscription.id));
  return { ...subscription, address, amount: actualAmount, reference };
}

export function subscriptionPlansKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text(`💎 Premium — $${premiumMonthlyPrice()}/30 days`, "access:subscribe:premium")
    .row()
    .text(`👑 VIP — $${VIP_MONTHLY_PRICE}/30 days`, "access:subscribe:vip")
    .row()
    .text("🔙 Back", "menu:main");
}

function subscriptionCoinKeyboard(tier: "premium" | "vip", coins: string[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (process.env["CRYPTOBOT_API_TOKEN"]) {
    for (const asset of CRYPTOBOT_ASSETS) {
      keyboard.text(`⚡ ${asset} via CryptoBot`, `access:sub:cb:${tier}:${asset}`).row();
    }
  }
  for (const coin of coins) keyboard.text(`💳 ${coin} (manual)`, `access:sub:manual:${tier}:${coin}`).row();
  return keyboard.text("🔙 Plans", "access:plans");
}

function accessPlansText(): string {
  return `💳 *ACCESS PLANS*\n━━━━━━━━━━━━━━━━━━\n\n` +
    `🟢 *Free* — products up to $20\n   Requires a referral from an active bot user.\n\n` +
    `💎 *Premium* — $${premiumMonthlyPrice()}/30 days\n   All products, no price limit.\n\n` +
    `👑 *VIP* — $${VIP_MONTHLY_PRICE}/30 days\n   Products up to $50.`;
}

export async function confirmTierSubscription(subscriptionId: number, userId: number, invoiceId?: number): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [subscription] = await tx.select().from(tierSubscriptionsTable).where(eq(tierSubscriptionsTable.id, subscriptionId));
    if (!subscription || subscription.userId !== userId || subscription.status === "confirmed") return false;

    const startsAt = new Date();
    const expiresAt = new Date(startsAt.getTime() + 30 * 24 * 60 * 60 * 1000);
    await tx.update(tierSubscriptionsTable).set({
      status: "confirmed",
      invoiceId: invoiceId ?? subscription.invoiceId,
      confirmedAt: startsAt,
      startsAt,
      expiresAt,
    }).where(eq(tierSubscriptionsTable.id, subscriptionId));

    const [current] = await tx.select().from(accessTable).where(eq(accessTable.userId, userId));
    if (current?.tier === "blocked") return false;
    const currentIsActive = !!current?.isApproved && (!current.expiresAt || current.expiresAt > startsAt);
    const tier = currentIsActive && current && tierRank(current.tier) > tierRank(subscription.tier) ? current.tier : subscription.tier;
    const ownerId = Number(process.env["BOT_OWNER_ID"] ?? "0") || null;
    await tx.insert(accessTable).values({
      userId,
      tier,
      isApproved: true,
      isPending: false,
      approvedAt: startsAt,
      approvedBy: ownerId,
      expiresAt,
    }).onConflictDoUpdate({
      target: accessTable.userId,
      set: { tier, isApproved: true, isPending: false, approvedAt: startsAt, approvedBy: ownerId, expiresAt },
    });
    return true;
  });
}

async function sendRequestAccessMessage(ctx: BotContext): Promise<void> {
  const name = ctx.from?.first_name ?? "User";
  await ctx.reply(
    `🔐 *ACCESS REQUIRED*\n━━━━━━━━━━━━━━━━━━\n\nWelcome, *${name}*.\n\n🟢 *Free* — products up to $20 + 10 Crescent/day. Needs referral from an active user.\n\n💳 No referral? Buy *Premium ($${premiumMonthlyPrice()}/mo)* or *VIP ($${VIP_MONTHLY_PRICE}/mo)*.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🎟️ Enter referral / code", "access:invite")
        .row()
        .text("💳 Buy Premium / VIP", "access:plans")
        .row()
        .text("🔑 Ask owner (free request)", "access:request"),
    }
  );
}

async function notifyOwnerRequest(bot: MyBot, userId: number, name: string, username: string | undefined, message: string): Promise<void> {
  const ownerIdStr = process.env["BOT_OWNER_ID"];
  if (!ownerIdStr) return;
  const ownerId = parseInt(ownerIdStr);
  try {
    await bot.api.sendMessage(
      ownerId,
      `🔔 *NEW ACCESS REQUEST*\n━━━━━━━━━━━━━━━━━━\n\n👤 *${name}*${username ? ` (@${username})` : ""}\n🆔 \`${userId}\`\n\n💬 _"${message}"_`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✅ Approve Free", `access:approve:${userId}:free`)
          .text("💎 Approve Premium", `access:approve:${userId}:premium`)
          .row()
          .text("👑 Approve VIP", `access:approve:${userId}:vip`)
          .text("🚫 Deny", `access:deny:${userId}`),
      }
    );
  } catch (err) {
    logger.error({ err }, "notifyOwnerRequest failed");
  }
}

function escapeMarkdown(value: string): string {
  return value.replace(/([\\_*`\[])/g, "\\$1");
}

async function findRegisteredInviter(reference: string) {
  const normalizedReference = reference.trim().replace(/^@/, "");

  const [inviter] = /^\d+$/.test(normalizedReference)
    ? await db.select().from(usersTable).where(eq(usersTable.id, Number(normalizedReference)))
    : await db.select().from(usersTable).where(sql`lower(${usersTable.username}) = lower(${normalizedReference})`);
  if (!inviter || isOwner(inviter.id)) return inviter ?? null;

  const [inviterAccess] = await db.select().from(accessTable).where(eq(accessTable.userId, inviter.id));
  if (!inviterAccess?.isApproved || inviterAccess.tier === "blocked" || (inviterAccess.expiresAt && inviterAccess.expiresAt < new Date())) {
    return null;
  }
  return inviter;
}

async function notifyOwnerReferral(
  bot: MyBot,
  user: { id: number; firstName: string; username?: string },
  inviter: { id: number; firstName: string | null; username: string | null }
): Promise<void> {
  const ownerIdStr = process.env["BOT_OWNER_ID"];
  if (!ownerIdStr) return;

  const userLabel = `${escapeMarkdown(user.firstName)}${user.username ? ` (@${escapeMarkdown(user.username)})` : ""}`;
  const inviterLabel = `${escapeMarkdown(inviter.firstName ?? "Unknown")}${inviter.username ? ` (@${escapeMarkdown(inviter.username)})` : ""}`;

  await bot.api.sendMessage(
    parseInt(ownerIdStr),
    `✅ *REFERRAL VERIFIED — ACCESS GRANTED*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `👤 New user: ${userLabel}\n🆔 User ID: \`${user.id}\`\n\n` +
      `🤝 Invited by: ${inviterLabel}\n🆔 Inviter ID: \`${inviter.id}\`\n\n` +
      `_The inviter is a registered bot user, so access was approved automatically._`,
    { parse_mode: "Markdown" }
  ).catch((err) => logger.error({ err }, "notifyOwnerReferral failed"));
}

export async function handleInviteCode(bot: MyBot, ctx: BotContext, code: string): Promise<void> {
  const userId = ctx.from!.id;
  const name = ctx.from!.first_name ?? "User";
  const normalizedCode = code.trim().toUpperCase();

  try {
    const [existingAccess] = await db
      .select({ tier: accessTable.tier, isApproved: accessTable.isApproved, expiresAt: accessTable.expiresAt })
      .from(accessTable)
      .where(eq(accessTable.userId, userId));

    if (existingAccess?.tier === "blocked") {
      await ctx.reply("🚫 *Access Denied*\n\nYour account has been blocked. Contact the owner if you believe this is a mistake.", { parse_mode: "Markdown" });
      return;
    }

    const [invite] = await db.select().from(inviteCodesTable).where(eq(inviteCodesTable.code, normalizedCode));

    if (invite) {
      await ctx.reply(
        invite.tier === "free"
          ? "❌ *Free access requires the username or Telegram ID of an active bot user who invited you.*"
          : "❌ *Paid tiers cannot be activated with invite codes. Choose a plan and complete payment first.*",
        { parse_mode: "Markdown" }
      );
      return;
    }

    const inviter = await findRegisteredInviter(code);
    if (!inviter) {
      await ctx.reply(
        "❌ *Invalid invite.*\n\nSend the @username or Telegram ID of an *active* bot user who invited you.\n\nNo referral? Buy Premium or VIP:",
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("💳 View Plans", "access:plans"),
        },
      );
      return;
    }

    const now = new Date();
    await db.insert(accessTable).values({
      userId,
      username: ctx.from!.username,
      firstName: name,
      tier: "free",
      isApproved: true,
      isPending: false,
      approvedAt: now,
      approvedBy: inviter.id,
      requestMessage: `Referral: ${inviter.username ? "@" + inviter.username : inviter.id}`,
    }).onConflictDoUpdate({
      target: accessTable.userId,
      set: {
        tier: "free",
        isApproved: true,
        isPending: false,
        approvedAt: now,
        approvedBy: inviter.id,
        username: ctx.from!.username,
        firstName: name,
      },
    });

    await db.insert(usersTable).values({
      id: userId,
      username: ctx.from!.username,
      firstName: name,
      lastName: ctx.from!.last_name,
    }).onConflictDoUpdate({
      target: usersTable.id,
      set: { username: ctx.from!.username, firstName: name, lastName: ctx.from!.last_name },
    }).catch(() => {});

    await ctx.reply(
      `✅ *Access granted (Free)*\n━━━━━━━━━━━━━━━━━━\n\nWelcome! Referred by an active user.\n\n• Shop: products up to $20\n• Crescent AI: 10 queries/day\n\nUpgrade anytime for full access.`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("🏠 Main Menu", "menu:main")
          .text("💳 Upgrade", "access:plans"),
      },
    );

    await notifyOwnerReferral(bot, { id: userId, firstName: name, username: ctx.from!.username }, inviter);
  } catch (err) {
    logger.error({ err }, "handleInviteCode error");
    await ctx.reply("❌ Something went wrong verifying your invite. Try again or buy a plan.");
  }
}

function accessPanelKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👥 All Users", "acl:users:all")
    .text("⏳ Pending", "acl:users:pending")
    .row()
    .text("💎 Premium", "acl:users:premium")
    .text("👑 VIP", "acl:users:vip")
    .row()
    .text("🚫 Blocked", "acl:users:blocked")
    .text("🎟️ Invite Codes", "acl:invites")
    .row()
    .text("➕ Generate Invite", "acl:invite:generate")
    .row()
    .text("🔙 Hex Panel", "hex:main");
}

export function registerAccessHandlers(bot: MyBot): void {
  bot.command("access", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.reply("⛔ Owner only."); return; }
    const pending = await db.select().from(accessTable).where(eq(accessTable.isPending, true));
    const all = await db.select().from(accessTable);
    const approved = all.filter((a) => a.isApproved);
    const blocked = all.filter((a) => a.tier === "blocked");

    await ctx.reply(
      `🔐 *ACCESS CONTROL*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `👥 Total users: *${all.length}*\n` +
      `✅ Approved: *${approved.length}*\n` +
      `⏳ Pending: *${pending.length}*\n` +
      `🚫 Blocked: *${blocked.length}*`,
      { parse_mode: "Markdown", reply_markup: accessPanelKeyboard() }
    );
  });

  bot.callbackQuery("access:request", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "access:message";
    await ctx.reply(
      `💬 *REQUEST ACCESS*\n━━━━━━━━━━━━━━━━━━\n\nSend a short message explaining why you want access:\n\n_e.g. "Referred by @username" or "I'm a regular customer"_`,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery("access:invite", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "access:code";
    await ctx.reply(`🎟️ *INVITE / REFERRAL*\n\nSend an owner-issued code, or the @username / Telegram ID of the registered user who invited you:`, { parse_mode: "Markdown" });
  });

  bot.callbackQuery("access:plans", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(accessPlansText(), { parse_mode: "Markdown", reply_markup: subscriptionPlansKeyboard() });
  });

  bot.callbackQuery(/^access:subscribe:(premium|vip)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const tier = ctx.match[1] as "premium" | "vip";
    const coins = await getSubscriptionCoins();
    const hasPaymentMethod = coins.length > 0 || !!process.env["CRYPTOBOT_API_TOKEN"];
    if (!hasPaymentMethod) {
      await ctx.editMessageText(
        `⚠️ *Payments are not configured yet.*\n\nThe owner must configure a wallet address or CryptoBot before ${TIER_LABEL[tier]} access can be purchased.`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Plans", "access:plans") }
      );
      return;
    }
    await ctx.editMessageText(
      `💳 *${TIER_LABEL[tier]} — $${tierMonthlyPrice(tier)} / 30 days*\n━━━━━━━━━━━━━━━━━━\n\nChoose payment method:`,
      { parse_mode: "Markdown", reply_markup: subscriptionCoinKeyboard(tier, coins) }
    );
  });

  bot.callbackQuery(/^access:sub:cb:(premium|vip):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("Creating invoice…");
    const tier = ctx.match[1] as "premium" | "vip";
    const asset = ctx.match[2] as CryptoBotAsset;
    try {
      const amount = tierMonthlyPrice(tier);
      const [subscription] = await db.insert(tierSubscriptionsTable).values({
        userId: ctx.from!.id,
        tier,
        amount: amount.toFixed(2),
        coin: asset,
        address: "cryptobot",
        reference: `SUB-CB-${ctx.from!.id}-${Date.now()}`,
      }).returning();
      if (!subscription) throw new Error("Failed to create subscription");
      const invoice = await createCryptoBotInvoice({
        amount,
        asset,
        description: `${TIER_LABEL[tier]} access 30 days`,
        payload: `tier_sub:${subscription.id}:${ctx.from!.id}`,
      });
      await db.update(tierSubscriptionsTable).set({ invoiceId: invoice.invoice_id, reference: `SUB-${subscription.id}` }).where(eq(tierSubscriptionsTable.id, subscription.id));
      await ctx.editMessageText(
        `⚡ *CryptoBot invoice*\n━━━━━━━━━━━━━━━━━━\n\n${TIER_LABEL[tier]} — $${amount}\nAsset: ${asset}\n\nPay here: ${invoice.pay_url}`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .url("Pay now", invoice.pay_url)
            .row()
            .text("✅ I've paid", `access:sub:check:${subscription.id}`)
            .text("🔙 Plans", "access:plans"),
        }
      );
    } catch (err) {
      logger.error({ err }, "CryptoBot tier invoice failed");
      await ctx.editMessageText(`❌ Failed to create invoice: ${err instanceof Error ? err.message : "Unknown"}`, {
        reply_markup: new InlineKeyboard().text("🔙 Plans", "access:plans"),
      });
    }
  });

  bot.callbackQuery(/^access:sub:check:(\d+)$/, async (ctx) => {
    const subscriptionId = Number(ctx.match[1]);
    const [subscription] = await db.select().from(tierSubscriptionsTable).where(eq(tierSubscriptionsTable.id, subscriptionId));
    if (!subscription || subscription.userId !== ctx.from!.id) {
      await ctx.answerCallbackQuery("Not found");
      return;
    }
    if (subscription.status === "confirmed") {
      await ctx.answerCallbackQuery("Already active");
      await ctx.editMessageText(`✅ *${TIER_LABEL[subscription.tier] ?? subscription.tier} already active.*`, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🏠 Main Menu", "menu:main"),
      });
      return;
    }
    const invoiceId = subscription.invoiceId;
    if (!invoiceId) {
      await ctx.answerCallbackQuery("No invoice");
      return;
    }
    const invoice = await checkCryptoBotInvoice(invoiceId);
    if (!invoice || invoice.status !== "paid") {
      await ctx.answerCallbackQuery("Not paid yet");
      await ctx.reply(`⏳ Payment status: *${invoice?.status ?? "unknown"}*`, { parse_mode: "Markdown" });
      return;
    }
    const granted = await confirmTierSubscription(subscriptionId, ctx.from!.id, invoiceId);
    await ctx.answerCallbackQuery(granted ? "Activated" : "Already processed");
    await ctx.editMessageText(
      granted
        ? `✅ *${TIER_LABEL[subscription.tier] ?? "premium"} access activated for 30 days.*`
        : "✅ This payment was already processed.",
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🏠 Main Menu", "menu:main") },
    );
  });

  bot.callbackQuery(/^access:sub:manual:(premium|vip):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("⏳ Creating payment details...");
    const tier = ctx.match[1] as "premium" | "vip";
    const subscription = await createManualSubscription(ctx.from!.id, tier, ctx.match[2]!);
    if (!subscription) {
      await ctx.editMessageText("❌ No wallet is configured for this payment method.", {
        reply_markup: new InlineKeyboard().text("🔙 Payment Methods", `access:subscribe:${tier}`),
      });
      return;
    }
    await ctx.editMessageText(
      `💳 *MANUAL PAYMENT — ${TIER_LABEL[tier].toUpperCase()}*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Send exactly: *${subscription.amount} ${subscription.coin}*\n` +
        `Network: *${subscription.coin}*\nTo: \`${subscription.address}\`\nReference: \`${subscription.reference}\`\n\n` +
        `After sending, tap *I've Paid*. The owner will verify and activate access for 30 days.`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✅ I've Paid", `access:sub:claim:${subscription.id}`)
          .row()
          .text("❌ Cancel", "access:plans"),
      },
    );
  });

  bot.callbackQuery(/^access:sub:claim:(\d+)$/, async (ctx) => {
    const subscriptionId = Number(ctx.match[1]);
    const [subscription] = await db.select().from(tierSubscriptionsTable).where(eq(tierSubscriptionsTable.id, subscriptionId));
    if (!subscription || subscription.userId !== ctx.from!.id || subscription.status !== "pending") {
      await ctx.answerCallbackQuery("This payment is no longer pending.");
      return;
    }
    await db.update(tierSubscriptionsTable).set({ status: "claimed", claimedAt: new Date() }).where(eq(tierSubscriptionsTable.id, subscriptionId));
    await ctx.answerCallbackQuery("✅ Sent for verification");
    await ctx.editMessageText("✅ Payment submitted. The owner will verify it and activate your 30-day access.", {
      reply_markup: new InlineKeyboard().text("🏠 Main Menu", "menu:main"),
    });
    const ownerId = Number(process.env["BOT_OWNER_ID"] ?? "0");
    if (ownerId) {
      await bot.api.sendMessage(
        ownerId,
        `💰 *SUBSCRIPTION CLAIM*\n━━━━━━━━━━━━━━━━━━\n\nUser: ${ctx.from!.id}\nTier: ${subscription.tier}\nAmount: ${subscription.amount} ${subscription.coin}\nTo: ${subscription.address}\nRef: ${subscription.reference}`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("✅ Confirm", `access:sub:confirm:${subscription.id}`)
            .text("❌ Reject", `access:sub:reject:${subscription.id}`),
        },
      ).catch(() => {});
    }
  });

  bot.callbackQuery(/^access:sub:confirm:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("Owner only");
      return;
    }
    const subscriptionId = Number(ctx.match[1]);
    const [subscription] = await db.select().from(tierSubscriptionsTable).where(eq(tierSubscriptionsTable.id, subscriptionId));
    if (!subscription) {
      await ctx.answerCallbackQuery("Not found");
      return;
    }
    const granted = await confirmTierSubscription(subscriptionId, subscription.userId);
    await ctx.answerCallbackQuery(granted ? "Confirmed" : "Failed");
    await ctx.editMessageText(granted ? `✅ Activated ${subscription.tier} for user ${subscription.userId}` : "❌ Could not confirm");
    if (granted) {
      await bot.api.sendMessage(subscription.userId, `✅ Your *${TIER_LABEL[subscription.tier] ?? subscription.tier}* access is active for 30 days.`, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🏠 Main Menu", "menu:main"),
      }).catch(() => {});
    }
  });

  bot.callbackQuery(/^access:sub:reject:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("Owner only");
      return;
    }
    const subscriptionId = Number(ctx.match[1]);
    await db.update(tierSubscriptionsTable).set({ status: "cancelled" }).where(eq(tierSubscriptionsTable.id, subscriptionId));
    await ctx.answerCallbackQuery("Rejected");
    await ctx.editMessageText("❌ Subscription claim rejected.");
  });

  bot.callbackQuery(/^access:approve:(\d+):(free|premium|vip)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("Owner only");
      return;
    }
    const userId = Number(ctx.match[1]);
    const tier = ctx.match[2]!;
    const now = new Date();
    await db.insert(accessTable).values({
      userId,
      tier,
      isApproved: true,
      isPending: false,
      approvedAt: now,
      approvedBy: ctx.from.id,
    }).onConflictDoUpdate({
      target: accessTable.userId,
      set: { tier, isApproved: true, isPending: false, approvedAt: now, approvedBy: ctx.from.id },
    });
    await ctx.answerCallbackQuery("Approved");
    await ctx.editMessageText(`✅ Approved user ${userId} as *${TIER_LABEL[tier] ?? tier}*`, { parse_mode: "Markdown" });
    await bot.api.sendMessage(userId, `✅ Access approved as *${TIER_LABEL[tier] ?? tier}*.`, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🏠 Main Menu", "menu:main"),
    }).catch(() => {});
  });

  bot.callbackQuery(/^access:deny:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("Owner only");
      return;
    }
    const userId = Number(ctx.match[1]);
    await db.update(accessTable).set({ isPending: false, isApproved: false }).where(eq(accessTable.userId, userId));
    await ctx.answerCallbackQuery("Denied");
    await ctx.editMessageText(`🚫 Denied user ${userId}`);
    await bot.api.sendMessage(userId, "❌ Your access request was denied.").catch(() => {});
  });

  bot.callbackQuery("hex:access", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    await ctx.answerCallbackQuery();
    const all = await db.select().from(accessTable);
    const pending = all.filter((a) => a.isPending);
    const approved = all.filter((a) => a.isApproved);
    const blocked = all.filter((a) => a.tier === "blocked");
    await ctx.editMessageText(
      `🔐 *ACCESS CONTROL*\n━━━━━━━━━━━━━━━━━━\n\n👥 Total: *${all.length}* · ✅ *${approved.length}* · ⏳ *${pending.length}* · 🚫 *${blocked.length}*`,
      { parse_mode: "Markdown", reply_markup: accessPanelKeyboard() },
    );
  });

  bot.callbackQuery(/^acl:users:(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("Owner only");
      return;
    }
    await ctx.answerCallbackQuery();
    const filter = ctx.match[1]!;
    let rows = await db.select().from(accessTable).orderBy(desc(accessTable.lastSeenAt));
    if (filter === "pending") rows = rows.filter((r) => r.isPending);
    else if (filter === "premium") rows = rows.filter((r) => r.tier === "premium" && r.isApproved);
    else if (filter === "vip") rows = rows.filter((r) => r.tier === "vip" && r.isApproved);
    else if (filter === "blocked") rows = rows.filter((r) => r.tier === "blocked");
    const labels: Record<string, string> = { all: "ALL USERS", pending: "PENDING", premium: "PREMIUM", vip: "VIP", blocked: "BLOCKED" };
    const lines = rows.slice(0, 30).map((r) => {
      const emoji = TIER_EMOJI[r.tier] ?? "•";
      const name = r.firstName ?? r.username ?? String(r.userId);
      const status = r.isApproved ? "✅" : r.isPending ? "⏳" : "—";
      return `${emoji} ${status} ${name} (\`${r.userId}\`)`;
    });
    await ctx.editMessageText(
      `👥 *${labels[filter] ?? filter}* (${rows.length})\n━━━━━━━━━━━━━━━━━━\n\n${lines.length ? lines.join("\n") : "None."}`,
      { parse_mode: "Markdown", reply_markup: accessPanelKeyboard() },
    );
  });

  bot.callbackQuery("acl:invites", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("Owner only");
      return;
    }
    await ctx.answerCallbackQuery();
    const codes = await db.select().from(inviteCodesTable).orderBy(desc(inviteCodesTable.createdAt)).limit(20);
    const lines = codes.map((c) => `${c.isActive ? "✅" : "❌"} \`${c.code}\` ${TIER_EMOJI[c.tier] ?? ""} ${c.tier} (${c.usedCount}/${c.maxUses})`);
    await ctx.editMessageText(
      `🎟️ *INVITE CODES*\n━━━━━━━━━━━━━━━━━━\n\n${lines.length ? lines.join("\n") : "No codes yet."}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("➕ Generate", "acl:invite:generate")
          .text("🔙 Panel", "hex:access"),
      },
    );
  });

  bot.callbackQuery("acl:invite:generate", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("Owner only");
      return;
    }
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "acl:generate_invite";
    await ctx.reply("Send: `tier maxUses note`\nExample: `premium 5 launch`\nTiers: free · premium · vip", { parse_mode: "Markdown" });
  });
}

export async function processAccessInput(bot: MyBot, ctx: BotContext, action: string, text: string): Promise<void> {
  const userId = ctx.from!.id;
  const name = ctx.from!.first_name ?? "User";

  if (action === "access:message") {
    try {
      await db.insert(accessTable).values({
        userId,
        username: ctx.from!.username,
        firstName: name,
        tier: "free",
        isApproved: false,
        isPending: true,
        requestMessage: text.slice(0, 300),
      }).onConflictDoUpdate({
        target: accessTable.userId,
        set: { isPending: true, requestMessage: text.slice(0, 300), username: ctx.from!.username, firstName: name },
      });

      await ctx.reply(
        `✅ *Request Submitted*\n━━━━━━━━━━━━━━━━━━\n\nYour request has been sent to the owner.\n\n_You'll be notified once it's reviewed._`,
        { parse_mode: "Markdown" }
      );

      await notifyOwnerRequest(bot, userId, name, ctx.from!.username, text);
    } catch (err) {
      await ctx.reply(`❌ Failed: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  } else if (action === "access:code") {
    await handleInviteCode(bot, ctx, text.trim());
  } else if (action === "acl:generate_invite") {
    const parts = text.trim().split(/\s+/);
    const tier = parts[0] ?? "free";
    const maxUses = parseInt(parts[1] ?? "1");
    const note = parts.slice(2).join(" ") || undefined;

    const validTiers = ["free", "premium", "vip"];
    if (!validTiers.includes(tier)) {
      await ctx.reply(`❌ Invalid tier. Use: free · premium · vip`);
      return;
    }

    const code = Array.from({ length: 8 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");

    await db.insert(inviteCodesTable).values({
      code,
      tier,
      maxUses: isNaN(maxUses) ? 1 : maxUses,
      createdBy: userId,
      note: note ?? null,
      isActive: true,
    });

    await ctx.reply(
      `🎟️ *INVITE CODE CREATED*\n━━━━━━━━━━━━━━━━━━\n\nCode: \`${code}\`\n${TIER_EMOJI[tier] ?? ""} Tier: *${TIER_LABEL[tier] ?? tier}*\nMax uses: *${isNaN(maxUses) ? 1 : maxUses}*${note ? `\nNote: ${note}` : ""}\n\n_Share via: /start ${code}_`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🎟️ Invite Codes", "acl:invites") }
    );
  }
}
