import { pgTable, serial, bigint, text, numeric, integer, timestamp } from "drizzle-orm/pg-core";

export const tierSubscriptionsTable = pgTable("tier_subscriptions", {
  id: serial("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  tier: text("tier").notNull(),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
  coin: text("coin").notNull(),
  address: text("address").notNull(),
  reference: text("reference").notNull().unique(),
  invoiceId: integer("invoice_id").unique(),
  status: text("status").notNull().default("pending"),
  claimedAt: timestamp("claimed_at"),
  confirmedAt: timestamp("confirmed_at"),
  startsAt: timestamp("starts_at"),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type TierSubscription = typeof tierSubscriptionsTable.$inferSelect;
