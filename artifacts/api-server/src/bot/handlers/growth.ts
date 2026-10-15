/**
 * Growth / onboarding helpers
 * NOTE: Do NOT import from ../index (circular with welcome → index).
 */
import { InlineKeyboard } from "grammy";
import { eq } from "drizzle-orm";
import { db, accessTable } from "@workspace/db";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";
import { addBonusCredits, REFERRAL_BONUS_CREDITS } from "./crescent-quota";

type NotifyBot = {
  api: {
    sendMessage: (chatId: number, text: string, other?: object) => Promise<unknown>;
  };
};

/** Escape Telegram legacy Markdown special chars in user-controlled strings */
export function escapeMd(s: string): string {
  return s.replace(/([_*\[`])/g, "\\$1");
}

export function botUsername(): string {
  return (process.env.BOT_USERNAME ?? "crescent07_bot").replace(/^@/, "");
}

export function referralLink(userId: number): string {
  return `https://t.me/${botUsername()}?start=ref_${userId}`;
}

export function shareFooter(): string {
  return `\n\n— via @${botUsername()} · /invite`;
}

export function parseReferralPayload(payload: string | undefined): number | null {
  if (!payload) return null;
  const m = payload.trim().match(/^ref[_-]?(\d{5,15})$/i);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export async function ensureAutoFreeAccess(user: {
  id: number;
  username?: string | null;
  firstName?: string | null;
}): Promise<"created" | "already" | "blocked" | "skipped"> {
  if (isOwner(user.id)) return "skipped";

  try {
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
  } catch (err) {
    logger.error({ err, userId: user.id }, "ensureAutoFreeAccess failed");
    return "already";
  }
}

export async function applyReferralReward(
  bot: NotifyBot,
  invitee: { id: number; username?: string | null; firstName?: string | null },
  inviterId: number,
): Promise<boolean> {
  if (!inviterId || inviterId === invitee.id) return false;
  if (isOwner(invitee.id)) return false;

  try {
    const [inviterAccess] = await db.select().from(accessTable).where(eq(accessTable.userId, inviterId));
    const inviterOk =
      isOwner(inviterId) ||
      (!!inviterAccess?.isApproved && inviterAccess.tier !== "blocked");
    if (!inviterOk) return false;

    await ensureAutoFreeAccess(invitee);

    try {
      await db
        .update(accessTable)
        .set({
          invitedBy: inviterId,
          requestMessage: `Referral deep-link from ${inviterId}`,
          approvedBy: inviterId,
        })
        .where(eq(accessTable.userId, invitee.id));
    } catch (err) {
      logger.warn({ err }, "referral metadata update failed");
    }

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
        .sendMessage(ownerId, `🤝 New referral\nInvitee: ${invitee.id}\nInviter: ${inviterId}`)
        .catch(() => {});
    }

    return true;
  } catch (err) {
    logger.error({ err, inviterId, inviteeId: invitee.id }, "applyReferralReward failed");
    return false;
  }
}

export function growthWelcomeKeyboard(asOwner = false): InlineKeyboard {
  if (asOwner) {
    return new InlineKeyboard()
      .text("🤖 Try Crescent", "growth:try_crescent")
      .row()
      .text("🏠 Main Menu", "menu:main");
  }
  return new InlineKeyboard()
    .text("🤖 Try Crescent", "growth:try_crescent")
    .row()
    .text("🏠 Main Menu", "menu:main")
    .text("🔗 Invite friends", "growth:invite")
    .row()
    .text("💳 Upgrade", "access:plans");
}

export function growthWelcomeText(
  displayName: string,
  isNew: boolean,
  asOwner = false,
): string {
  // Escape user-controlled names so Telegram Markdown never 400s
  const who = escapeMd(displayName);
  let body =
    `🌙 *Crescent*\n━━━━━━━━━━━━━━━━━━\n\n` +
    `Hey ${who}\n` +
    `Welcome to *God of Credentials* bot.\n\n` +
    `Your AI secretary in Telegram:\n` +
    `• 🤖 *Crescent* — chat, images, briefings\n` +
    `• ☀️ Daily digest at 10:00 Nairobi\n` +
    `• 🛍️ Shop & tools for members\n\n`;

  if (asOwner) {
    body +=
      `👑 *Owner* — Crescent quota: *Unlimited* (no daily cap).\n` +
      `Full control of access, shop, and kill switch.\n\n`;
  } else if (isNew) {
    body += `🟢 *Free access unlocked* — 10 Crescent queries/day.\n`;
  } else {
    body += `🟢 Free tier: limited Crescent + shop.\n`;
  }

  if (!asOwner) {
    body += `Invite friends → earn bonus AI queries.\n\n`;
  }

  body += `_Tap Try Crescent or open the menu._`;
  return body;
}
