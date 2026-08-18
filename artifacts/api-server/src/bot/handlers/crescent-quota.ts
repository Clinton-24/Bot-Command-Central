import { and, eq } from "drizzle-orm";
import {
  crescentQuotaCreditsTable,
  crescentQuotaPurchasesTable,
  db,
  usersTable,
} from "@workspace/db";

export const CRESCENT_DAILY_LIMIT = 50;
export const CRESCENT_TOPUP_CREDITS = 20;
export const CRESCENT_TOPUP_PRICE = 2;

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
  const [user] = await db
    .select({ isOwner: usersTable.isOwner })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return user?.isOwner === true;
}

export async function getCrescentQuotaStatus(userId: number): Promise<QuotaState> {
  if (await isUnlimitedUser(userId)) {
    return { used: 0, limit: CRESCENT_DAILY_LIMIT, bonus: 0, allowed: true, unlimited: true };
  }

  const today = getNairobiDate();
  const [quota] = await db
    .select()
    .from(crescentQuotaCreditsTable)
    .where(eq(crescentQuotaCreditsTable.userId, userId));

  if (!quota || quota.dailyDate !== today) {
    return { used: 0, limit: CRESCENT_DAILY_LIMIT, bonus: quota?.credits ?? 0, allowed: true, unlimited: false };
  }

  return {
    used: quota.dailyUsed,
    limit: CRESCENT_DAILY_LIMIT,
    bonus: quota.credits,
    allowed: quota.dailyUsed < CRESCENT_DAILY_LIMIT || quota.credits > 0,
    unlimited: false,
  };
}

export async function consumeCrescentQuota(userId: number): Promise<QuotaState> {
  if (await isUnlimitedUser(userId)) {
    return { used: 0, limit: CRESCENT_DAILY_LIMIT, bonus: 0, allowed: true, unlimited: true };
  }

  const today = getNairobiDate();
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(crescentQuotaCreditsTable)
      .where(eq(crescentQuotaCreditsTable.userId, userId));

    const dailyUsed = existing?.dailyDate === today ? existing.dailyUsed : 0;
    const credits = existing?.dailyDate === today ? existing.credits : existing?.credits ?? 0;
    if (dailyUsed >= CRESCENT_DAILY_LIMIT && credits <= 0) {
      return { used: dailyUsed, limit: CRESCENT_DAILY_LIMIT, bonus: 0, allowed: false, unlimited: false };
    }

    const nextDailyUsed = dailyUsed < CRESCENT_DAILY_LIMIT ? dailyUsed + 1 : dailyUsed;
    const nextCredits = dailyUsed < CRESCENT_DAILY_LIMIT ? credits : credits - 1;
    const values = { userId, credits: nextCredits, dailyDate: today, dailyUsed: nextDailyUsed, updatedAt: new Date() };

    if (existing) {
      await tx.update(crescentQuotaCreditsTable).set(values).where(eq(crescentQuotaCreditsTable.userId, userId));
    } else {
      await tx.insert(crescentQuotaCreditsTable).values(values);
    }

    return {
      used: nextDailyUsed,
      limit: CRESCENT_DAILY_LIMIT,
      bonus: nextCredits,
      allowed: true,
      unlimited: false,
    };
  });
}

export function formatCrescentQuota(quota: QuotaState): string {
  if (quota.unlimited) return "Unlimited";
  if (quota.used < quota.limit) return `${quota.used}/${quota.limit} daily · ${quota.bonus} bonus`;
  return `${quota.bonus} bonus queries remaining`;
}

export async function createCrescentQuotaPurchase(userId: number, asset: string) {
  const [purchase] = await db
    .insert(crescentQuotaPurchasesTable)
    .values({ userId, asset, credits: CRESCENT_TOPUP_CREDITS, amount: CRESCENT_TOPUP_PRICE.toFixed(2) })
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
