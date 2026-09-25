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
const TIER_EMOJI: Record<string, string> = { free: "🟢", premium: "💎", vip: "👑", blocked: "🚫" };
const TIER_LABEL: Record<string, string> = { free: "Free", premium: "Premium", vip: "VIP", blocked: "Blocked" };
export const VIP_MONTHLY_PRICE = 10;

export function premiumMonthlyPrice(): number {
  const configured = Number(process.env["PREMIUM_MONTHLY_PRICE"] ?? "5");
  return Number.isFinite(configured) && configured > 0 ? configured : 5;
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

    // Check expiry
    if (record.expiresAt && record.expiresAt < new Date()) {
      await db.update(accessTable).set({ isApproved: false, isPending: false }).where(eq(accessTable.userId, userId));
      await ctx.reply(
        `⏰ *Access Expired*\n━━━━━━━━━━━━━━━━━━\n\nYour access has expired. Request renewal below.`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔑 Request Renewal", "access:request") }
      );
      return false;
    }

    // Check tier rank
    if (tierRank(record.tier) < tierRank(requiredTier)) {
      await ctx.reply(
        `💎 *${TIER_LABEL[requiredTier] ?? requiredTier} Required*\n━━━━━━━━━━━━━━━━━━\n\nThis feature requires *${TIER_LABEL[requiredTier]}* access.\nYour current tier: ${TIER_EMOJI[record.tier] ?? ""} *${TIER_LABEL[record.tier] ?? record.tier}*\n\n_Contact the owner to upgrade._`,
        { parse_mode: "Markdown" }
      );
      return false;
    }

    // Update last seen + message count
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

// ── Get user access record ────────────────────────────────────────────────────

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

// ── Request access message ────────────────────────────────────────────────────

async function sendRequestAccessMessage(ctx: BotContext): Promise<void> {
  const name = ctx.from?.first_name ?? "User";
  await ctx.reply(
    `🔐 *ACCESS REQUIRED*\n━━━━━━━━━━━━━━━━━━\n\nWelcome, *${name}*.\n\nFree access is limited to products priced up to *$20* and requires the username or Telegram ID of an active bot user who invited you.\n\nPaid plans unlock broader product access.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🔑 Request Access", "access:request")
        .text("🎟️ I Have an Invite Code", "access:invite")
        .row()
        .text("💳 View Paid Plans", "access:plans"),
    }
  );
}

// ── Notify owner of pending request ──────────────────────────────────────────

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

// ── Invite code handler ───────────────────────────────────────────────────────

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
      await ctx.reply("❌ *Invalid invite.* Send the username or Telegram ID of a registered bot user.", { parse_mode: "Markdown" });
      return;
    }
    if (inviter.id === userId) {
      await ctx.reply("❌ *You cannot use your own username or ID as an invite.*", { parse_mode: "Markdown" });
      return;
    }

    const hasActiveAccess = !!existingAccess?.isApproved && (!existingAccess.expiresAt || existingAccess.expiresAt > new Date());
    const grantedTier = hasActiveAccess ? existingAccess.tier : "free";

    await db.insert(accessTable).values({
      userId,
      username: ctx.from!.username,
      firstName: name,
      tier: grantedTier,
      isApproved: true,
      isPending: false,
      approvedAt: new Date(),
      expiresAt: hasActiveAccess ? existingAccess?.expiresAt : null,
      inviteCode: code.trim(),
      invitedBy: inviter.id,
    }).onConflictDoUpdate({
      target: accessTable.userId,
      set: {
        tier: grantedTier,
        isApproved: true,
        isPending: false,
        approvedAt: new Date(),
        expiresAt: hasActiveAccess ? existingAccess?.expiresAt : null,
        inviteCode: code.trim(),
        invitedBy: inviter.id,
      },
    });

    await ctx.reply(
      `✅ *Referral Verified — Access Granted!*\n━━━━━━━━━━━━━━━━━━\n\nYour inviter is a registered bot user, so your *${TIER_LABEL[grantedTier] ?? grantedTier}* access has been approved automatically.\n\n_Use the menu below to get started._`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⚡ Open Bot Panel", "menu:main") }
    );
    await notifyOwnerReferral(bot, { id: userId, firstName: name, username: ctx.from!.username }, inviter);
  } catch (err) {
    logger.error({ err }, "handleInviteCode error");
    await ctx.reply("❌ Failed to process invite code.");
  }
}

// ── Access management panel (owner) ──────────────────────────────────────────

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

// ── Register ──────────────────────────────────────────────────────────────────

export function registerAccessHandlers(bot: MyBot): void {
  // ── /start with optional invite code ──────────────────────────────────────
  // (Overrides welcome.ts /start — registered after so it takes priority via filter)
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

  // ── Request access callback ────────────────────────────────────────────────
  bot.callbackQuery("access:request", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "access:message";
    await ctx.reply(
      `💬 *REQUEST ACCESS*\n━━━━━━━━━━━━━━━━━━\n\nSend a short message explaining why you want access:\n\n_e.g. "Referred by @username" or "I'm a regular customer"_`,
      { parse_mode: "Markdown" }
    );
  });

  // ── Invite code callback ───────────────────────────────────────────────────
  bot.callbackQuery("access:invite", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "access:code";
    await ctx.reply(`🎟️ *INVITE CODE*\n\nSend an owner-issued code, or the @username / Telegram ID of the registered user who invited you:`, { parse_mode: "Markdown" });
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
      `💳 *${TIER_LABEL[tier].toUpperCase()} CHECKOUT*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Subscription: *30 days*\nPrice: *$${tierMonthlyPrice(tier).toFixed(2)}*\n\nChoose a payment method:`,
      { parse_mode: "Markdown", reply_markup: subscriptionCoinKeyboard(tier, coins) }
    );
  });

  bot.callbackQuery(/^access:sub:cb:(premium|vip):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("⏳ Creating invoice...");
    const tier = ctx.match[1] as "premium" | "vip";
    const asset = ctx.match[2] as CryptoBotAsset;
    const userId = ctx.from!.id;
    const [subscription] = await db.insert(tierSubscriptionsTable).values({
      userId,
      tier,
      amount: tierMonthlyPrice(tier).toFixed(2),
      coin: asset,
      address: "CryptoBot",
      reference: `SUB-CB-PENDING-${userId}-${Date.now()}`,
    }).returning();
    if (!subscription) {
      await ctx.editMessageText("❌ Could not create a subscription payment. Please try again.");
      return;
    }

    try {
      const invoice = await createCryptoBotInvoice({
        asset,
        amount: tierMonthlyPrice(tier),
        subscriptionId: subscription.id,
        productName: `${TIER_LABEL[tier]} 30-day access`,
        userId,
      });
      await db.update(tierSubscriptionsTable).set({ invoiceId: invoice.invoice_id, address: `CryptoBot:${invoice.invoice_id}`, reference: `CB-SUB-${invoice.invoice_id}` }).where(eq(tierSubscriptionsTable.id, subscription.id));
      await ctx.editMessageText(
        `⚡ *PAY FOR ${TIER_LABEL[tier].toUpperCase()}*\n━━━━━━━━━━━━━━━━━━\n\n` +
          `Amount: *${invoice.amount} ${asset}*\nAccess: *30 days*\n\nPayment is automatically confirmed after checkout.`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().url("💳 Pay via CryptoBot", invoice.bot_invoice_url).row().text("🔄 Check Payment", `access:sub:check:${subscription.id}:${invoice.invoice_id}`).text("🔙 Plans", "access:plans") }
      );
    } catch (err) {
      await db.update(tierSubscriptionsTable).set({ status: "cancelled" }).where(eq(tierSubscriptionsTable.id, subscription.id));
      logger.error({ err }, "tier CryptoBot invoice creation failed");
      await ctx.editMessageText("❌ Could not create the CryptoBot invoice. Please choose another payment method.", { reply_markup: new InlineKeyboard().text("🔙 Payment Methods", `access:subscribe:${tier}`) });
    }
  });

  bot.callbackQuery(/^access:sub:check:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("🔄 Checking payment...");
    const subscriptionId = Number(ctx.match[1]);
    const invoiceId = Number(ctx.match[2]);
    const invoice = await checkCryptoBotInvoice(invoiceId);
    if (!invoice) { await ctx.reply("❌ Could not check this payment right now."); return; }
    if (invoice.status !== "paid") { await ctx.reply(`⏳ Payment status: *${invoice.status}*`, { parse_mode: "Markdown" }); return; }
    const granted = await confirmTierSubscription(subscriptionId, ctx.from!.id, invoiceId);
    const [subscription] = await db.select({ tier: tierSubscriptionsTable.tier }).from(tierSubscriptionsTable).where(eq(tierSubscriptionsTable.id, subscriptionId));
    await ctx.editMessageText(granted ? `✅ *${TIER_LABEL[subscription?.tier ?? "premium"]} access activated for 30 days.*` : "✅ This payment was already processed.", { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🏠 Main Menu", "menu:main") });
  });

  bot.callbackQuery(/^access:sub:manual:(premium|vip):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("⏳ Creating payment details...");
    const tier = ctx.match[1] as "premium" | "vip";
    const subscription = await createManualSubscription(ctx.from!.id, tier, ctx.match[2]!);
    if (!subscription) {
      await ctx.editMessageText("❌ No wallet is configured for this payment method.", { reply_markup: new InlineKeyboard().text("🔙 Payment Methods", `access:subscribe:${tier}`) });
      return;
    }
    await ctx.editMessageText(
      `💳 *MANUAL PAYMENT — ${TIER_LABEL[tier].toUpperCase()}*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Send exactly: *${subscription.amount} ${subscription.coin}*\n` +
        `Network: *${subscription.coin}*\nTo: \`${subscription.address}\`\nReference: \`${subscription.reference}\`\n\n` +
        `After sending, tap *I've Paid*. The owner will verify the transaction and activate your access for 30 days.`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("✅ I've Paid", `access:sub:claim:${subscription.id}`).row().text("❌ Cancel", "access:plans") }
    );
  });

  bot.callbackQuery(/^access:sub:claim:(\d+)$/, async (ctx) => {
    const subscriptionId = Number(ctx.match[1]);
    const [subscription] = await db.select().from(tierSubscriptionsTable).where(eq(tierSubscriptionsTable.id, subscriptionId));
    if (!subscription || subscription.userId !== ctx.from!.id || subscription.status !== "pending") { await ctx.answerCallbackQuery("This payment is no longer pending."); return; }
    await db.update(tierSubscriptionsTable).set({ status: "claimed", claimedAt: new Date() }).where(eq(tierSubscriptionsTable.id, subscriptionId));
    await ctx.answerCallbackQuery("✅ Sent for verification");
    await ctx.editMessageText("✅ Payment submitted. The owner will verify it and activate your 30-day access.", { reply_markup: new InlineKeyboard().text("🏠 Main Menu", "menu:main") });
    const ownerId = Number(process.env["BOT_OWNER_ID"] ?? "0");
    if (ownerId) {
      await ctx.api.sendMessage(ownerId, `🔔 *SUBSCRIPTION PAYMENT CLAIMED*\n\nUser: \`${subscription.userId}\`\nTier: *${TIER_LABEL[subscription.tier]}*\nAmount: *${subscription.amount} ${subscription.coin}*\nAddress: \`${subscription.address}\`\nReference: \`${subscription.reference}\``, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("✅ Confirm 30 Days", `access:sub:confirm:${subscription.id}`).text("❌ Reject", `access:sub:reject:${subscription.id}`) }).catch(() => {});
    }
  });

  bot.callbackQuery(/^access:sub:confirm:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const subscriptionId = Number(ctx.match[1]);
    const [subscription] = await db.select().from(tierSubscriptionsTable).where(eq(tierSubscriptionsTable.id, subscriptionId));
    if (!subscription || subscription.status !== "claimed") { await ctx.answerCallbackQuery("Already processed"); return; }
    const granted = await confirmTierSubscription(subscriptionId, subscription.userId);
    await ctx.answerCallbackQuery(granted ? "✅ Access activated" : "Already processed");
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    if (granted) await ctx.api.sendMessage(subscription.userId, `✅ *${TIER_LABEL[subscription.tier]} access activated!*\n\nYour subscription is active for 30 days.`, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🏠 Main Menu", "menu:main") }).catch(() => {});
  });

  bot.callbackQuery(/^access:sub:reject:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await db.update(tierSubscriptionsTable).set({ status: "cancelled" }).where(eq(tierSubscriptionsTable.id, Number(ctx.match[1])));
    await ctx.answerCallbackQuery("❌ Rejected");
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
  });

  // ── Owner: approve callback ────────────────────────────────────────────────
  bot.callbackQuery(/^access:approve:(\d+):(\w+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    const tier = ctx.match[2] as string;
    await ctx.answerCallbackQuery(`✅ Approving as ${tier}...`);

    try {
      await db.insert(accessTable).values({
        userId, tier, isApproved: true, isPending: false, approvedAt: new Date(), approvedBy: ctx.from.id,
      }).onConflictDoUpdate({
        target: accessTable.userId,
        set: { tier, isApproved: true, isPending: false, approvedAt: new Date(), approvedBy: ctx.from.id },
      });

      const emoji = TIER_EMOJI[tier] ?? "✅";
      const label = TIER_LABEL[tier] ?? tier;

      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
      await ctx.reply(`${emoji} Approved user \`${userId}\` as *${label}*.`, { parse_mode: "Markdown" });

      // Notify user
      await bot.api.sendMessage(userId,
        `${emoji} *Access Approved!*\n━━━━━━━━━━━━━━━━━━\n\nYour access request has been approved!\n\nTier: *${label}*\n\n_Welcome aboard. Tap below to open the bot._`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⚡ Open Bot Panel", "menu:main") }
      ).catch(() => {});
    } catch (err) {
      await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  });

  // ── Owner: deny callback ───────────────────────────────────────────────────
  bot.callbackQuery(/^access:deny:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    await ctx.answerCallbackQuery("🚫 Denied");

    await db.insert(accessTable).values({ userId, tier: "free", isApproved: false, isPending: false })
      .onConflictDoUpdate({ target: accessTable.userId, set: { isPending: false } });

    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    await ctx.reply(`🚫 Request from \`${userId}\` denied.`, { parse_mode: "Markdown" });

    await bot.api.sendMessage(userId,
      `🚫 *Access Denied*\n━━━━━━━━━━━━━━━━━━\n\nYour access request was not approved at this time.\n\n_You may reapply later._`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
  });

  // ── Owner: mark sold / upgrade callbacks ──────────────────────────────────
  bot.callbackQuery(/^acl:upgrade:(\d+):(\w+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    const tier = ctx.match[2] as string;
    await db.update(accessTable).set({ tier }).where(eq(accessTable.userId, userId));
    await ctx.answerCallbackQuery(`${TIER_EMOJI[tier]} Upgraded to ${TIER_LABEL[tier]}`);
    await ctx.reply(`${TIER_EMOJI[tier]} User \`${userId}\` upgraded to *${TIER_LABEL[tier]}*.`, { parse_mode: "Markdown" });
    await bot.api.sendMessage(userId,
      `${TIER_EMOJI[tier]} *Tier Upgraded!*\n\nYour tier has been upgraded to *${TIER_LABEL[tier]}*. Enjoy the new features!`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
  });

  bot.callbackQuery(/^acl:block:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    await db.update(accessTable).set({ tier: "blocked", isApproved: false, blockedAt: new Date() }).where(eq(accessTable.userId, userId));
    await ctx.answerCallbackQuery("🚫 Blocked");
    await ctx.reply(`🚫 User \`${userId}\` has been blocked.`, { parse_mode: "Markdown" });
  });

  // ── Access panel callbacks ─────────────────────────────────────────────────
  bot.callbackQuery("hex:access", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    const all = await db.select().from(accessTable);
    const pending = all.filter((a) => a.isPending);
    const approved = all.filter((a) => a.isApproved);
    const blocked = all.filter((a) => a.tier === "blocked");
    await ctx.editMessageText(
      `🔐 *ACCESS CONTROL*\n━━━━━━━━━━━━━━━━━━\n\n👥 Total: *${all.length}* · ✅ *${approved.length}* · ⏳ *${pending.length}* · 🚫 *${blocked.length}*`,
      { parse_mode: "Markdown", reply_markup: accessPanelKeyboard() }
    );
  });

  bot.callbackQuery(/^acl:users:(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    const filter = ctx.match[1] as string;

    const all = await db.select().from(accessTable).orderBy(desc(accessTable.createdAt)).limit(20);
    const filtered = filter === "all" ? all
      : filter === "pending" ? all.filter((a) => a.isPending)
      : filter === "blocked" ? all.filter((a) => a.tier === "blocked")
      : all.filter((a) => a.tier === filter && a.isApproved);

    const labels: Record<string, string> = { all: "ALL USERS", pending: "PENDING", premium: "PREMIUM", vip: "VIP", blocked: "BLOCKED" };

    const lines = filtered.length === 0 ? "_None._"
      : filtered.map((a) =>
        `${TIER_EMOJI[a.tier] ?? "⚪"} *${a.firstName ?? "Unknown"}*${a.username ? ` @${a.username}` : ""} \`${a.userId}\`\n` +
        `   ${a.isPending ? "⏳ Pending" : a.isApproved ? "✅ Approved" : "❌ Not approved"} · ${a.tier}${a.invitedBy ? ` · Invited by \`${a.invitedBy}\`` : ""}\n` +
        `   Last seen: ${a.lastSeenAt ? new Date(a.lastSeenAt).toDateString() : "Never"}`
      ).join("\n\n");

    const kb = new InlineKeyboard().text("🔙 Back", "hex:access");
    await ctx.editMessageText(
      `🔐 *${labels[filter] ?? filter.toUpperCase()}*\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
  });

  // ── Invite codes panel ─────────────────────────────────────────────────────
  bot.callbackQuery("acl:invites", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    const codes = await db.select().from(inviteCodesTable).orderBy(desc(inviteCodesTable.createdAt)).limit(15);
    const lines = codes.length === 0 ? "_No codes generated yet._"
      : codes.map((c) =>
        `${c.isActive ? "🟢" : "🔴"} \`${c.code}\` — ${TIER_EMOJI[c.tier] ?? ""} ${c.tier} · ${c.usedCount}/${c.maxUses} uses${c.note ? ` · _${c.note}_` : ""}`
      ).join("\n");
    await ctx.editMessageText(
      `🎟️ *INVITE CODES*\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("➕ Generate", "acl:invite:generate").row().text("🔙 Back", "hex:access") }
    );
  });

  bot.callbackQuery("acl:invite:generate", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    ctx.session.pendingAction = "acl:generate_invite";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🎟️ *GENERATE INVITE CODE*\n━━━━━━━━━━━━━━━━━━\n\nSend details in format:\n\`TIER USES NOTE\`\n\nExamples:\n\`premium 1 For @username\`\n\`vip 3 Bulk access\`\n\`free 10 Open invite\`\n\n_Tiers: free · premium · vip_`,
      { parse_mode: "Markdown" }
    );
  });

  // ── /approve and /revoke commands ─────────────────────────────────────────
  bot.command("approve", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    const userId = parseInt(parts[0] ?? "");
    const tier = (parts[1] ?? "free") as string;
    if (isNaN(userId)) { await ctx.reply("Usage: /approve <userId> [tier]"); return; }

    await db.insert(accessTable).values({ userId, tier, isApproved: true, isPending: false, approvedAt: new Date(), approvedBy: ctx.from.id })
      .onConflictDoUpdate({ target: accessTable.userId, set: { tier, isApproved: true, isPending: false, approvedAt: new Date() } });

    await ctx.reply(`✅ User \`${userId}\` approved as *${TIER_LABEL[tier] ?? tier}*.`, { parse_mode: "Markdown" });
    await bot.api.sendMessage(userId, `✅ *Access Approved!*\n\nYou've been granted *${TIER_LABEL[tier] ?? tier}* access. Use /start to begin.`, { parse_mode: "Markdown" }).catch(() => {});
  });

  bot.command("revoke", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    const userId = parseInt(ctx.match?.trim() ?? "");
    if (isNaN(userId)) { await ctx.reply("Usage: /revoke <userId>"); return; }
    await db.update(accessTable).set({ isApproved: false, isPending: false }).where(eq(accessTable.userId, userId));
    await ctx.reply(`🚫 Access revoked for \`${userId}\`.`, { parse_mode: "Markdown" });
  });

  bot.command("block", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    const userId = parseInt(parts[0] ?? "");
    const reason = parts.slice(1).join(" ") || undefined;
    if (isNaN(userId)) { await ctx.reply("Usage: /block <userId> [reason]"); return; }
    await db.update(accessTable).set({ tier: "blocked", isApproved: false, blockedAt: new Date(), blockedReason: reason ?? null }).where(eq(accessTable.userId, userId));
    await ctx.reply(`🚫 User \`${userId}\` blocked.${reason ? `\nReason: ${reason}` : ""}`, { parse_mode: "Markdown" });
  });
}

// ── Input processor for access flows (called from menu.ts interceptor) ────────

export async function processAccessInput(bot: MyBot, ctx: BotContext, action: string, text: string): Promise<void> {
  const userId = ctx.from!.id;
  const name = ctx.from!.first_name ?? "User";

  if (action === "access:message") {
    // User submitting access request
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
    // Owner generating invite code
    const parts = text.trim().split(/\s+/);
    const tier = parts[0] ?? "free";
    const maxUses = parseInt(parts[1] ?? "1");
    const note = parts.slice(2).join(" ") || undefined;

    const validTiers = ["free", "premium", "vip"];
    if (!validTiers.includes(tier)) {
      await ctx.reply(`❌ Invalid tier. Use: free · premium · vip`);
      return;
    }

    // Generate random code
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
