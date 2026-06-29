import { pgTable, serial, text, timestamp, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export type DbLogStatus = "success" | "failed" | "warning";

export const dbLogsTable = pgTable("db_logs", {
  id: serial("id").primaryKey(),
  status: text("status").notNull(), // "success" | "failed" | "warning"
  message: text("message").notNull(),
  details: text("details"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  notifiedAt: timestamp("notified_at"),
  notifiedTo: bigint("notified_to", { mode: "number" }),
});

export const insertDbLogSchema = createInsertSchema(dbLogsTable).omit({ id: true });
export type InsertDbLog = z.infer<typeof insertDbLogSchema>;
export type DbLog = typeof dbLogsTable.$inferSelect;
