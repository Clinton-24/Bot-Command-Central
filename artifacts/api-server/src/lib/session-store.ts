/**
 * Persistent Grammy session storage in Postgres.
 * Table bot_sessions: id TEXT PRIMARY KEY, data JSONB/TEXT, updated_at
 */
import type { StorageAdapter } from "grammy";
import { pool } from "@workspace/db";
import { logger } from "./logger";

export function createPgSessionStorage<T>(): StorageAdapter<T> {
  return {
    async read(key: string): Promise<T | undefined> {
      try {
        const { rows } = await pool.query<{ data: unknown }>(
          `SELECT data FROM bot_sessions WHERE id = $1`,
          [key],
        );
        const raw = rows[0]?.data;
        if (raw == null) return undefined;
        if (typeof raw === "string") {
          try {
            return JSON.parse(raw) as T;
          } catch {
            return undefined;
          }
        }
        return raw as T;
      } catch (err) {
        // Legacy column name "key" (older deploys)
        try {
          const { rows } = await pool.query<{ data: unknown }>(
            `SELECT data FROM bot_sessions WHERE key = $1`,
            [key],
          );
          const raw = rows[0]?.data;
          if (raw == null) return undefined;
          if (typeof raw === "string") {
            try {
              return JSON.parse(raw) as T;
            } catch {
              return undefined;
            }
          }
          return raw as T;
        } catch (err2) {
          logger.warn({ err: err2, key }, "session read failed");
          return undefined;
        }
      }
    },

    async write(key: string, value: T): Promise<void> {
      const payload = JSON.stringify(value);
      try {
        await pool.query(
          `INSERT INTO bot_sessions (id, data, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (id) DO UPDATE
             SET data = EXCLUDED.data, updated_at = NOW()`,
          [key, payload],
        );
        return;
      } catch {
        /* try text / legacy key column */
      }
      try {
        await pool.query(
          `INSERT INTO bot_sessions (id, data, updated_at)
           VALUES ($1, $2, NOW())
           ON CONFLICT (id) DO UPDATE
             SET data = EXCLUDED.data, updated_at = NOW()`,
          [key, payload],
        );
        return;
      } catch {
        /* legacy */
      }
      try {
        await pool.query(
          `INSERT INTO bot_sessions (key, data, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (key) DO UPDATE
             SET data = EXCLUDED.data, updated_at = NOW()`,
          [key, payload],
        );
      } catch (err) {
        logger.warn({ err, key }, "session write failed");
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await pool.query(`DELETE FROM bot_sessions WHERE id = $1`, [key]);
      } catch {
        try {
          await pool.query(`DELETE FROM bot_sessions WHERE key = $1`, [key]);
        } catch (err) {
          logger.warn({ err, key }, "session delete failed");
        }
      }
    },
  };
}
