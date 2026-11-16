/**
 * User-owned trading strategy + session alerts (Premium / VIP / approved)
 */
import { InlineKeyboard } from "grammy";
import { pool } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { logger } from "../../lib/logger";
import { isOwner } from "../helpers";
import { getAccess } from "./access";

async function canAccessTrading(userId: number): Promise<{ ok: boolean }> {
  if (isOwner(userId)) return { ok: true };
  const access = await getAccess(userId);
  const tier = (access?.tier ?? "free").toLowerCase();
  if (access?.isApproved && (tier === "premium" || tier === "vip")) return { ok: true };
  try {
    const { rows } = await pool.query<{ approved: boolean }>(
      `SELECT approved FROM trading_access WHERE user_id = $1`,
      [userId],
    );
    if (rows[0]?.approved) return { ok: true };
  } catch { /* ignore */ }
  return { ok: false };
}

const STRATEGY_BLUEPRINT_PLAIN = `XAUUSD Volume Profile Strategy
Every session open (~01:00 Nairobi):
1. Open TradingView — 15m or 1H
2. Draw Fixed Range Volume Profile on the previous full day
3. Extend into today: POC · VAH · VAL

Only three setups:
• POC Bounce — price returns to POC and rejects → take the bounce
• Value Area Reversal — price leaves VAH/VAL then closes back inside → reverse
• Breakout — break VA, pullback, continuation → take continuation

Rules:
• Risk 0.5–1% per trade
• Tight stop loss
• Target at least 2R
• Max 2–3 losing trades per day → stop`;

function lockedKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💎 Premium plans", "access:plans")
    .row()
    .text("✅ Opt-in (request access)", "trading:optin")
    .row()
    .text("🏠 Main Menu", "menu:main");
}

async function saveUserStrategy(userId: number, text: string): Promise<void> {
  await pool.query(
    `INSERT INTO trading_strategies (user_id, strategy_text, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id) DO UPDATE SET strategy_text = EXCLUDED.strategy_text, updated_at = NOW()`,
    [userId, text.slice(0, 8000)],
  );
}

async function getUserStrategy(userId: number): Promise<string | null> {
  try {
    const { rows } = await pool.query<{ strategy_text: string }>(
      `SELECT strategy_text FROM trading_strategies WHERE user_id = $1`,
      [userId],
    );
    return rows[0]?.strategy_text ?? null;
  } catch {
    return null;
  }
}

async function listUserAlerts(userId: number) {
  const { rows } = await pool.query(
    `SELECT id, hour, minute, title, body, enabled FROM trading_user_alerts
     WHERE user_id = $1 ORDER BY hour, minute, id`,
    [userId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    hour: Number(r.hour),
    minute: Number(r.minute),
    title: String(r.title),
    body: String(r.body ?? ""),
    enabled: !!r.enabled,
  }));
}

async function addUserAlert(
  userId: number,
  hour: number,
  minute: number,
  title: string,
  body: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO trading_user_alerts (user_id, hour, minute, title, body, enabled)
     VALUES ($1, $2, $3, $4, $5, TRUE)`,
    [userId, hour, minute, title, body],
  );
}

async function clearUserAlerts(userId: number): Promise<number> {
  const { rowCount } = await pool.query(`DELETE FROM trading_user_alerts WHERE user_id = $1`, [userId]);
  return rowCount ?? 0;
}

async function deleteUserAlert(userId: number, id: number): Promise<void> {
  await pool.query(`DELETE FROM trading_user_alerts WHERE user_id = $1 AND id = $2`, [userId, id]);
}

async function seedDefaultXauAlerts(userId: number): Promise<number> {
  const defaults = [
    { hour: 1, minute: 0, title: "XAUUSD open — draw FRVP", body: "Session open ~01:00 Nairobi. Draw Fixed Range VP on the previous full day. Extend POC / VAH / VAL into today." },
    { hour: 9, minute: 0, title: "XAUUSD morning prep", body: "Review levels. Only take clear POC bounce, VA reversal, or breakout + pullback. Risk 0.5–1%." },
    { hour: 11, minute: 0, title: "London open — XAUUSD", body: "London liquidity. Watch for reactions at POC / VAH / VAL." },
    { hour: 16, minute: 30, title: "NY open / overlap — XAUUSD", body: "Highest volatility window. Stick to plan — max 2–3 losers then stop." },
    { hour: 19, minute: 30, title: "London close check — XAUUSD", body: "Reduce risk into close. Trail or flatten weak positions." },
    { hour: 22, minute: 0, title: "End-of-day review — XAUUSD", body: "Journal trades. Note R and rule breaks. Prep FRVP for next session." },
  ];
  for (const d of defaults) {
    await addUserAlert(userId, d.hour, d.minute, d.title, d.body);
  }
  return defaults.length;
}

export async function processStrategyInput(ctx: BotContext, text: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const gate = await canAccessTrading(userId);
  if (!gate.ok) {
    await ctx.reply("Trading desk locked.", { reply_markup: lockedKeyboard() });
    return;
  }
  await saveUserStrategy(userId, text.trim());
  await ctx.reply("✅ Strategy saved.\n\n/sessions · Trading → Strategy");
}

export async function openUserSessions(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const gate = await canAccessTrading(userId);
  if (!gate.ok) {
    await ctx.reply(
      "⏰ *Session alerts* need Premium / VIP or admin trading approval.\n\n" +
        "You set *your own* times and strategy — not the owner's private pings.",
      { parse_mode: "Markdown", reply_markup: lockedKeyboard() },
    );
    return;
  }

  const strategy = await getUserStrategy(userId);
  const alerts = await listUserAlerts(userId);
  let text =
    `⏰ *YOUR SESSION ALERTS* (Nairobi)\n━━━━━━━━━━━━━━━━━━\n\n` +
    `These are *your* alerts — edit anytime.\n\n`;

  if (strategy) {
    text += `📘 *Strategy (saved)*\n${strategy.slice(0, 500)}${strategy.length > 500 ? "…" : ""}\n\n`;
  } else {
    text += `📘 No strategy saved yet — /strategy or Use VP template.\n\n`;
  }

  if (alerts.length === 0) {
    text +=
      `No alerts yet.\n` +
      `• /session_add 09:00 Morning prep | Draw FRVP\n` +
      `• Or seed the default XAU schedule below.\n`;
  } else {
    text += alerts
      .map(
        (a) =>
          `• #${a.id} ${String(a.hour).padStart(2, "0")}:${String(a.minute).padStart(2, "0")} — ${a.title}` +
          (a.body ? `\n   ${a.body.slice(0, 80)}` : ""),
      )
      .join("\n\n");
    text += `\n\nDelete: buttons below · Clear all: /session_clear`;
  }

  const kb = new InlineKeyboard()
    .text("📋 Use VP template", "trading:strategy_template")
    .text("➕ Seed XAU times", "trading:seed_xau_alerts")
    .row()
    .text("📘 Set strategy", "trading:strategy_edit")
    .text("🏠 Menu", "menu:main");

  for (const a of alerts.slice(0, 8)) {
    kb.row().text(
      `🗑 ${String(a.hour).padStart(2, "0")}:${String(a.minute).padStart(2, "0")} ${a.title.slice(0, 18)}`,
      `trading:alert_del:${a.id}`,
    );
  }

  await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb }).catch(async () => {
    await ctx.reply(text.replace(/\*/g, ""), { reply_markup: kb });
  });
}

export function registerTradingSessionHandlers(bot: MyBot): void {
  bot.command("sessions", async (ctx) => {
    if (!ctx.from) return;
    await openUserSessions(ctx);
  });

  bot.command("strategy", async (ctx) => {
    if (!ctx.from) return;
    const gate = await canAccessTrading(ctx.from.id);
    if (!gate.ok) {
      await ctx.reply("Trading desk needs Premium / VIP or admin approval.", {
        reply_markup: lockedKeyboard(),
      });
      return;
    }
    const body = (ctx.match ?? "").toString().trim();
    if (!body) {
      ctx.session.pendingAction = "trading:set_strategy";
      ctx.session.crescentMode = false;
      await ctx.reply(
        "📘 Send your strategy text in the next message (or `/strategy your text`).",
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("📋 Use VP template", "trading:strategy_template")
            .row()
            .text("⏰ My alerts", "trading:sessions"),
        },
      );
      return;
    }
    await saveUserStrategy(ctx.from.id, body);
    await ctx.reply("✅ Strategy saved.\n\n/sessions");
  });

  bot.command("session_add", async (ctx) => {
    if (!ctx.from) return;
    const gate = await canAccessTrading(ctx.from.id);
    if (!gate.ok) {
      await ctx.reply("Trading desk needs Premium / VIP or admin approval.", {
        reply_markup: lockedKeyboard(),
      });
      return;
    }
    const raw = (ctx.match ?? "").toString().trim();
    const m = raw.match(/^(\d{1,2}):(\d{2})\s+(.+)$/s);
    if (!m) {
      await ctx.reply(
        "Usage:\n`/session_add HH:MM Title | optional body`\n\n" +
          "Example:\n`/session_add 09:00 Morning prep | Draw FRVP on prior day`",
        { parse_mode: "Markdown" },
      );
      return;
    }
    const hour = parseInt(m[1]!, 10);
    const minute = parseInt(m[2]!, 10);
    if (hour > 23 || minute > 59) {
      await ctx.reply("Invalid time. Use 00:00–23:59 (Nairobi).");
      return;
    }
    const rest = m[3]!.trim();
    const pipe = rest.indexOf("|");
    const title = (pipe >= 0 ? rest.slice(0, pipe) : rest).trim().slice(0, 120);
    const body = (pipe >= 0 ? rest.slice(pipe + 1) : "").trim().slice(0, 1500);
    if (!title) {
      await ctx.reply("Title required.");
      return;
    }
    await addUserAlert(ctx.from.id, hour, minute, title, body);
    await ctx.reply(
      `✅ Alert set\n🕐 ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} Nairobi — ${title}`,
    );
  });

  bot.command("session_clear", async (ctx) => {
    if (!ctx.from) return;
    const gate = await canAccessTrading(ctx.from.id);
    if (!gate.ok) return;
    const n = await clearUserAlerts(ctx.from.id);
    await ctx.reply(`🗑️ Cleared ${n} session alert(s).`);
  });

  bot.callbackQuery("trading:sessions", async (ctx) => {
    await ctx.answerCallbackQuery();
    await openUserSessions(ctx);
  });

  bot.callbackQuery("trading:strategy_template", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const gate = await canAccessTrading(ctx.from.id);
    if (!gate.ok) return;
    await saveUserStrategy(ctx.from.id, STRATEGY_BLUEPRINT_PLAIN);
    await ctx.reply("✅ Default XAU Volume Profile strategy saved as yours.\nEdit with /strategy");
  });

  bot.callbackQuery("trading:strategy_edit", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    ctx.session.pendingAction = "trading:set_strategy";
    ctx.session.crescentMode = false;
    await ctx.reply("📘 Send your full strategy text in the next message.");
  });

  bot.callbackQuery("trading:seed_xau_alerts", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const gate = await canAccessTrading(ctx.from.id);
    if (!gate.ok) return;
    const n = await seedDefaultXauAlerts(ctx.from.id);
    await ctx.reply(`✅ Added ${n} default XAU session alerts (Nairobi).`);
    await openUserSessions(ctx);
  });

  bot.callbackQuery(/^trading:alert_del:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const id = parseInt(ctx.match![1]!, 10);
    await deleteUserAlert(ctx.from.id, id);
    await ctx.reply("🗑️ Alert removed.");
    await openUserSessions(ctx);
  });
}

/** Fires each user's session alerts at their chosen Nairobi times. */
export function startTradingAlertScheduler(bot: MyBot): void {
  const fired = new Set<string>();

  setInterval(async () => {
    try {
      const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Africa/Nairobi",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).formatToParts(new Date());
      const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
      const hour = parseInt(get("hour"), 10);
      const minute = parseInt(get("minute"), 10);
      const dayKey = `${get("year")}-${get("month")}-${get("day")}`;

      for (const k of [...fired]) {
        if (!k.startsWith(dayKey)) fired.delete(k);
      }

      const { rows } = await pool.query<{
        id: number;
        user_id: string;
        hour: number;
        minute: number;
        title: string;
        body: string;
      }>(
        `SELECT id, user_id, hour, minute, title, body FROM trading_user_alerts
         WHERE enabled = TRUE AND hour = $1 AND minute = $2`,
        [hour, minute],
      );

      for (const r of rows) {
        const key = `${dayKey}:${r.user_id}:${r.id}`;
        if (fired.has(key)) continue;
        fired.add(key);
        const when = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
        const msg =
          `🥇 ${r.title}\n━━━━━━━━━━━━━━━━━━\n${when} (Nairobi)\n\n` +
          (r.body ? `${r.body}\n\n` : "") +
          `/sessions · /journal · /strategy`;
        try {
          await bot.api.sendMessage(Number(r.user_id), msg);
        } catch (err) {
          logger.warn({ err, userId: r.user_id }, "user session alert send failed");
        }
      }
    } catch (err) {
      logger.error({ err }, "trading alert scheduler tick failed");
    }
  }, 30 * 1000);

  logger.info("User trading session alert scheduler started (30s poll, Nairobi)");
}
