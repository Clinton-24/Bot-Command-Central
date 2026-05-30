import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

export const paymentRequestsTable = pgTable("payment_requests", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id").notNull().unique(),
  coin: text("coin").notNull(),
  address: text("address").notNull(),
  amount: text("amount").notNull(),
  reference: text("reference").notNull(),
  status: text("status").notNull().default("pending"),
  claimedAt: timestamp("claimed_at"),
  confirmedAt: timestamp("confirmed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type PaymentRequest = typeof paymentRequestsTable.$inferSelect;
