import { pgTable, serial, text, integer, bigint, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const externalDbLogsTable = pgTable("external_db_logs", {
  id: serial("id").primaryKey(),
  site: text("site").notNull(),
  checkType: text("check_type").notNull(), // backup | connection | storage | integrity
  status: text("status").notNull(), // success | failed | warning
  message: text("message").notNull(),
  details: text("details"),
  storageUsedMb: integer("storage_used_mb"),
  storageLimitMb: integer("storage_limit_mb"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  notifiedAt: timestamp("notified_at"),
  notifiedTo: bigint("notified_to", { mode: "number" }),
});

export const insertExternalDbLogSchema = createInsertSchema(externalDbLogsTable).omit({ id: true });
export type InsertExternalDbLog = z.infer<typeof insertExternalDbLogSchema>;
export type ExternalDbLog = typeof externalDbLogsTable.$inferSelect;
