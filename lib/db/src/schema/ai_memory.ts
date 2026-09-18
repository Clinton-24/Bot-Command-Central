import { bigint, customType, index, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector(1536)",
  toDriver: (value) => `[${value.join(",")}]`,
  fromDriver: (value) => {
    if (Array.isArray(value)) return value.map(Number);
    const raw = String(value).replace(/^\[|\]$/g, "");
    return raw ? raw.split(",").map(Number) : [];
  },
});

export const aiMemoryTable = pgTable(
  "ai_memory",
  {
    id: serial("id").primaryKey(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    task: text("task").notNull().default("chat"),
    embedding: vector("embedding"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    userCreatedAtIdx: index("ai_memory_user_created_at_idx").on(table.userId, table.createdAt),
  }),
);

export type AiMemory = typeof aiMemoryTable.$inferSelect;
export type NewAiMemory = typeof aiMemoryTable.$inferInsert;
