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

    await client.query(`
      CREATE TABLE IF NOT EXISTS trading_access (
        user_id BIGINT PRIMARY KEY,
        opted_in BOOLEAN NOT NULL DEFAULT FALSE,
        approved BOOLEAN NOT NULL DEFAULT FALSE,
        insights_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        approved_by BIGINT,
        approved_at TIMESTAMP,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS trading_journals (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        pair TEXT NOT NULL DEFAULT 'XAUUSD',
        direction TEXT,
        entry_price TEXT,
        stop_loss TEXT,
        take_profit TEXT,
        result TEXT,
        r_multiple TEXT,
        notes TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS trading_journals_user_id_idx ON trading_journals (user_id);
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS trading_strategies (
        user_id BIGINT PRIMARY KEY,
        strategy_text TEXT NOT NULL DEFAULT '',
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS trading_user_alerts (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        hour INTEGER NOT NULL CHECK (hour >= 0 AND hour <= 23),
        minute INTEGER NOT NULL CHECK (minute >= 0 AND minute <= 59),
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS trading_user_alerts_user_idx ON trading_user_alerts (user_id);
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS trading_user_alerts_time_idx ON trading_user_alerts (hour, minute) WHERE enabled = TRUE;
    `);

    // Align tier_subscriptions + payment_settings with app schema (idempotent)
    await client.query(`
      ALTER TABLE tier_subscriptions ADD COLUMN IF NOT EXISTS coin TEXT;
      ALTER TABLE tier_subscriptions ADD COLUMN IF NOT EXISTS address TEXT;
      ALTER TABLE tier_subscriptions ADD COLUMN IF NOT EXISTS reference TEXT;
      ALTER TABLE tier_subscriptions ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMP;
      ALTER TABLE tier_subscriptions ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP;
      ALTER TABLE tier_subscriptions ADD COLUMN IF NOT EXISTS starts_at TIMESTAMP;
      ALTER TABLE tier_subscriptions ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP;
      ALTER TABLE tier_subscriptions ADD COLUMN IF NOT EXISTS invoice_id INTEGER;
      ALTER TABLE tier_subscriptions ADD COLUMN IF NOT EXISTS amount NUMERIC(10, 2);
      ALTER TABLE tier_subscriptions ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
    `);
    // Backfill from legacy "asset" column if present
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'tier_subscriptions' AND column_name = 'asset'
        ) THEN
          UPDATE tier_subscriptions SET coin = COALESCE(coin, asset) WHERE coin IS NULL;
        END IF;
      END $$;
    `);
    await client.query(`
      UPDATE tier_subscriptions SET coin = COALESCE(coin, 'UNKNOWN') WHERE coin IS NULL;
      UPDATE tier_subscriptions SET address = COALESCE(address, '') WHERE address IS NULL;
      UPDATE tier_subscriptions
        SET reference = COALESCE(reference, 'LEGACY-' || id::text)
        WHERE reference IS NULL;
    `);
    // Unique reference if missing (ignore if already exists)
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'tier_subscriptions_reference_key'
        ) THEN
          BEGIN
            ALTER TABLE tier_subscriptions ADD CONSTRAINT tier_subscriptions_reference_key UNIQUE (reference);
          EXCEPTION WHEN others THEN NULL;
          END;
        END IF;
      END $$;
    `);

    // payment_settings: app expects owner wallets, not key/value store
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'payment_settings' AND column_name = 'key'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'payment_settings' AND column_name = 'owner_id'
        ) THEN
          ALTER TABLE payment_settings RENAME TO payment_settings_kv_legacy;
        END IF;
      END $$;
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS payment_settings (
        id SERIAL PRIMARY KEY,
        owner_id BIGINT NOT NULL UNIQUE,
        bnb_address TEXT,
        trc20_address TEXT,
        btc_address TEXT,
        eth_address TEXT,
        bnb_xpub TEXT,
        address_index INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS owner_id BIGINT;
      ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS bnb_address TEXT;
      ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS trc20_address TEXT;
      ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS btc_address TEXT;
      ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS eth_address TEXT;
      ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS bnb_xpub TEXT;
      ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS address_index INTEGER DEFAULT 0;
      ALTER TABLE payment_settings ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
    `);

    logger.info("Migrations complete ✅");
  } catch (err) {
    logger.error({ err }, "Migration failed ❌");
    throw err;
  } finally {
    client.release();
  }
}
