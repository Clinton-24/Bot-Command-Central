import { pgTable, serial, text, bigint, boolean, integer, timestamp } from "drizzle-orm/pg-core";

export const inviteCodesTable = pgTable("invite_codes", {
  id: serial("id").primaryKey(),
  code: text("code").notNull().unique(),
  tier: text("tier").notNull().default("free"), // what tier the invite grants
  maxUses: integer("max_uses").notNull().default(1),
  usedCount: integer("used_count").notNull().default(0),
  createdBy: bigint("created_by", { mode: "number" }).notNull(),
  expiresAt: timestamp("expires_at"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  note: text("note"),
});

export type InviteCode = typeof inviteCodesTable.$inferSelect;
