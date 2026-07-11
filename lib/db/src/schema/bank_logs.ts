import { pgTable, serial, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";

export type BankLogStatus = "available" | "sold" | "checked" | "dead";

export const bankLogsTable = pgTable("bank_logs", {
  id: serial("id").primaryKey(),
  bankName: text("bank_name").notNull(),
  country: text("country").notNull(),
  accountType: text("account_type").notNull(), // checking, savings, business
  balance: text("balance"),
  loginUrl: text("login_url"),
  username: text("username_field"),
  password: text("password_field"),
  extras: text("extras"), // DOB, SSN, email, etc — stored as JSON string
  price: text("price"),
  status: text("status").notNull().default("available"),
  isSold: boolean("is_sold").notNull().default(false),
  addedAt: timestamp("added_at").notNull().defaultNow(),
  soldAt: timestamp("sold_at"),
  notes: text("notes"),
});

export type BankLog = typeof bankLogsTable.$inferSelect;
