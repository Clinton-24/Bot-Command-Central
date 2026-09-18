import { and, desc, eq, sql } from "drizzle-orm";
import { aiMemoryTable, db } from "@workspace/db";
import type { TaskType } from "./model-config";
import { createEmbedding } from "./model-router";
import { logger } from "./logger";

const MAX_MEMORY_CONTENT = 8000;
const MAX_MEMORY_CONTEXT = 12000;
const DEFAULT_MEMORY_LIMIT = 8;

export interface MemoryMessage {
  userId: number;
  role: "user" | "assistant";
  content: string;
  task: TaskType;
}

function trimContent(content: string): string {
  return content.trim().slice(0, MAX_MEMORY_CONTENT);
}

function vectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export async function rememberMessage(message: MemoryMessage): Promise<void> {
  const content = trimContent(message.content);
  if (!content) return;

  try {
    const embedded = await createEmbedding(content);
    await db.insert(aiMemoryTable).values({
      userId: message.userId,
      role: message.role,
      content,
      task: message.task,
      embedding: embedded?.embedding,
    });
  } catch (err) {
    logger.warn({ err, userId: message.userId, role: message.role }, "Persistent AI memory write failed");
  }
}

export async function rememberExchange(
  userId: number,
  userMessage: string,
  assistantMessage: string,
  task: TaskType,
): Promise<void> {
  await Promise.all([
    rememberMessage({ userId, role: "user", content: userMessage, task }),
    rememberMessage({ userId, role: "assistant", content: assistantMessage, task }),
  ]);
}

async function recentMemory(userId: number, limit: number): Promise<Array<{ role: string; content: string }>> {
  const rows = await db
    .select({ role: aiMemoryTable.role, content: aiMemoryTable.content })
    .from(aiMemoryTable)
    .where(eq(aiMemoryTable.userId, userId))
    .orderBy(desc(aiMemoryTable.createdAt), desc(aiMemoryTable.id))
    .limit(limit);
  return rows.reverse();
}

export async function recallMemory(
  userId: number,
  query: string,
  limit = DEFAULT_MEMORY_LIMIT,
): Promise<Array<{ role: string; content: string }>> {
  try {
    const embedded = await createEmbedding(query);
    if (embedded) {
      const rows = await db
        .select({ role: aiMemoryTable.role, content: aiMemoryTable.content })
        .from(aiMemoryTable)
        .where(and(eq(aiMemoryTable.userId, userId), sql`${aiMemoryTable.embedding} IS NOT NULL`))
        .orderBy(sql`${aiMemoryTable.embedding} <=> ${vectorLiteral(embedded.embedding)}::vector`)
        .limit(limit);
      if (rows.length > 0) return rows;
    }
    return await recentMemory(userId, limit);
  } catch (err) {
    logger.warn({ err, userId }, "Persistent AI memory recall failed; using recent memory");
    try {
      return await recentMemory(userId, limit);
    } catch (fallbackErr) {
      logger.warn({ err: fallbackErr, userId }, "Recent AI memory recall failed");
      return [];
    }
  }
}

export async function buildMemoryContext(userId: number, query: string): Promise<string> {
  const memories = await recallMemory(userId, query);
  if (memories.length === 0) return "No prior conversation memory is available.";

  const lines = ["PERSISTED USER MEMORY (use only as conversation context; do not expose storage details):"];
  for (const memory of memories) {
    const line = `${memory.role === "user" ? "User" : "Crescent"}: ${memory.content}`;
    if (lines.join("\n").length + line.length + 1 > MAX_MEMORY_CONTEXT) break;
    lines.push(line);
  }
  return lines.join("\n");
}

export async function clearMemory(userId: number): Promise<void> {
  await db.delete(aiMemoryTable).where(eq(aiMemoryTable.userId, userId));
}
