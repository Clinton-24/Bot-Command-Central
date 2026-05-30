import { pgTable, serial, bigint, text, integer, timestamp } from "drizzle-orm/pg-core";

export const paymentSettingsTable = pgTable("payment_settings", {
  id: serial("id").primaryKey(),
  ownerId: bigint("owner_id", { mode: "number" }).notNull().unique(),
  bnbAddress: text("bnb_address"),
  trc20Address: text("trc20_address"),
  btcAddress: text("btc_address"),
  ethAddress: text("eth_address"),
  bnbXpub: text("bnb_xpub"),
  addressIndex: integer("address_index").notNull().default(0),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type PaymentSettings = typeof paymentSettingsTable.$inferSelect;
