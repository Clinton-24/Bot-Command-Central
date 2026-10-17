/**
 * Order fulfillment — stock deduction + revenue helpers.
 *
 * Stock rules (products):
 *  - stock 0 or >= 9999  → Unlimited (never decremented)
 *  - stock 1..9998       → finite units; each confirmed sale subtracts quantity
 *  - when finite stock hits 0 → product is deactivated (sold out)
 */
import { eq } from "drizzle-orm";
import { db, productsTable, ordersTable, paymentRequestsTable } from "@workspace/db";
import { logger } from "./logger";

export function isUnlimitedStock(stock: string | number | null | undefined): boolean {
  const n = Number(stock);
  if (!Number.isFinite(n)) return true;
  return n === 0 || n >= 9999;
}

export function stockLabel(stock: string | number | null | undefined, isActive = true): string {
  const n = Number(stock);
  if (!isActive && (!Number.isFinite(n) || n <= 0)) return "Sold out";
  if (!Number.isFinite(n) || n === 0 || n >= 9999) return "Unlimited";
  if (n < 0) return "Sold out";
  return String(Math.floor(n));
}

/** After order confirmed: deduct finite product stock. */
export async function deductProductStock(
  productId: number,
  quantity = 1,
): Promise<{ unlimited: boolean; remaining: number; deactivated: boolean }> {
  if (!productId || productId <= 0) {
    return { unlimited: true, remaining: 0, deactivated: false };
  }
  try {
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!p) return { unlimited: true, remaining: 0, deactivated: false };

    if (isUnlimitedStock(p.stock)) {
      return { unlimited: true, remaining: 0, deactivated: false };
    }

    const current = Math.max(0, Math.floor(Number(p.stock)));
    const qty = Math.max(1, quantity);
    const remaining = Math.max(0, current - qty);
    const deactivated = remaining <= 0;

    await db
      .update(productsTable)
      .set({
        stock: String(remaining),
        isActive: deactivated ? false : p.isActive,
        updatedAt: new Date(),
      })
      .where(eq(productsTable.id, productId));

    logger.info(
      { productId, from: current, to: remaining, deactivated },
      "product stock deducted after sale",
    );
    return { unlimited: false, remaining, deactivated };
  } catch (err) {
    logger.error({ err, productId }, "deductProductStock failed");
    return { unlimited: false, remaining: -1, deactivated: false };
  }
}

/** Sum of confirmed payment amounts. */
export async function getConfirmedRevenue(): Promise<{
  revenue: number;
  confirmedOrders: number;
  pendingOrders: number;
}> {
  const orders = await db.select().from(ordersTable);
  const confirmed = orders.filter((o) => o.status === "confirmed");
  const pending = orders.filter((o) => o.status === "pending" || o.status === "claimed");
  const payments = await db.select().from(paymentRequestsTable);
  const revenue = payments
    .filter((p) => p.status === "confirmed")
    .reduce((sum, p) => sum + (parseFloat(String(p.amount)) || 0), 0);
  return { revenue, confirmedOrders: confirmed.length, pendingOrders: pending.length };
}
