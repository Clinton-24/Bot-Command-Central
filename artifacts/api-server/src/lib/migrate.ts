import { pool } from "@workspace/db";
import { logger } from "./logger";

/**
 * Runs on every startup — ensures all required tables exist.
 * Uses raw SQL CREATE TABLE IF NOT EXISTS so it's idempotent and safe.
 */
export async function runMigrations(): Promise<void> {
  const client = await pool.connect();
  try {
    logger.info("Running startup migrations...");

    await client.query(`
      CREATE TABLE IF NOT EXISTS db_logs (
        id SERIAL PRIMARY KEY,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        notified_at TIMESTAMP,
        notified_to BIGINT
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS external_db_logs (
        id SERIAL PRIMARY KEY,
        site TEXT NOT NULL,
        check_type TEXT NOT NULL,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        details TEXT,
        storage_used_mb INTEGER,
        storage_limit_mb INTEGER,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        notified_at TIMESTAMP,
        notified_to BIGINT
      );
    `);

    logger.info("Migrations complete ✅");
  } catch (err) {
    logger.error({ err }, "Migration failed ❌");
    throw err;
  } finally {
    client.release();
  }
}
