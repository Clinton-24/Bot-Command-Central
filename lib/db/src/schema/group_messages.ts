import { pgTable, serial, bigint, text, timestamp } from "drizzle-orm/pg-core";

export const groupMessagesTable = pgTable("group_messages", {
  id: serial("id").primaryKey(),
  chatId: bigint("chat_id", { mode: "number" }).notNull(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  username: text("username"),
  firstName: text("first_name"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type GroupMessage = typeof groupMessagesTable.$inferSelect;
