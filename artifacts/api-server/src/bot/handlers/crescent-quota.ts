import { and, eq } from "drizzle-orm";
import {
  accessTable,
  crescentQuotaCreditsTable,
  crescentQuotaPurchasesTable,
  db,
  usersTable,
} from "@workspace/db";
import { isOwner } from "../helpers";

/** Free tier: 10/day. Premium/VIP get more. Owner = unlimited. */
export const CRESCENT_DAILY_LIMIT = 10;
export const CRESCENT_PREMIUM_LIMIT = 100;
export const CRESCENT_VIP_LIMIT = 200;
export const CRESCENT_TOPUP_CREDITS = 20;
export const CRESCENT_TOPUP_PRICE = 2;
export const REFERRAL_BONUS_CREDITS = 5;

type QuotaState = {
  used: number;
  limit: number;
  bonus: number;
  allowed: boolean;
  unlimited: boolean;
};

function getNairobiDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

async function isUnlimitedUser(userId: number): Promise<boolean> {
  if (isOwner(userId)) return true;
  try {
    const [user] = await db
      .select({ isOwner: usersTable.isOwner })
      .from(usersTable)
      .where(eq(usersTable.id, userId));
    return user?.isOwner === true;
  } catch {
    return false;
  }
}

async function dailyLimitFor(userId: number): Promise<number> {
  try {
    const [row] = await db.select().from(accessTable).where(eq(accessTable.userId, userId));
    const tier = (row?.tier ?? "free").toLowerCase();
    if (tier === "vip") return CRESCENT_VIP_LIMIT;
    if (tier === "premium") return CRESCENT_PREMIUM_LIMIT;
  } catch {
    /* ignore */
  }
  return CRESCENT_DAILY_LIMIT;
}

export async function getCrescentQuotaStatus(userId: number): Promise<QuotaState> {
  if (await isUnlimitedUser(userId)) {
    return { used: 0, limit: Number.POSITIVE_INFINITY, bonus: 0, allowed: true, unlimited: true };
  }
  const limit = await dailyLimitFor(userId);
  const today = getNairobiDate();
  const [quota] = await db
    .select()
    .from(crescentQuotaCreditsTable)
    .where(eq(crescentQuotaCreditsTable.userId, userId));

  // New calendar day (Nairobi) → daily counter resets; bonus credits keep
  if (!quota || quota.dailyDate !== today) {
    const bonus = quota?.credits ?? 0;
    return { used: 0, limit, bonus, allowed: true, unlimited: false };
  }

  const used = Math.max(0, Number(quota.dailyUsed) || 0);
  const bonus = Math.max(0, Number(quota.credits) || 0);
  const allowed = used < limit || bonus > 0;
  return { used, limit, bonus, allowed, unlimited: false };
}

export async function consumeCrescentQuota(userId: number): Promise<QuotaState> {
  if (await isUnlimitedUser(userId)) {
    return { used: 0, limit: Number.POSITIVE_INFINITY, bonus: 0, allowed: true, unlimited: true };
  }

  const limit = await dailyLimitFor(userId);
  const today = getNairobiDate();

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(crescentQuotaCreditsTable)
      .where(eq(crescentQuotaCreditsTable.userId, userId));

    const sameDay = existing?.dailyDate === today;
    const dailyUsed = sameDay ? Math.max(0, Number(existing.dailyUsed) || 0) : 0;
    const credits = Math.max(0, Number(existing?.credits) || 0);

    if (dailyUsed >= limit && credits <= 0) {
      return { used: dailyUsed, limit, bonus: credits, allowed: false, unlimited: false };
    }

    let nextDailyUsed = dailyUsed;
    let nextCredits = credits;
    if (dailyUsed < limit) {
      nextDailyUsed = dailyUsed + 1;
    } else {
      nextCredits = credits - 1;
    }

    const values = {
      userId,
      credits: nextCredits,
      dailyDate: today,
      dailyUsed: nextDailyUsed,
      updatedAt: new Date(),
    };

    if (existing) {
      await tx
        .update(crescentQuotaCreditsTable)
        .set(values)
        .where(eq(crescentQuotaCreditsTable.userId, userId));
    } else {
      await tx.insert(crescentQuotaCreditsTable).values(values);
    }

    return {
      used: nextDailyUsed,
      limit,
      bonus: nextCredits,
      allowed: true,
      unlimited: false,
    };
  });
}

/** Undo one consume (e.g. AI failed / inline timed out). */
export async function refundCrescentQuota(userId: number): Promise<void> {
  if (await isUnlimitedUser(userId)) return;
  const today = getNairobiDate();
  try {
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(crescentQuotaCreditsTable)
        .where(eq(crescentQuotaCreditsTable.userId, userId));
      if (!existing || existing.dailyDate !== today) return;
      const used = Math.max(0, (Number(existing.dailyUsed) || 0) - 1);
      await tx
        .update(crescentQuotaCreditsTable)
        .set({ dailyUsed: used, updatedAt: new Date() })
        .where(eq(crescentQuotaCreditsTable.userId, userId));
    });
  } catch {
    /* ignore refund errors */
  }
}

/** Owner tool: reset a user's daily counter to 0 (keeps bonus). */
export async function resetDailyQuota(userId: number): Promise<void> {
  const today = getNairobiDate();
  const [existing] = await db
    .select()
    .from(crescentQuotaCreditsTable)
    .where(eq(crescentQuotaCreditsTable.userId, userId));
  if (existing) {
    await db
      .update(crescentQuotaCreditsTable)
      .set({ dailyUsed: 0, dailyDate: today, updatedAt: new Date() })
      .where(eq(crescentQuotaCreditsTable.userId, userId));
  } else {
    await db.insert(crescentQuotaCreditsTable).values({
      userId,
      credits: 0,
      dailyDate: today,
      dailyUsed: 0,
    });
  }
}

export function formatCrescentQuota(quota: QuotaState): string {
  if (quota.unlimited) return "Unlimited";
  if (quota.used < quota.limit) {
    return `${quota.used}/${quota.limit} daily` + (quota.bonus > 0 ? ` · ${quota.bonus} bonus` : "");
  }
  if (quota.bonus > 0) return `${quota.bonus} bonus queries remaining`;
  return `0/${quota.limit} daily used up`;
}

export async function createCrescentQuotaPurchase(userId: number, asset: string) {
  const [purchase] = await db
    .insert(crescentQuotaPurchasesTable)
    .values({ userId, credits: CRESCENT_TOPUP_CREDITS, amount: CRESCENT_TOPUP_PRICE.toFixed(2), asset })
    .returning();
  return purchase;
}

export async function attachCrescentQuotaInvoice(purchaseId: number, invoiceId: number): Promise<void> {
  await db
    .update(crescentQuotaPurchasesTable)
    .set({ invoiceId })
    .where(eq(crescentQuotaPurchasesTable.id, purchaseId));
}

export async function confirmCrescentQuotaPurchase(
  purchaseId: number,
  userId: number,
  invoiceId: number,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [purchase] = await tx
      .select()
      .from(crescentQuotaPurchasesTable)
      .where(and(eq(crescentQuotaPurchasesTable.id, purchaseId), eq(crescentQuotaPurchasesTable.userId, userId)));
    if (!purchase || purchase.status === "confirmed") return false;
    await tx
      .update(crescentQuotaPurchasesTable)
      .set({ status: "confirmed", invoiceId, confirmedAt: new Date() })
      .where(eq(crescentQuotaPurchasesTable.id, purchaseId));
    const [quota] = await tx
      .select()
      .from(crescentQuotaCreditsTable)
      .where(eq(crescentQuotaCreditsTable.userId, userId));
    if (quota) {
      await tx
        .update(crescentQuotaCreditsTable)
        .set({ credits: quota.credits + purchase.credits, updatedAt: new Date() })
        .where(eq(crescentQuotaCreditsTable.userId, userId));
    } else {
      await tx.insert(crescentQuotaCreditsTable).values({ userId, credits: purchase.credits });
    }
    return true;
  });
}

export async function addBonusCredits(userId: number, amount: number): Promise<number> {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const today = getNairobiDate();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(crescentQuotaCreditsTable)
      .where(eq(crescentQuotaCreditsTable.userId, userId));
    const credits = (existing?.credits ?? 0) + Math.floor(amount);
    const dailyUsed = existing?.dailyDate === today ? existing.dailyUsed : 0;
    if (existing) {
      await tx
        .update(crescentQuotaCreditsTable)
        .set({ credits, dailyDate: today, dailyUsed, updatedAt: new Date() })
        .where(eq(crescentQuotaCreditsTable.userId, userId));
    } else {
      await tx.insert(crescentQuotaCreditsTable).values({
        userId,
        credits,
        dailyDate: today,
        dailyUsed: 0,
        updatedAt: new Date(),
      });
    }
    return credits;
  });
}
