import { bigint, integer, numeric, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const crescentQuotaPurchasesTable = pgTable("crescent_quota_purchases", {
  id: serial("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  credits: integer("credits").notNull().default(20),
  amount: numeric("amount", { precision: 10, scale: 2 }).notNull().default("2.00"),
  asset: text("asset").notNull(),
  invoiceId: integer("invoice_id").unique(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  confirmedAt: timestamp("confirmed_at"),
});

export const crescentQuotaCreditsTable = pgTable("crescent_quota_credits", {
  userId: bigint("user_id", { mode: "number" }).primaryKey(),
  credits: integer("credits").notNull().default(0),
  dailyDate: text("daily_date"),
  dailyUsed: integer("daily_used").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type CrescentQuotaPurchase = typeof crescentQuotaPurchasesTable.$inferSelect;
export type CrescentQuotaCredits = typeof crescentQuotaCreditsTable.$inferSelect;
