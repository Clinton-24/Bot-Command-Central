/**
 * Trading section — journals + strategy insights (Premium / VIP / admin-approved)
 */
import { InlineKeyboard } from "grammy";
import { pool } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { getAccess, TIER_LABEL, TIER_EMOJI } from "./access";
import { logger } from "../../lib/logger";

const STRATEGY_BLUEPRINT = `🥇 *XAUUSD Volume Profile Strategy*
━━━━━━━━━━━━━━━━━━
*Every session open (~01:00 Nairobi):*
1. Open TradingView — 15m or 1H
2. Draw *Fixed Range Volume Profile* on the *previous full day*
   (Monday → use Friday; weekends closed)
3. Extend into today: *POC · VAH · VAL*

*Only three setups:*
• *POC Bounce* — price returns to POC and rejects → take the bounce
• *Value Area Reversal* — price leaves VAH/VAL then closes back inside → reverse
• *Breakout* — break VA, pullback, continuation → take continuation

*Rules:*
• Risk 0.5–1% per trade
• Tight stop loss
• Target at least 2R
• Max 2–3 losing trades per day → stop

Keep it simple. Only take the clear ones.`;

export async function canAccessTrading(userId: number): Promise<{
  ok: boolean;
  reason: string;
  optedIn: boolean;
  approved: boolean;
  tier: string;
}> {
  if (isOwner(userId)) {
    return { ok: true, reason: "owner", optedIn: true, approved: true, tier: "owner" };
  }
  const access = await getAccess(userId);
  const tier = (access?.tier ?? "free").toLowerCase();
  const premium =
    !!access?.isApproved && (tier === "premium" || tier === "vip");

  let optedIn = false;
  let approved = false;
  try {
    const { rows } = await pool.query<{
      opted_in: boolean;
      approved: boolean;
    }>(`SELECT opted_in, approved FROM trading_access WHERE user_id = $1`, [userId]);
    if (rows[0]) {
      optedIn = !!rows[0].opted_in;
      approved = !!rows[0].approved;
    }
  } catch (err) {
    logger.warn({ err }, "trading_access read failed");
  }

  if (premium || approved) {
    return { ok: true, reason: premium ? "premium" : "admin", optedIn, approved: approved || premium, tier };
  }
  return {
    ok: false,
    reason: "need_premium_or_approval",
    optedIn,
    approved,
    tier,
  };
}

function lockedKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💎 Premium plans", "access:plans")
    .row()
    .text("✅ Opt-in (request access)", "trading:optin")
    .row()
    .text("🏠 Main Menu", "menu:main");
}

function tradingKeyboard(opts: { owner?: boolean }): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("📘 Strategy", "trading:strategy")
    .text("📝 New journal", "trading:new_journal")
    .row()
    .text("📚 My journals", "trading:list")
    .text("🔔 Insights", "trading:insights")
    .row();
  if (opts.owner) {
    kb.text("👥 Approve traders", "trading:admin_list").row();
  }
  kb.text("🏠 Main Menu", "menu:main");
  return kb;
}

export async function openTradingPanel(ctx: BotContext): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const gate = await canAccessTrading(userId);

  if (!gate.ok) {
    const status = gate.optedIn
      ? "Opt-in received — waiting for admin approval."
      : "Not opted in yet.";
    await ctx.reply(
      `📈 *TRADING DESK*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Journals + XAUUSD Volume Profile training.\n\n` +
        `🔒 Requires *Premium / VIP* or *admin approval*.\n` +
        `Your tier: ${TIER_EMOJI[gate.tier] ?? ""} ${TIER_LABEL[gate.tier] ?? gate.tier}\n` +
        `${status}\n\n` +
        `• Buy Premium/VIP, or\n` +
        `• Opt-in and wait for the owner to approve.`,
      { parse_mode: "Markdown", reply_markup: lockedKeyboard() },
    );
    return;
  }

  await ctx.reply(
    `📈 *TRADING DESK*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `Access: ${gate.reason === "owner" ? "Owner" : gate.reason === "premium" ? "Premium/VIP" : "Admin approved"}\n` +
      `Pair focus: XAUUSD · Session open ~*01:00 Nairobi*\n\n` +
      `• Strategy blueprint\n` +
      `• Trade journal\n` +
      `• Insights training (same playbook)`,
    {
      parse_mode: "Markdown",
      reply_markup: tradingKeyboard({ owner: isOwner(userId) }),
    },
  );
}

export async function processJournalInput(ctx: BotContext, text: string): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const gate = await canAccessTrading(userId);
  if (!gate.ok) {
    await ctx.reply("🔒 Trading desk locked. Premium/VIP or admin approval required.");
    return;
  }

  const parts = text.split("|").map((p) => p.trim());
  if (parts.length < 3) {
    await ctx.reply(
      "Format:\n`PAIR | DIR | ENTRY | SL | TP | RESULT | R | NOTES`\n\n" +
        "Example:\n`XAUUSD | long | 2650.5 | 2648 | 2656 | win | 2.1 | POC bounce`",
      { parse_mode: "Markdown" },
    );
    return;
  }

  const [pair, direction, entry, sl, tp, result, rMult, ...noteParts] = parts;
  const notes = noteParts.join(" | ") || null;

  try {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO trading_journals
        (user_id, pair, direction, entry_price, stop_loss, take_profit, result, r_multiple, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        userId,
        (pair || "XAUUSD").toUpperCase(),
        direction?.toLowerCase() || null,
        entry || null,
        sl || null,
        tp || null,
        result?.toLowerCase() || null,
        rMult || null,
        notes,
      ],
    );
    await ctx.reply(
      `✅ Journal #${rows[0]?.id} saved\n` +
        `${(pair || "XAUUSD").toUpperCase()} ${direction ?? ""} @ ${entry ?? "—"}\n` +
        `Result: ${result ?? "open"} · R: ${rMult ?? "—"}`,
      { reply_markup: tradingKeyboard({ owner: isOwner(userId) }) },
    );
  } catch (err) {
    logger.error({ err }, "journal insert failed");
    await ctx.reply(`❌ Could not save journal: ${err instanceof Error ? err.message : "error"}`);
  }
}

async function listJournals(ctx: BotContext): Promise<void> {
  const userId = ctx.from!.id;
  const { rows } = await pool.query<{
    id: number;
    pair: string;
    direction: string | null;
    entry_price: string | null;
    result: string | null;
    r_multiple: string | null;
    notes: string | null;
    created_at: Date;
  }>(
    `SELECT id, pair, direction, entry_price, result, r_multiple, notes, created_at
     FROM trading_journals WHERE user_id = $1
     ORDER BY created_at DESC LIMIT 15`,
    [userId],
  );
  if (rows.length === 0) {
    await ctx.reply("No journal entries yet. Tap *New journal*.", {
      parse_mode: "Markdown",
      reply_markup: tradingKeyboard({ owner: isOwner(userId) }),
    });
    return;
  }
  const lines = rows.map((j) => {
    const when = new Date(j.created_at).toLocaleString("en-KE", {
      timeZone: "Africa/Nairobi",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    return (
      `#${j.id} ${j.pair} ${j.direction ?? ""} @ ${j.entry_price ?? "—"} · ` +
      `${j.result ?? "open"} R:${j.r_multiple ?? "—"} · ${when}` +
      (j.notes ? `\n   ${j.notes.slice(0, 80)}` : "")
    );
  });
  await ctx.reply(`📚 *Your journals* (latest 15)\n━━━━━━━━━━━━━━━━━━\n` + lines.join("\n"), {
    parse_mode: "Markdown",
    reply_markup: tradingKeyboard({ owner: isOwner(userId) }),
  });
}

async function optIn(ctx: BotContext, bot: MyBot): Promise<void> {
  const userId = ctx.from!.id;
  const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ") || "User";
  const username = ctx.from?.username ? `@${ctx.from.username}` : "—";

  await pool.query(
    `INSERT INTO trading_access (user_id, opted_in, updated_at)
     VALUES ($1, TRUE, NOW())
     ON CONFLICT (user_id) DO UPDATE SET opted_in = TRUE, updated_at = NOW()`,
    [userId],
  );

  await ctx.reply(
    `✅ Opt-in recorded.\n\n` +
      `If you already have Premium/VIP you can open *Trading* now.\n` +
      `Otherwise the owner will review and approve access.`,
    { reply_markup: lockedKeyboard() },
  );

  const ownerId = parseInt(process.env["BOT_OWNER_ID"] ?? "0", 10);
  if (ownerId) {
    try {
      await bot.api.sendMessage(
        ownerId,
        `📈 Trading opt-in\n${name} (${username})\nID: \`${userId}\`\n\nApprove?`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("✅ Approve", `trading:approve:${userId}`)
            .text("❌ Deny", `trading:deny:${userId}`),
        },
      );
    } catch (err) {
      logger.warn({ err }, "notify owner trading opt-in failed");
    }
  }
}

export function registerTradingHandlers(bot: MyBot): void {
  bot.command("trading", async (ctx) => {
    await openTradingPanel(ctx);
  });

  bot.command("journal", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const gate = await canAccessTrading(userId);
    if (!gate.ok) {
      await openTradingPanel(ctx);
      return;
    }
    const rest = ctx.match?.trim();
    if (rest) {
      await processJournalInput(ctx, rest);
      return;
    }
    ctx.session.pendingAction = "trading:journal";
    ctx.session.crescentMode = false;
    await ctx.reply(
      `📝 *New trade journal*\nSend one line:\n` +
        `\`PAIR | DIR | ENTRY | SL | TP | RESULT | R | NOTES\`\n\n` +
        `Example:\n\`XAUUSD | long | 2650 | 2648 | 2655 | win | 2R | POC bounce\``,
      { parse_mode: "Markdown" },
    );
  });

  bot.callbackQuery("trading:strategy", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId || !(await canAccessTrading(userId)).ok) {
      await openTradingPanel(ctx);
      return;
    }
    await ctx.reply(STRATEGY_BLUEPRINT, {
      parse_mode: "Markdown",
      reply_markup: tradingKeyboard({ owner: isOwner(userId) }),
    });
  });

  bot.callbackQuery("trading:new_journal", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId || !(await canAccessTrading(userId)).ok) {
      await openTradingPanel(ctx);
      return;
    }
    ctx.session.pendingAction = "trading:journal";
    ctx.session.crescentMode = false;
    await ctx.reply(
      `📝 *New trade journal*\n\`PAIR | DIR | ENTRY | SL | TP | RESULT | R | NOTES\`\n\n` +
        `Example:\n\`XAUUSD | short | 2660 | 2663 | 2654 | open | — | VAL rejection\``,
      { parse_mode: "Markdown" },
    );
  });

  bot.callbackQuery("trading:list", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from || !(await canAccessTrading(ctx.from.id)).ok) {
      await openTradingPanel(ctx);
      return;
    }
    await listJournals(ctx);
  });

  bot.callbackQuery("trading:insights", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId || !(await canAccessTrading(userId)).ok) {
      await openTradingPanel(ctx);
      return;
    }
    await ctx.reply(
      `🔔 *Trading insights*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `You are on the training track using the owner's XAUUSD Volume Profile playbook.\n\n` +
        `Session open: *~01:00 Nairobi* (not midnight).\n` +
        `Focus: FRVP on previous full day → extend POC/VAH/VAL.\n` +
        `Setups: POC bounce · VA reversal · Breakout only.\n\n` +
        `Journal every trade with /journal so you can review R and rule breaks.\n` +
        `Owner session pings stay private to the owner; your desk is strategy + journal.`,
      {
        parse_mode: "Markdown",
        reply_markup: tradingKeyboard({ owner: isOwner(userId) }),
      },
    );
  });

  bot.callbackQuery("trading:optin", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    await optIn(ctx, bot);
  });

  bot.callbackQuery(/^trading:approve:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("Owner only.");
      return;
    }
    const target = Number(ctx.match![1]);
    await pool.query(
      `INSERT INTO trading_access (user_id, opted_in, approved, approved_by, approved_at, updated_at)
       VALUES ($1, TRUE, TRUE, $2, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         approved = TRUE, opted_in = TRUE, approved_by = $2, approved_at = NOW(), updated_at = NOW()`,
      [target, ctx.from.id],
    );
    await ctx.reply(`✅ Trading access approved for \`${target}\``, { parse_mode: "Markdown" });
    try {
      await bot.api.sendMessage(
        target,
        `✅ Your *Trading Desk* access was approved.\nOpen *📈 Trading* from the menu or /trading`,
        { parse_mode: "Markdown" },
      );
    } catch {
      /* ignore */
    }
  });

  bot.callbackQuery(/^trading:deny:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("Owner only.");
      return;
    }
    const target = Number(ctx.match![1]);
    await pool.query(
      `INSERT INTO trading_access (user_id, opted_in, approved, updated_at)
       VALUES ($1, FALSE, FALSE, NOW())
       ON CONFLICT (user_id) DO UPDATE SET approved = FALSE, opted_in = FALSE, updated_at = NOW()`,
      [target],
    );
    await ctx.reply(`Trading access denied for \`${target}\``, { parse_mode: "Markdown" });
  });

  bot.callbackQuery("trading:admin_list", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("Owner only.");
      return;
    }
    try {
      const { rows } = await pool.query<{
        user_id: string;
        opted_in: boolean;
        approved: boolean;
      }>(
        `SELECT user_id, opted_in, approved FROM trading_access
         ORDER BY updated_at DESC NULLS LAST LIMIT 30`,
      );
      if (rows.length === 0) {
        await ctx.reply("No trading opt-ins yet.");
        return;
      }
      const kb = new InlineKeyboard();
      for (const r of rows.slice(0, 10)) {
        const label = `${r.approved ? "✅" : "⏳"} ${r.user_id}`;
        kb.text(label, `trading:approve:${r.user_id}`).row();
      }
      kb.text("🏠 Menu", "menu:main");
      const text = rows
        .map(
          (r) =>
            `• ${r.user_id} — opted:${r.opted_in ? "yes" : "no"} approved:${r.approved ? "yes" : "no"}`,
        )
        .join("\n");
      await ctx.reply(`👥 Trading access queue\n${text}`, { reply_markup: kb });
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "error"}`);
    }
  });
}
