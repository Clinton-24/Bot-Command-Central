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

    await client.query(`
      CREATE TABLE IF NOT EXISTS crescent_quota_purchases (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        credits INTEGER NOT NULL DEFAULT 20,
        amount NUMERIC(10, 2) NOT NULL DEFAULT 2.00,
        asset TEXT NOT NULL,
        invoice_id INTEGER UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        confirmed_at TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS crescent_quota_credits (
        user_id BIGINT PRIMARY KEY,
        credits INTEGER NOT NULL DEFAULT 0,
        daily_date TEXT,
        daily_used INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      ALTER TABLE crescent_quota_credits
        ADD COLUMN IF NOT EXISTS daily_date TEXT,
        ADD COLUMN IF NOT EXISTS daily_used INTEGER NOT NULL DEFAULT 0;
    `);

    logger.info("Migrations complete ✅");
  } catch (err) {
    logger.error({ err }, "Migration failed ❌");
    throw err;
  } finally {
    client.release();
  }
}
