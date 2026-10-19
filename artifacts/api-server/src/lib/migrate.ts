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
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL UNIQUE,
        balance INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS access (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL UNIQUE,
        username TEXT,
        first_name TEXT,
        tier TEXT NOT NULL DEFAULT 'free',
        is_approved BOOLEAN NOT NULL DEFAULT FALSE,
        is_pending BOOLEAN NOT NULL DEFAULT FALSE,
        request_message TEXT,
        approved_at TIMESTAMP,
        approved_by BIGINT,
        expires_at TIMESTAMP,
        blocked_at TIMESTAMP,
        blocked_reason TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMP NOT NULL DEFAULT NOW(),
        total_messages INTEGER NOT NULL DEFAULT 0,
        invite_code TEXT,
        invited_by BIGINT
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
      CREATE TABLE IF NOT EXISTS tier_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        tier TEXT NOT NULL,
        amount NUMERIC(10, 2),
        asset TEXT,
        invoice_id INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        starts_at TIMESTAMP,
        expires_at TIMESTAMP,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_settings (
        id SERIAL PRIMARY KEY,
        key TEXT NOT NULL UNIQUE,
        value TEXT,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_requests (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        product_id INTEGER,
        amount NUMERIC(10, 2),
        method TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        proof TEXT,
        admin_note TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        resolved_at TIMESTAMP
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_memory (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        task TEXT,
        embedding TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_reminders (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        message TEXT NOT NULL,
        due_at TIMESTAMP NOT NULL,
        sent BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_sessions (
        id TEXT PRIMARY KEY,
        data TEXT,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_activity_alerts (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        event TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_gmail_tokens (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL UNIQUE,
        access_token TEXT,
        refresh_token TEXT,
        expiry TIMESTAMP,
        email TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS feature_daily_usage (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        feature TEXT NOT NULL,
        day TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        UNIQUE(user_id, feature, day)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS bot_announcements (
        id SERIAL PRIMARY KEY,
        title TEXT,
        body TEXT NOT NULL,
        created_by BIGINT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
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
