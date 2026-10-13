/**
 * Persistent Grammy session storage in Postgres.
 * Survives Render restarts — crescentMode and drafts stay intact.
 */
import type { StorageAdapter } from "grammy";
import { pool } from "@workspace/db";
import { logger } from "./logger";

export function createPgSessionStorage<T>(): StorageAdapter<T> {
  return {
    async read(key: string): Promise<T | undefined> {
      try {
        const { rows } = await pool.query<{ data: T }>(
          `SELECT data FROM bot_sessions WHERE key = $1`,
          [key],
        );
        return rows[0]?.data;
      } catch (err) {
        logger.warn({ err, key }, "session read failed");
        return undefined;
      }
    },

    async write(key: string, value: T): Promise<void> {
      try {
        await pool.query(
          `INSERT INTO bot_sessions (key, data, updated_at)
           VALUES ($1, $2::jsonb, NOW())
           ON CONFLICT (key) DO UPDATE
             SET data = EXCLUDED.data, updated_at = NOW()`,
          [key, JSON.stringify(value)],
        );
      } catch (err) {
        logger.warn({ err, key }, "session write failed");
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await pool.query(`DELETE FROM bot_sessions WHERE key = $1`, [key]);
      } catch (err) {
        logger.warn({ err, key }, "session delete failed");
      }
    },
  };
}
