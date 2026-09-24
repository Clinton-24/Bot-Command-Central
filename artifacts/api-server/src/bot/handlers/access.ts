/**
 * ACCESS CONTROL SYSTEM
 * ─────────────────────────────────────────────────────────────────────────────
 * Flow A (OTP): user requests → OTP sent to owner → owner forwards to user → user enters within 60s
 * Flow B (Invite): owner generates code → shares link → user enters code → instant access
 * Flow C (Simple): user taps Request → owner gets Confirm/Decline buttons → one-by-one or all
 */

import { InlineKeyboard } from "grammy";
import { md, safeName, safeUsername } from "../utils/escape";
import { eq, desc, sql } from "drizzle-orm";
import { HDNodeWallet } from "ethers";
import { db, accessTable, inviteCodesTable, usersTable, paymentSettingsTable, tierSubscriptionsTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";
import { checkCryptoBotInvoice, createCryptoBotInvoice, CRYPTOBOT_ASSETS, type CryptoBotAsset } from "./cryptobot";

// ── Safe text — strips ALL Markdown special chars from user-provided strings ──
function s(t: string | undefined | null): string {
  if (!t) return "";
  return t
    .replace(/\\/g, "")
    .replace(/\*/g, "")
    .replace(/_/g, " ")
    .replace(/`/g, "")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/~/g, "")
    .replace(/>/g, "")
    .replace(/\|/g, " ");
}

// ── Tier config ───────────────────────────────────────────────────────────────

const TIER_RANK: Record<string, number> = { free: 1, premium: 2, vip: 3 };
export const TIER_EMOJI: Record<string, string> = { free: "🟢", premium: "💎", vip: "👑", blocked: "🚫" };
export const TIER_LABEL: Record<string, string> = { free: "Free", premium: "Premium", vip: "VIP", blocked: "Blocked" };
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

// ── In-memory OTP store ───────────────────────────────────────────────────────

interface PendingOTP {
  otp: string;
  expiresAt: number;
  tier: "free" | "premium" | "vip";
  name: string;
  username?: string;
}

const pendingOTPs = new Map<number, PendingOTP>();

function generateCode(len = 6): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// ── DB helpers ────────────────────────────────────────────────────────────────

export async function getAccess(userId: number) {
  try {
    const [r] = await db.select().from(accessTable).where(eq(accessTable.userId, userId));
    return r ?? null;
  } catch { return null; }
}

// ── Core access guard ─────────────────────────────────────────────────────────

export async function checkAccess(
  ctx: BotContext,
  requiredTier: "free" | "premium" | "vip" = "free"
): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (isOwner(userId)) return true;

  try {
    const rec = await getAccess(userId);

    if (!rec || !rec.isApproved) {
      await showGate(ctx);
      return false;
    }
    if (rec.tier === "blocked") {
      await ctx.reply(`🚫 *Access Denied*\n\nYour account has been blocked.${rec.blockedReason ? `\n_Reason: ${md(rec.blockedReason)}_` : ""}`, { parse_mode: "Markdown" });
      return false;
    }
    if (rec.expiresAt && rec.expiresAt < new Date()) {
      await db.update(accessTable).set({ isApproved: false }).where(eq(accessTable.userId, userId));
      await showGate(ctx, true);
      return false;
    }
    if (tierRank(rec.tier) < tierRank(requiredTier)) {
      await ctx.reply(`💎 *${TIER_LABEL[requiredTier]} Required*\n\nYour tier: ${TIER_EMOJI[rec.tier] ?? ""} *${TIER_LABEL[rec.tier] ?? rec.tier}*\n\n_Contact the owner to upgrade._`, { parse_mode: "Markdown" });
      return false;
    }
    db.update(accessTable)
      .set({ lastSeenAt: new Date(), totalMessages: (rec.totalMessages ?? 0) + 1 })
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
    const rec = await getAccess(userId);
    if (rec?.tier === "blocked") {
      await ctx.reply("🚫 Your account has been blocked.");
      return false;
    }
    if (rec) {
      db.update(accessTable)
        .set({ lastSeenAt: new Date(), totalMessages: (rec.totalMessages ?? 0) + 1 })
        .where(eq(accessTable.userId, userId))
        .catch(() => {});
    }
    return true;
  } catch { return true; }
}

// ── Access gate ───────────────────────────────────────────────────────────────

async function showGate(ctx: BotContext, expired = false): Promise<void> {
  const name = md(ctx.from?.first_name ?? "User");
  const text = expired
    ? `⏰ *Access Expired*\n\nWelcome back, ${name}.\n\nYour access has expired. Request access again below.`
    : `🔐 *PRIVATE BOT*\n\nWelcome, ${name}.\n\nThis bot requires approval to use.\nTap below to request access:`;

  const kb = new InlineKeyboard()
    .text("🔑 Request Access", "access:request")
    .text("🎟️ Enter Code", "access:enter_code");

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb }).catch(() =>
      ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb })
    );
    await ctx.answerCallbackQuery().catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  }
}

// ── Notify owner of access request ───────────────────────────────────────────

<<<<<<< HEAD
async function notifyOwner(bot: MyBot, userId: number, name: string, username: string | undefined): Promise<void> {
  const ownerIdStr = process.env["BOT_OWNER_ID"];
  if (!ownerIdStr) { logger.warn("BOT_OWNER_ID not set"); return; }

  const displayName = md(name);
  const displayUser = username ? ` (@${md(username)})` : "";

  await bot.api.sendMessage(
    parseInt(ownerIdStr),
    `🔔 *ACCESS REQUEST*\n━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 ${displayName}${displayUser}\n` +
    `🆔 \`${userId}\`\n\n` +
    `_Approve or decline:_`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ Approve Free", `access:approve:${userId}:free`)
        .text("💎 Premium", `access:approve:${userId}:premium`)
        .row()
        .text("👑 VIP", `access:approve:${userId}:vip`)
        .text("🚫 Decline", `access:deny:${userId}`),
=======
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
>>>>>>> ddb5a5f879e0b42eaee46badf837c8a846c0eca0
    }
  ); // let errors propagate so caller can handle
}

// ── OTP verification ──────────────────────────────────────────────────────────

async function verifyOTP(bot: MyBot, ctx: BotContext, code: string): Promise<void> {
  const userId = ctx.from!.id;
  const entry = pendingOTPs.get(userId);

  if (!entry) {
    await ctx.reply(`❌ *No active code*\n\nRequest a new one:`, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🔑 Request Access", "access:request"),
    });
    return;
  }
  if (Date.now() > entry.expiresAt) {
    pendingOTPs.delete(userId);
    await ctx.reply(`⏰ *Code expired*\n\nRequest a new code:`, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🔑 Request Again", "access:request"),
    });
    return;
  }
  if (code.trim().toUpperCase() !== entry.otp) {
    const secs = Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000));
    await ctx.reply(`❌ *Wrong code*\n\n_${secs}s remaining to retry._`, { parse_mode: "Markdown" });
    return;
  }

  pendingOTPs.delete(userId);
  await approveUser(bot, ctx, userId, entry.tier, md(entry.name), entry.username);
}

// ── Core approve function ─────────────────────────────────────────────────────

async function approveUser(
  bot: MyBot,
  ctx: BotContext | null,
  userId: number,
  tier: string,
  displayName: string,
  username?: string | null,
): Promise<void> {
  try {
    await db.insert(accessTable).values({
      userId,
      username: username ?? undefined,
      firstName: displayName,
      tier,
      isApproved: true,
      isPending: false,
      approvedAt: new Date(),
    }).onConflictDoUpdate({
      target: accessTable.userId,
      set: { tier, isApproved: true, isPending: false, approvedAt: new Date() },
    });

    const emoji = TIER_EMOJI[tier] ?? "✅";
    const label = TIER_LABEL[tier] ?? tier;

    await bot.api.sendMessage(
      userId,
      `${emoji} *Access Granted!*\n━━━━━━━━━━━━━━━━━━\n\nWelcome, ${displayName}!\n\nTier: *${label}*\n\n_You now have full access._`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⚡ Open Bot Panel", "menu:main") }
    ).catch(() => {});
  } catch (err) {
    logger.error({ err }, "approveUser error");
    if (ctx) await ctx.reply(`❌ Failed to approve: ${err instanceof Error ? err.message : "Unknown"}`);
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
<<<<<<< HEAD
  const name = md(ctx.from!.first_name ?? "User");
  const upper = code.trim().toUpperCase();
=======
  const name = ctx.from!.first_name ?? "User";
  const normalizedCode = code.trim().toUpperCase();
>>>>>>> ddb5a5f879e0b42eaee46badf837c8a846c0eca0

  // Check OTP first
  const otpEntry = pendingOTPs.get(userId);
  if (otpEntry && upper === otpEntry.otp) {
    await verifyOTP(bot, ctx, upper);
    return;
  }

  // Try permanent invite code
  try {
<<<<<<< HEAD
    const [invite] = await db.select().from(inviteCodesTable).where(eq(inviteCodesTable.code, upper));

    if (!invite || !invite.isActive) { await ctx.reply("❌ Invalid or expired code."); return; }
    if (invite.expiresAt && invite.expiresAt < new Date()) { await ctx.reply("❌ This code has expired."); return; }
    if (invite.usedCount >= invite.maxUses) { await ctx.reply("❌ This code has reached its usage limit."); return; }

    await db.insert(accessTable).values({
      userId, username: ctx.from!.username, firstName: name,
      tier: invite.tier, isApproved: true, isPending: false,
      approvedAt: new Date(), inviteCode: upper,
    }).onConflictDoUpdate({
      target: accessTable.userId,
      set: { tier: invite.tier, isApproved: true, isPending: false, approvedAt: new Date(), inviteCode: upper },
    });

    await db.update(inviteCodesTable)
      .set({ usedCount: invite.usedCount + 1, isActive: invite.usedCount + 1 < invite.maxUses })
      .where(eq(inviteCodesTable.id, invite.id));

    const emoji = TIER_EMOJI[invite.tier] ?? "✅";
    const label = TIER_LABEL[invite.tier] ?? invite.tier;

    await ctx.reply(
      `${emoji} *Access Granted!*\n━━━━━━━━━━━━━━━━━━\n\nWelcome, ${name}!\n\nTier: *${label}*`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⚡ Open Bot Panel", "menu:main") }
    );

    const ownerIdStr = process.env["BOT_OWNER_ID"];
    if (ownerIdStr) {
      await bot.api.sendMessage(parseInt(ownerIdStr),
        `✅ *Invite Used*\n\n👤 ${name}${ctx.from!.username ? ` (@${md(ctx.from!.username)})` : ""}\n🎟️ Code: \`${upper}\`\n${emoji} ${label}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
=======
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
>>>>>>> ddb5a5f879e0b42eaee46badf837c8a846c0eca0
  } catch (err) {
    logger.error({ err }, "handleInviteCode error");
    await ctx.reply("❌ Failed to process code. Please try again.");
  }
}

// ── Register all handlers ─────────────────────────────────────────────────────

export function registerAccessHandlers(bot: MyBot): void {

  // ── User: Request Access button ────────────────────────────────────────────
  bot.callbackQuery("access:request", async (ctx) => {
    await ctx.answerCallbackQuery();
    // Ask for referral before processing — free tier requires an active referrer
    ctx.session.pendingAction = "access:referral";
    await ctx.reply(
      "🔑 REQUEST ACCESS\n━━━━━━━━━━━━━━━━━━\n\n" +
      "Free access requires a referral from an active user.\n\n" +
      "Who referred you? Send their @username or Telegram ID.\n\n" +
      "_If you have an invite code instead, tap below:_",
      { reply_markup: new InlineKeyboard().text("🎟️ I Have a Code", "access:enter_code") }
    );
  });

  // ── Process referral then notify owner ────────────────────────────────────
  bot.callbackQuery("access:request_direct", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const name = ctx.from.first_name ?? "User";
    const username = ctx.from.username;

    db.insert(accessTable).values({
      userId, username, firstName: name,
      tier: "free", isApproved: false, isPending: true,
      requestMessage: "Direct request",
    }).onConflictDoUpdate({
      target: accessTable.userId,
      set: { isPending: true, username, firstName: name },
    }).catch((err) => logger.error({ err }, "DB insert failed"));

    const ownerIdStr = process.env["BOT_OWNER_ID"];
    if (ownerIdStr) {
      const displayName = md(name);
      const displayUser = username ? ` (@${md(username)})` : "";
      const ownerMsg = [
        "🔔 ACCESS REQUEST",
        "━━━━━━━━━━━━━━━━━━",
        "",
        "👤 " + displayName + displayUser,
        "🆔 " + String(userId),
        "",
        "Approve or decline:",
      ].join("\n");

      bot.api.sendMessage(
        parseInt(ownerIdStr),
        ownerMsg,
        {
          reply_markup: new InlineKeyboard()
            .text("✅ Approve Free", "access:approve:" + userId + ":free")
            .text("💎 Premium", "access:approve:" + userId + ":premium")
            .row()
            .text("👑 VIP", "access:approve:" + userId + ":vip")
            .text("🚫 Decline", "access:deny:" + userId),
        }
      ).catch((err) => logger.error({ err }, "owner notify failed"));
    }

    // Confirm to user
    await ctx.reply(
      "✅ Request Sent!\n━━━━━━━━━━━━━━━━━━\n\nYour request has been sent to the owner.\nYou will be notified once approved.\n\nIf you have an invite code:",
      { reply_markup: new InlineKeyboard().text("🎟️ Enter Code", "access:enter_code") }
    );
  });

  // ── User: Enter code button ────────────────────────────────────────────────
  bot.callbackQuery("access:enter_code", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "access:code";
    await ctx.reply(`🎟️ *ENTER CODE*\n\nSend your invite code or one-time code:`, { parse_mode: "Markdown" });
  });

  // Legacy callback alias
  bot.callbackQuery("access:invite", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "access:code";
<<<<<<< HEAD
    await ctx.reply(`🎟️ *ENTER CODE*\n\nSend your invite code:`, { parse_mode: "Markdown" });
=======
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
>>>>>>> ddb5a5f879e0b42eaee46badf837c8a846c0eca0
  });

  // ── Owner: Approve one user ────────────────────────────────────────────────
  bot.callbackQuery(/^access:approve:(\d+):(\w+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    const tier = ctx.match[2]!;
    await ctx.answerCallbackQuery(`${TIER_EMOJI[tier] ?? "✅"} Approving...`);

    const [rec] = await db.select().from(accessTable).where(eq(accessTable.userId, userId)).catch(() => [null]);
    const displayName = md(rec?.firstName ?? String(userId));

    await approveUser(bot, null, userId, tier, displayName, rec?.username);

    await ctx.editMessageText(
      `${TIER_EMOJI[tier] ?? "✅"} *Approved*\n\n👤 ${displayName}\n🆔 \`${userId}\`\nTier: *${TIER_LABEL[tier] ?? tier}*`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("👥 View All", "acl:users:all") }
    ).catch(() => ctx.reply(`✅ Approved \`${userId}\` as ${tier}.`));
  });

  // ── Owner: Decline one user ────────────────────────────────────────────────
  bot.callbackQuery(/^access:deny:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    await ctx.answerCallbackQuery("🚫 Declined");

    await db.insert(accessTable)
      .values({ userId, tier: "free", isApproved: false, isPending: false })
      .onConflictDoUpdate({ target: accessTable.userId, set: { isPending: false } })
      .catch(() => {});

    await ctx.editMessageText(
      `🚫 *Request Declined*\n\n🆔 \`${userId}\``,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⏳ View Pending", "acl:users:pending") }
    ).catch(() => {});

    await bot.api.sendMessage(userId,
      `🚫 *Access Declined*\n\nYour request was not approved at this time.`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔑 Try Again", "access:request") }
    ).catch(() => {});
  });

  // ── Owner: Approve ALL pending users ──────────────────────────────────────
  bot.callbackQuery("acl:approve_all", async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery("✅ Approving all...");

    try {
      const pending = await db.select().from(accessTable).where(eq(accessTable.isPending, true));
      if (pending.length === 0) {
        await ctx.reply("⏳ No pending requests.");
        return;
      }
      let approved = 0;
      for (const rec of pending) {
        await approveUser(bot, null, rec.userId, "free", s(rec.firstName ?? String(rec.userId)), rec.username);
        approved++;
        await new Promise((r) => setTimeout(r, 300)); // rate limit
      }
      await ctx.reply(`✅ Approved *${approved}* pending users as Free.`, { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  // ── Owner: Decline ALL pending users ──────────────────────────────────────
  bot.callbackQuery("acl:decline_all", async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery("🚫 Declining all...");

    try {
      const pending = await db.select().from(accessTable).where(eq(accessTable.isPending, true));
      if (pending.length === 0) { await ctx.reply("⏳ No pending requests."); return; }

      await db.update(accessTable).set({ isPending: false }).where(eq(accessTable.isPending, true));

      for (const rec of pending) {
        await bot.api.sendMessage(rec.userId,
          `🚫 *Access Declined*\n\nYour request was not approved.`,
          { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔑 Try Again", "access:request") }
        ).catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
      }
      await ctx.reply(`🚫 Declined *${pending.length}* pending requests.`, { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  // ── Owner: hex:access panel ────────────────────────────────────────────────
  bot.callbackQuery("hex:access", async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    try {
      const all = await db.select().from(accessTable);
      const pending = all.filter((a) => a.isPending);
      const approved = all.filter((a) => a.isApproved);
      const blocked = all.filter((a) => a.tier === "blocked");

      await ctx.editMessageText(
        `🔐 *ACCESS CONTROL*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `👥 Total: *${all.length}*\n` +
        `✅ Approved: *${approved.length}*\n` +
        `⏳ Pending: *${pending.length}*\n` +
        `🚫 Blocked: *${blocked.length}*`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("👥 All Users", "acl:users:all").text("⏳ Pending", "acl:users:pending").row()
            .text("💎 Premium", "acl:users:premium").text("👑 VIP", "acl:users:vip").row()
            .text("🚫 Blocked", "acl:users:blocked").text("🎟️ Invite Codes", "acl:invites").row()
            .text("✅ Approve All Pending", "acl:approve_all").row()
            .text("🚫 Decline All Pending", "acl:decline_all").row()
            .text("➕ Generate Invite", "acl:invite:generate").row()
            .text("🔙 Hex Panel", "hex:main"),
        }
      );
    } catch (err) { await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`); }
  });

  // ── Owner: view users by filter ────────────────────────────────────────────
  bot.callbackQuery(/^acl:users:(.+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    try {
      const filter = ctx.match[1]!;
      const all = await db.select().from(accessTable).orderBy(desc(accessTable.createdAt)).limit(20);
      const filtered = filter === "all" ? all
        : filter === "pending" ? all.filter((a) => a.isPending)
        : filter === "blocked" ? all.filter((a) => a.tier === "blocked")
        : all.filter((a) => a.tier === filter && a.isApproved);

      const titles: Record<string, string> = {
        all: "ALL USERS", pending: "PENDING REQUESTS",
        premium: "PREMIUM USERS", vip: "VIP USERS", blocked: "BLOCKED USERS",
      };

      const lines = filtered.length === 0 ? "_No users found._"
        : filtered.map((a) => {
            const name = md(a.firstName ?? "Unknown");
            const user = a.username ? ` @${s(a.username)}` : "";
            const status = a.isPending ? "⏳ Pending" : a.isApproved ? "✅ Active" : "❌ Inactive";
            return `${TIER_EMOJI[a.tier] ?? "⚪"} ${name}${user} \`${a.userId}\`\n   ${status} · ${a.tier}`;
          }).join("\n\n");

      const kb = new InlineKeyboard();
      if (filter === "pending" && filtered.length > 0) {
        kb.text("✅ Approve All", "acl:approve_all").text("🚫 Decline All", "acl:decline_all").row();
        // One-by-one approve buttons for first 5
        for (const u of filtered.slice(0, 5)) {
          const name = md(u.firstName ?? String(u.userId)).slice(0, 15);
          kb.text(`✅ ${name}`, `access:approve:${u.userId}:free`)
            .text(`🚫`, `access:deny:${u.userId}`).row();
        }
      }
      kb.text("🔙 Back", "hex:access");

      await ctx.editMessageText(
        `🔐 *${titles[filter] ?? filter.toUpperCase()}*\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
        { parse_mode: "Markdown", reply_markup: kb }
      );
    } catch (err) { await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`); }
  });

  // ── Owner: view invite codes ───────────────────────────────────────────────
  bot.callbackQuery("acl:invites", async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    try {
      const codes = await db.select().from(inviteCodesTable)
        .orderBy(desc(inviteCodesTable.createdAt)).limit(15);

      const lines = codes.length === 0 ? "_No codes yet._"
        : codes.map((c) => {
            // Sanitise note field — this was causing the parse error
            const note = c.note ? ` - ${md(c.note)}` : "";
            const status = c.isActive ? "🟢" : "🔴";
            const tier = TIER_EMOJI[c.tier] ?? "";
            return `${status} \`${c.code}\` ${tier} ${c.tier} - ${c.usedCount}/${c.maxUses} uses${note}`;
          }).join("\n");

      await ctx.editMessageText(
        `🎟️ INVITE CODES\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
        {
          reply_markup: new InlineKeyboard()
            .text("➕ Generate New", "acl:invite:generate").row()
            .text("🔙 Back", "hex:access"),
        }
      );
    } catch (err) {
      logger.error({ err }, "acl:invites error");
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  // ── Owner: generate invite code prompt ────────────────────────────────────
  bot.callbackQuery("acl:invite:generate", async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    ctx.session.pendingAction = "acl:generate_invite";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🎟️ GENERATE INVITE CODE\n━━━━━━━━━━━━━━━━━━\n\nSend in format:\nTIER USES NOTE\n\nExamples:\npremium 1 For username\nvip 3 Bulk access\nfree 10 Open invite\n\nTiers: free - premium - vip`,
    );
  });

  // ── Owner: upgrade user ────────────────────────────────────────────────────
  bot.callbackQuery(/^acl:promote:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    const [rec] = await db.select().from(accessTable).where(eq(accessTable.userId, userId)).catch(() => [null]);
    if (!rec) { await ctx.answerCallbackQuery("❌ User not found"); return; }
    const next = rec.tier === "free" ? "premium" : rec.tier === "premium" ? "vip" : null;
    if (!next) { await ctx.answerCallbackQuery("Already VIP"); return; }
    await db.update(accessTable).set({ tier: next }).where(eq(accessTable.userId, userId));
    await ctx.answerCallbackQuery((TIER_EMOJI[next] ?? "") + " Promoted to " + TIER_LABEL[next]);
    await bot.api.sendMessage(userId, (TIER_EMOJI[next] ?? "") + " You have been promoted to " + TIER_LABEL[next] + "!").catch(() => {});
  });

  bot.callbackQuery(/^acl:demote:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    const [rec] = await db.select().from(accessTable).where(eq(accessTable.userId, userId)).catch(() => [null]);
    if (!rec) { await ctx.answerCallbackQuery("❌ User not found"); return; }
    const prev = rec.tier === "vip" ? "premium" : rec.tier === "premium" ? "free" : null;
    if (!prev) { await ctx.answerCallbackQuery("Already Free"); return; }
    await db.update(accessTable).set({ tier: prev }).where(eq(accessTable.userId, userId));
    await ctx.answerCallbackQuery("⬇️ Demoted to " + TIER_LABEL[prev]);
    await bot.api.sendMessage(userId, "⬇️ Your tier has been updated to " + TIER_LABEL[prev] + ".").catch(() => {});
  });

  bot.callbackQuery(/^acl:upgrade:(\d+):(\w+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!); const tier = ctx.match[2]!;
    await db.update(accessTable).set({ tier }).where(eq(accessTable.userId, userId));
    await ctx.answerCallbackQuery(`${TIER_EMOJI[tier] ?? ""} Upgraded`);
    await bot.api.sendMessage(userId, `${TIER_EMOJI[tier] ?? ""} Your tier has been upgraded to ${TIER_LABEL[tier] ?? tier}!`).catch(() => {});
  });

  // ── Owner: block user ──────────────────────────────────────────────────────
  bot.callbackQuery(/^acl:block:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    await db.update(accessTable).set({ tier: "blocked", isApproved: false, blockedAt: new Date() }).where(eq(accessTable.userId, userId));
    await ctx.answerCallbackQuery("🚫 Blocked");
    await ctx.reply(`🚫 User \`${userId}\` has been blocked.`, { parse_mode: "Markdown" });
  });

  // ── Owner commands ─────────────────────────────────────────────────────────
  bot.command("access", async (ctx) => {
    if (!isOwner(ctx.from!.id)) { await ctx.reply("⛔ Owner only."); return; }
    const all = await db.select().from(accessTable).catch(() => []);
    const pending = all.filter((a) => a.isPending);
<<<<<<< HEAD
=======
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
>>>>>>> ddb5a5f879e0b42eaee46badf837c8a846c0eca0
    await ctx.reply(
      `🔐 ACCESS CONTROL\n━━━━━━━━━━━━━━━━━━\n\n` +
      `Total: ${all.length} - Approved: ${all.filter((a) => a.isApproved).length}\n` +
      `Pending: ${pending.length} - Blocked: ${all.filter((a) => a.tier === "blocked").length}`,
      {
        reply_markup: new InlineKeyboard()
          .text("👥 All Users", "acl:users:all").text("⏳ Pending", "acl:users:pending").row()
          .text("✅ Approve All", "acl:approve_all").text("🚫 Decline All", "acl:decline_all").row()
          .text("🎟️ Invite Codes", "acl:invites").text("➕ Generate", "acl:invite:generate"),
      }
    );
  });

  // ── Debug: test owner notification ───────────────────────────────────────
  bot.command("testnotify", async (ctx) => {
    if (!isOwner(ctx.from!.id)) return;
    const ownerIdStr = process.env["BOT_OWNER_ID"];
    await ctx.reply(
      `🔧 Debug:
BOT_OWNER_ID = \`${ownerIdStr ?? "NOT SET"}\`
Your ID = \`${ctx.from!.id}\`
Match = ${String(ctx.from!.id) === ownerIdStr}`,
      { parse_mode: "Markdown" }
    );
    try {
      await bot.api.sendMessage(
        parseInt(ownerIdStr ?? "0"),
        `🔔 TEST NOTIFICATION

This is a test from /testnotify
If you see this, owner notifications work.`,
      );
      await ctx.reply("✅ Test notification sent to owner ID.");
    } catch (err) {
      await ctx.reply(`❌ Failed to send to owner: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  });

  bot.command("approve", async (ctx) => {
    if (!isOwner(ctx.from!.id)) return;
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    const userId = parseInt(parts[0] ?? ""); const tier = parts[1] ?? "free";
    if (isNaN(userId)) { await ctx.reply("Usage: /approve <userId> [free|premium|vip]"); return; }
    const [rec] = await db.select().from(accessTable).where(eq(accessTable.userId, userId)).catch(() => [null]);
    await approveUser(bot, ctx, userId, tier, md(rec?.firstName ?? String(userId)), rec?.username);
    await ctx.reply(`✅ Approved ${userId} as ${tier}.`);
  });

  bot.command("revoke", async (ctx) => {
    if (!isOwner(ctx.from!.id)) return;
    const userId = parseInt(ctx.match?.trim() ?? "");
    if (isNaN(userId)) { await ctx.reply("Usage: /revoke <userId>"); return; }
    await db.update(accessTable).set({ isApproved: false }).where(eq(accessTable.userId, userId));
    await ctx.reply(`🚫 Access revoked for ${userId}.`);
  });

  bot.command("block", async (ctx) => {
    if (!isOwner(ctx.from!.id)) return;
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    const userId = parseInt(parts[0] ?? "");
    const reason = parts.slice(1).join(" ") || undefined;
    if (isNaN(userId)) { await ctx.reply("Usage: /block <userId> [reason]"); return; }
    await db.update(accessTable)
      .set({ tier: "blocked", isApproved: false, blockedAt: new Date(), blockedReason: reason ?? null })
      .where(eq(accessTable.userId, userId));
    await ctx.reply(`🚫 ${userId} blocked.${reason ? ` Reason: ${reason}` : ""}`);
  });
}

// ── Input processor (called from menu.ts) ─────────────────────────────────────

export async function processAccessInput(bot: MyBot, ctx: BotContext, action: string, text: string): Promise<void> {
  if (action === "access:verify_otp") {
    await verifyOTP(bot, ctx, text);

  } else if (action === "access:referral") {
    // Process referral check for free tier
    const referralText = text.trim();
    const userId = ctx.from!.id;
    const name = ctx.from!.first_name ?? "User";
    const username = ctx.from!.username;

    // Look up referrer
    let referrerId: number | null = null;
    let referrerName = referralText;

    try {
      // Try by username
      if (referralText.startsWith("@")) {
        const uname = referralText.slice(1);
        const [ref] = await db.select().from(accessTable).where(eq(accessTable.username, uname));
        if (ref?.isApproved) { referrerId = ref.userId; referrerName = md(ref.firstName ?? uname); }
      } else {
        // Try by ID
        const refId = parseInt(referralText);
        if (!isNaN(refId)) {
          const [ref] = await db.select().from(accessTable).where(eq(accessTable.userId, refId));
          if (ref?.isApproved) { referrerId = ref.userId; referrerName = md(ref.firstName ?? String(refId)); }
        }
      }
    } catch { /* ignore */ }

    if (!referrerId) {
      await ctx.reply(
        "❌ That user was not found or is not an active member.\n\n" +
        "Ask an active user to share their ID or username, then try again.\n\n" +
        "Or upgrade directly:",
        { reply_markup: new InlineKeyboard()
          .text("💎 Get Premium ($10)", "sub:buy:premium")
          .text("👑 Get VIP ($10)", "sub:buy:vip")
          .row()
          .text("🔙 Back", "menu:main") }
      );
      return;
    }

    // Valid referrer — save to DB and notify owner
    await db.insert(accessTable).values({
      userId, username, firstName: name,
      tier: "free", isApproved: false, isPending: true,
      requestMessage: "Referred by " + referralText,
    }).onConflictDoUpdate({
      target: accessTable.userId,
      set: { isPending: true, requestMessage: "Referred by " + referralText, username, firstName: name },
    }).catch((err) => logger.error({ err }, "referral DB insert failed"));

    const ownerIdStr = process.env["BOT_OWNER_ID"];
    if (ownerIdStr) {
      bot.api.sendMessage(
        parseInt(ownerIdStr),
        [
          "🔔 ACCESS REQUEST",
          "━━━━━━━━━━━━━━━━━━",
          "",
          "👤 " + md(name) + safeUsername(username),
          "🆔 " + userId,
          "👥 Referred by: " + referrerName + " (" + referrerId + ")",
          "",
          "Approve or decline:",
        ].join("\n"),
        {
          reply_markup: new InlineKeyboard()
            .text("✅ Approve Free", "access:approve:" + userId + ":free")
            .text("💎 Premium", "access:approve:" + userId + ":premium")
            .row()
            .text("👑 VIP", "access:approve:" + userId + ":vip")
            .text("🚫 Decline", "access:deny:" + userId),
        }
      ).catch((err) => logger.error({ err }, "owner notify failed"));
    }

    await ctx.reply(
      "✅ Request Sent!\n━━━━━━━━━━━━━━━━━━\n\n" +
      "Your request has been sent to the owner.\n" +
      "Referrer: " + referrerName + "\n\n" +
      "You will be notified once approved.",
      { reply_markup: new InlineKeyboard().text("🎟️ Enter Code", "access:enter_code") }
    );

  } else if (action === "access:code") {
    await handleInviteCode(bot, ctx, text.trim());

  } else if (action === "acl:generate_invite") {
    const parts = text.trim().split(/\s+/);
    const tier = parts[0] ?? "free";
    const maxUses = parseInt(parts[1] ?? "1");
    const note = parts.slice(2).join(" ") || undefined;

    if (!["free", "premium", "vip"].includes(tier)) {
      await ctx.reply("❌ Invalid tier. Use: free - premium - vip");
      return;
    }
    const code = generateCode(8);
    const uses = isNaN(maxUses) ? 1 : Math.max(1, maxUses);

    try {
      await db.insert(inviteCodesTable).values({
        code, tier, maxUses: uses,
        createdBy: ctx.from!.id,
        note: note ?? null,
        isActive: true,
      });

      const botUsername = process.env.BOT_USERNAME ?? "crescent07_bot";
      await ctx.reply(
        `🎟️ INVITE CODE CREATED\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Code: ${code}\n` +
        `Tier: ${TIER_LABEL[tier] ?? tier}\n` +
        `Max uses: ${uses}\n` +
        (note ? `Note: ${note}\n` : "") +
        `\nShare link:\nt.me/${botUsername}?start=${code}`,
        { reply_markup: new InlineKeyboard().text("🎟️ View Codes", "acl:invites") }
      );
    } catch (err) {
      await ctx.reply(`❌ Failed: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  }
}
