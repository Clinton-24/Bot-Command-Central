import { pgTable, bigint, boolean, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const groupSettingsTable = pgTable("group_settings", {
  chatId: bigint("chat_id", { mode: "number" }).primaryKey(),
  linksEnabled: boolean("links_enabled").notNull().default(true),
  forwardsEnabled: boolean("forwards_enabled").notNull().default(true),
  captchaEnabled: boolean("captcha_enabled").notNull().default(false),
  antispamEnabled: boolean("antispam_enabled").notNull().default(false),
  welcomeMessage: text("welcome_message"),
  logChannelId: bigint("log_channel_id", { mode: "number" }),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertGroupSettingsSchema = createInsertSchema(groupSettingsTable);
export type InsertGroupSettings = z.infer<typeof insertGroupSettingsSchema>;
export type GroupSettings = typeof groupSettingsTable.$inferSelect;
