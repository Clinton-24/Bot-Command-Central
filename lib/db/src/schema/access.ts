import { pgTable, serial, bigint, text, boolean, timestamp, integer } from "drizzle-orm/pg-core";

export type AccessTier = "free" | "premium" | "vip" | "blocked";

export const accessTable = pgTable("access", {
  id: serial("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull().unique(),
  username: text("username"),
  firstName: text("first_name"),
  tier: text("tier").notNull().default("free"), // free | premium | vip | blocked
  isApproved: boolean("is_approved").notNull().default(false),
  isPending: boolean("is_pending").notNull().default(false),
  requestMessage: text("request_message"),
  approvedAt: timestamp("approved_at"),
  approvedBy: bigint("approved_by", { mode: "number" }),
  expiresAt: timestamp("expires_at"),           // null = never expires
  blockedAt: timestamp("blocked_at"),
  blockedReason: text("blocked_reason"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
  totalMessages: integer("total_messages").notNull().default(0),
  inviteCode: text("invite_code"),               // which invite code they used
});

export type Access = typeof accessTable.$inferSelect;
