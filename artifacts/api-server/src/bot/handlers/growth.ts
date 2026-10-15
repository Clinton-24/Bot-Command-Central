/**
 * Growth / onboarding helpers
 * - Auto free tier on first /start
 * - Deep-link referrals: t.me/bot?start=ref_<telegramId>
 * - Two-sided rewards (invitee free access, inviter bonus Crescent credits)
 */
import { InlineKeyboard } from "grammy";
import { eq } from "drizzle-orm";
import { db, accessTable } from "@workspace/db";
import type { MyBot } from "../index";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";
import { addBonusCredits, REFERRAL_BONUS_CREDITS } from "./crescent-quota";

export function botUsername(): string {
  return (process.env.BOT_USERNAME ?? "crescent07_bot").replace(/^@/, "");
}

export function referralLink(userId: number): string {
  return `https://t.me/${botUsername()}?start=ref_${userId}`;
}

export function shareFooter(): string {
  return `\n\n— via @${botUsername()} · /invite`;
}

/** Parse /start payload → referral inviter id or null */
export function parseReferralPayload(payload: string | undefined): number | null {
  if (!payload) return null;
  const m = payload.trim().match(/^ref[_-]?(\d{5,15})$/i);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Ensure user has free approved access (self-serve).
 * Does not change blocked / premium / vip / already-approved users.
 */
export async function ensureAutoFreeAccess(user: {
  id: number;
  username?: string | null;
  firstName?: string | null;
}): Promise<"created" | "already" | "blocked" | "skipped"> {
  if (isOwner(user.id)) return "skipped";

  const [existing] = await db.select().from(accessTable).where(eq(accessTable.userId, user.id));
  if (existing?.tier === "blocked") return "blocked";
  if (existing?.isApproved) return "already";

  const now = new Date();
  await db
    .insert(accessTable)
    .values({
      userId: user.id,
      username: user.username ?? null,
      firstName: user.firstName ?? null,
      tier: "free",
      isApproved: true,
      isPending: false,
      approvedAt: now,
      requestMessage: "auto-free-onboarding",
    })
    .onConflictDoUpdate({
      target: accessTable.userId,
      set: {
        tier: "free",
        isApproved: true,
        isPending: false,
        approvedAt: now,
        username: user.username ?? null,
        firstName: user.firstName ?? null,
      },
    });

  return "created";
}

/** Apply referral: approve invitee (free) + bonus credits to inviter */
export async function applyReferralReward(
  bot: MyBot,
  invitee: { id: number; username?: string | null; firstName?: string | null },
  inviterId: number,
): Promise<boolean> {
  if (!inviterId || inviterId === invitee.id) return false;
  if (isOwner(invitee.id)) return false;

  const [inviterAccess] = await db.select().from(accessTable).where(eq(accessTable.userId, inviterId));
  const inviterOk =
    isOwner(inviterId) ||
    (!!inviterAccess?.isApproved && inviterAccess.tier !== "blocked");
  if (!inviterOk) return false;

  await ensureAutoFreeAccess(invitee);

  await db
    .update(accessTable)
    .set({
      invitedBy: inviterId,
      requestMessage: `Referral deep-link from ${inviterId}`,
      approvedBy: inviterId,
    })
    .where(eq(accessTable.userId, invitee.id))
    .catch(() => {});

  try {
    const newBal = await addBonusCredits(inviterId, REFERRAL_BONUS_CREDITS);
    const name = invitee.firstName ?? invitee.username ?? String(invitee.id);
    await bot.api
      .sendMessage(
        inviterId,
        `🎁 Referral reward!\n━━━━━━━━━━━━━━━━━━\n\n` +
          `${name} joined with your link.\n` +
          `+${REFERRAL_BONUS_CREDITS} Crescent bonus queries (balance: ${newBal}).\n\n` +
          `Keep sharing:\n${referralLink(inviterId)}`,
      )
      .catch(() => {});
  } catch (err) {
    logger.warn({ err, inviterId }, "referral bonus failed");
  }

  const ownerId = Number(process.env.BOT_OWNER_ID ?? "0");
  if (ownerId) {
    await bot.api
      .sendMessage(
        ownerId,
        `🤝 New referral\nInvitee: ${invitee.id}\nInviter: ${inviterId}`,
      )
      .catch(() => {});
  }

  return true;
}

export function growthWelcomeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🤖 Try Crescent AI", "growth:try_crescent")
    .row()
    .text("🏠 Main Menu", "menu:main")
    .text("🔗 Invite friends", "growth:invite")
    .row()
    .text("💳 Upgrade", "access:plans");
}

export function growthWelcomeText(name: string, isNew: boolean): string {
  return (
    `⚡ *BOT-COMMAND-CENTRAL*\n━━━━━━━━━━━━━━━━━━\n\n` +
    `Hey *${name}*!\n\n` +
    `Your AI secretary in Telegram:\n` +
    `• 🤖 *Crescent AI* — chat, images, briefings\n` +
    `• ☀️ Daily digest at 10:00 Nairobi\n` +
    `• 🛍️ Shop & tools for members\n\n` +
    (isNew
      ? `🟢 *Free access unlocked* — 10 Crescent queries/day.\n`
      : `🟢 Free tier: limited Crescent + shop.\n`) +
    `Invite friends → earn bonus AI queries.\n\n` +
    `_Tap Try Crescent or open the menu._`
  );
}
