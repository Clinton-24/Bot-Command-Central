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
        paid_at TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS crescent_quota_credits (
        user_id BIGINT PRIMARY KEY,
        credits INTEGER NOT NULL DEFAULT 0,
        daily_used INTEGER NOT NULL DEFAULT 0,
        daily_date TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS invite_codes (
        id SERIAL PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        tier TEXT NOT NULL DEFAULT 'free',
        max_uses INTEGER NOT NULL DEFAULT 1,
        used_count INTEGER NOT NULL DEFAULT 0,
        created_by BIGINT NOT NULL,
        expires_at TIMESTAMP,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        note TEXT
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS group_messages (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        user_id BIGINT NOT NULL,
        username TEXT,
        first_name TEXT,
        message TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bank_logs (
        id SERIAL PRIMARY KEY,
        bank_name TEXT NOT NULL,
        country TEXT NOT NULL,
        account_type TEXT NOT NULL,
        balance TEXT,
        login_url TEXT,
        username_field TEXT,
        password_field TEXT,
        extras TEXT,
        price TEXT,
        status TEXT NOT NULL DEFAULT 'available',
        is_sold BOOLEAN NOT NULL DEFAULT FALSE,
        added_at TIMESTAMP NOT NULL DEFAULT NOW(),
        sold_at TIMESTAMP,
        notes TEXT
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_activity_alerts (
        user_id BIGINT PRIMARY KEY,
        last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
        last_alert_at TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_gmail_tokens (
        user_id BIGINT PRIMARY KEY,
        refresh_token TEXT NOT NULL,
        email TEXT,
        connected_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS feature_daily_usage (
        user_id BIGINT NOT NULL,
        feature TEXT NOT NULL,
        day TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, feature, day)
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
