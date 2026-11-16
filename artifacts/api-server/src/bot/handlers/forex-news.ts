/**
 * Forex News — economic calendar (Nairobi times)
 *
 * Category access (menu /fxnews /calendar): Premium + VIP only.
 * News notifications (10 min before each event + optional daily): Free + Premium + VIP.
 * Free Crescent AI quota is 10/day (see crescent-quota.ts).
 */
import { InlineKeyboard } from "grammy";
import { and, eq, ne } from "drizzle-orm";
import { db, accessTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { checkAccess } from "./access";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

type Impact = "high" | "medium" | "low";

interface CalendarEvent {
  time: string;
  currency: string;
  impact: string;
  title: string;
  forecast?: string;
  previous?: string;
  actual?: string;
  id?: string;
}

interface CacheEntry {
  at: number;
  events: CalendarEvent[];
}

const cache = new Map<string, CacheEntry>();
const CACHE_MS = 5 * 60 * 1000;

/** Timers for "10 minutes before" alerts — keyed by event id */
const preAlertTimers = new Map<string, NodeJS.Timeout>();

/** Full Forex category: Premium / VIP (and owner). Free cannot open the panel. */
async function canUseForexCategory(ctx: BotContext): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (isOwner(userId)) return true;
  return checkAccess(ctx, "premium");
}

function impactEmoji(impact: string): string {
  const i = impact.toLowerCase();
  if (i === "high") return "🔴";
  if (i === "medium") return "🟠";
  return "🟡";
}

function fmtNairobi(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-KE", {
      timeZone: "Africa/Nairobi",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return iso;
  }
}

function nairobiDateKey(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
}

function nairobiWeekdayLabel(d = new Date()): string {
  return d.toLocaleDateString("en-KE", {
    timeZone: "Africa/Nairobi",
    weekday: "long",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function eventNairobiDateKey(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
  } catch {
    return "";
  }
}

function eventKey(e: CalendarEvent): string {
  return e.id || `${e.time}|${e.currency}|${e.title}`;
}

async function fetchShowMyTrades(days: number, impact: Impact): Promise<CalendarEvent[]> {
  const url =
    `https://showmytrades.com/api/public/calendar/v1` +
    `?currency=USD,EUR,GBP,JPY,AUD,CAD,CHF,NZD` +
    `&impact=${impact === "high" ? "high" : impact === "medium" ? "high,medium" : "high,medium,low"}` +
    `&days=${days}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`calendar HTTP ${res.status}`);
  const data = (await res.json()) as {
    events?: Array<{
      time?: string;
      currency?: string;
      impact?: string;
      title?: string;
      forecast?: string;
      previous?: string;
      actual?: string;
      id?: string;
    }>;
  };
  return (data.events ?? []).map((e) => ({
    time: e.time ?? "",
    currency: e.currency ?? "—",
    impact: (e.impact ?? "low").toLowerCase(),
    title: e.title ?? "Event",
    forecast: e.forecast || undefined,
    previous: e.previous || undefined,
    actual: e.actual || undefined,
    id: e.id,
  }));
}

async function fetchPipAtlas(): Promise<CalendarEvent[]> {
  const res = await fetch("https://pipatlas.com/api/calendar", {
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`pipatlas HTTP ${res.status}`);
  const data = (await res.json()) as {
    events?: Array<{
      date?: string;
      currency?: string;
      impact?: string;
      name?: string;
      forecast?: string;
      previous?: string;
    }>;
  };
  const now = Date.now();
  const horizon = now + 8 * 24 * 60 * 60 * 1000;
  return (data.events ?? [])
    .filter((e) => {
      const t = e.date ? new Date(e.date).getTime() : 0;
      return t >= now - 12 * 60 * 60 * 1000 && t <= horizon;
    })
    .map((e) => ({
      time: e.date ?? "",
      currency: e.currency ?? "—",
      impact: (e.impact ?? "low").toLowerCase(),
      title: e.name ?? "Event",
      forecast: e.forecast || undefined,
      previous: e.previous || undefined,
    }));
}

async function loadEvents(mode: "high" | "week"): Promise<CalendarEvent[]> {
  const key = mode;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.events;

  let events: CalendarEvent[] = [];
  try {
    events = await fetchShowMyTrades(mode === "week" ? 7 : 2, mode === "high" ? "high" : "medium");
  } catch (err) {
    logger.warn({ err }, "showmytrades calendar failed — trying fallback");
    try {
      events = await fetchPipAtlas();
      if (mode === "high") {
        events = events.filter((e) => e.impact === "high");
      }
    } catch (err2) {
      logger.error({ err2 }, "all calendar sources failed");
      throw err2;
    }
  }

  events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  cache.set(key, { at: Date.now(), events });
  return events;
}

async function loadEventsForNairobiDay(dayKey?: string): Promise<CalendarEvent[]> {
  const key = dayKey ?? nairobiDateKey();
  const all = await loadEvents("week");
  return all.filter((e) => eventNairobiDateKey(e.time) === key);
}

function formatEvents(events: CalendarEvent[], title: string): string {
  if (events.length === 0) {
    return `${title}\n━━━━━━━━━━━━━━━━━━\n\nNo events in this window.`;
  }
  const lines = events.slice(0, 25).map((e) => {
    const nums = [
      e.actual ? `A:${e.actual}` : null,
      e.forecast ? `F:${e.forecast}` : null,
      e.previous ? `P:${e.previous}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      `${impactEmoji(e.impact)} ${fmtNairobi(e.time)}  ${e.currency}\n` +
      `   ${e.title}${nums ? `\n   ${nums}` : ""}`
    );
  });
  return (
    `${title}\n━━━━━━━━━━━━━━━━━━\n` +
    `Times: Africa/Nairobi\n` +
    `🔴 High · 🟠 Medium\n\n` +
    lines.join("\n\n") +
    `\n\nXAU tip: watch high-impact USD (NFP, CPI, FOMC).`
  );
}

function formatPreAlert(e: CalendarEvent): string {
  const nums = [
    e.forecast ? `Forecast: ${e.forecast}` : null,
    e.previous ? `Previous: ${e.previous}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    `⏰ FOREX IN 10 MINUTES\n━━━━━━━━━━━━━━━━━━\n\n` +
    `${impactEmoji(e.impact)} ${e.currency} — ${e.title}\n` +
    `🕐 ${fmtNairobi(e.time)} (Nairobi)\n` +
    (nums ? `${nums}\n` : "") +
    `\nGet ready — release in ~10 minutes.`
  );
}

function newsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📅 Today (full day)", "fxnews:today")
    .row()
    .text("🔴 High impact", "fxnews:high")
    .text("📅 Next 7 days", "fxnews:week")
    .row()
    .text("🔄 Refresh", "fxnews:today")
    .text("🏠 Menu", "menu:main");
}

function upgradeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💎 Premium / VIP plans", "access:plans")
    .row()
    .text("🏠 Menu", "menu:main");
}

export async function openForexNews(ctx: BotContext): Promise<void> {
  if (!(await canUseForexCategory(ctx))) return;
  await ctx.reply(
    `📰 *FOREX NEWS*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `Economic calendar for majors (USD · EUR · GBP · JPY…).\n` +
      `*Premium · VIP* category access.\n` +
      `All approved users get *10‑min* release alerts.\n` +
      `Daily board at *00:15 Nairobi* (Premium/VIP).\n\n` +
      `Pick a view:`,
    { parse_mode: "Markdown", reply_markup: newsKeyboard() },
  );
}

async function sendCalendar(ctx: BotContext, mode: "high" | "week"): Promise<void> {
  if (!(await canUseForexCategory(ctx))) return;
  const thinking = await ctx.reply("📰 Loading calendar…");
  try {
    const events = await loadEvents(mode);
    const title =
      mode === "high"
        ? "📰 HIGH IMPACT (next ~48h)"
        : "📰 ECONOMIC CALENDAR (7 days)";
    let text = formatEvents(events, title);
    if (text.length > 3900) text = text.slice(0, 3890) + "\n…";
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(text, { reply_markup: newsKeyboard() });
  } catch (err) {
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(
      `❌ Could not load forex calendar.\n${err instanceof Error ? err.message : "Unknown error"}`,
      { reply_markup: newsKeyboard() },
    );
  }
}

async function sendTodayCalendar(ctx: BotContext): Promise<void> {
  if (!(await canUseForexCategory(ctx))) return;
  const thinking = await ctx.reply("📰 Loading today's full calendar…");
  try {
    const label = nairobiWeekdayLabel();
    const events = await loadEventsForNairobiDay(nairobiDateKey());
    const title = `📰 FOREX NEWS — ${label}`;
    let text = formatEvents(events, title);
    text += `\n\nFull day · Africa/Nairobi`;
    if (text.length > 3900) text = text.slice(0, 3890) + "\n…";
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(text, { reply_markup: newsKeyboard() });
  } catch (err) {
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(
      `❌ Could not load today's calendar.\n${err instanceof Error ? err.message : "Unknown error"}`,
      { reply_markup: newsKeyboard() },
    );
  }
}

/** Free + Premium + VIP approved (and owner) — receive 10‑min news alerts. */
async function listNewsAlertRecipients(): Promise<number[]> {
  const ids = new Set<number>();
  const ownerId = parseInt(process.env["BOT_OWNER_ID"] ?? "0", 10);
  if (ownerId) ids.add(ownerId);
  try {
    const rows = await db
      .select({ userId: accessTable.userId })
      .from(accessTable)
      .where(and(eq(accessTable.isApproved, true), ne(accessTable.tier, "blocked")));
    for (const r of rows) {
      const id = Number(r.userId);
      if (id) ids.add(id);
    }
  } catch (err) {
    logger.warn({ err }, "listNewsAlertRecipients failed");
  }
  return [...ids];
}

/** Premium + VIP (+ owner) — daily full board. */
async function listPremiumForexRecipients(): Promise<number[]> {
  const ids = new Set<number>();
  const ownerId = parseInt(process.env["BOT_OWNER_ID"] ?? "0", 10);
  if (ownerId) ids.add(ownerId);
  try {
    const rows = await db
      .select({ userId: accessTable.userId, tier: accessTable.tier })
      .from(accessTable)
      .where(and(eq(accessTable.isApproved, true), ne(accessTable.tier, "blocked")));
    for (const r of rows) {
      const tier = (r.tier ?? "").toLowerCase();
      if (tier === "premium" || tier === "vip") {
        const id = Number(r.userId);
        if (id) ids.add(id);
      }
    }
  } catch (err) {
    logger.warn({ err }, "listPremiumForexRecipients failed");
  }
  return [...ids];
}

function msUntilNextNairobiTime(hour: number, minute = 0): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  const h = get("hour");
  const mi = get("minute");
  const s = get("second");
  const nowNairobiAsUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  let targetNairobiAsUtc = Date.UTC(y, mo - 1, d, hour, minute, 0);
  if (targetNairobiAsUtc <= nowNairobiAsUtc) targetNairobiAsUtc += 24 * 60 * 60 * 1000;
  return targetNairobiAsUtc - nowNairobiAsUtc;
}

export async function sendDailyForexNews(userId: number, bot: MyBot): Promise<void> {
  const label = nairobiWeekdayLabel();
  const events = await loadEventsForNairobiDay(nairobiDateKey());
  if (events.length === 0) {
    await bot.api.sendMessage(
      userId,
      `📰 FOREX NEWS — ${label}\n━━━━━━━━━━━━━━━━━━\n\nQuiet calendar today (Africa/Nairobi).\nNo high/medium releases listed.\n\n10‑min alerts still fire if events appear.`,
    );
    return;
  }
  const title = `📰 FOREX NEWS — ${label}`;
  let text = formatEvents(events, title);
  text += `\n\nFull day · Premium/VIP board · 10‑min alerts on for all tiers`;
  if (text.length > 3900) text = text.slice(0, 3890) + "\n…";
  await bot.api.sendMessage(userId, text);
}

async function broadcastPreAlert(bot: MyBot, e: CalendarEvent): Promise<void> {
  const text = formatPreAlert(e);
  const recipients = await listNewsAlertRecipients();
  logger.info({ title: e.title, currency: e.currency, count: recipients.length }, "Forex 10‑min alert");
  for (const userId of recipients) {
    try {
      await bot.api.sendMessage(userId, text);
      await new Promise((r) => setTimeout(r, 60));
    } catch (err) {
      logger.warn({ err, userId }, "forex pre-alert send failed");
    }
  }
}

/**
 * Schedule a 10‑minute warning for every high/medium event still ahead today.
 * Safe to call multiple times — skips events already armed.
 */
async function armTenMinuteAlerts(bot: MyBot): Promise<void> {
  let events: CalendarEvent[] = [];
  try {
    events = await loadEventsForNairobiDay(nairobiDateKey());
  } catch (err) {
    logger.error({ err }, "armTenMinuteAlerts: load failed");
    return;
  }

  const now = Date.now();
  const TEN_MIN = 10 * 60 * 1000;
  let armed = 0;

  for (const e of events) {
    const impact = e.impact.toLowerCase();
    if (impact !== "high" && impact !== "medium") continue;

    const at = new Date(e.time).getTime();
    if (!Number.isFinite(at)) continue;

    const fireAt = at - TEN_MIN;
    const key = eventKey(e);

    if (preAlertTimers.has(key)) continue;
    if (fireAt <= now) continue;

    const delay = fireAt - now;
    if (delay > 36 * 60 * 60 * 1000) continue;

    const timer = setTimeout(() => {
      preAlertTimers.delete(key);
      broadcastPreAlert(bot, e).catch((err) =>
        logger.error({ err, key }, "broadcastPreAlert failed"),
      );
    }, delay);

    preAlertTimers.set(key, timer);
    armed++;
  }

  logger.info({ armed, totalToday: events.length }, "Forex 10‑min alerts armed");
}

/**
 * 00:15 Nairobi:
 *  - Premium/VIP: full day board
 *  - All approved: re-arm 10‑min alerts for the new day
 */
export function startForexNewsDailyScheduler(bot: MyBot): void {
  const HOUR = 0;
  const MINUTE = 15;

  function scheduleNext(): void {
    const delay = msUntilNextNairobiTime(HOUR, MINUTE);
    setTimeout(async () => {
      try {
        for (const [k, t] of preAlertTimers) {
          clearTimeout(t);
          preAlertTimers.delete(k);
        }

        const premiumRecipients = await listPremiumForexRecipients();
        logger.info({ count: premiumRecipients.length }, "Sending daily Forex board (Premium/VIP)");
        for (const userId of premiumRecipients) {
          try {
            await sendDailyForexNews(userId, bot);
            await new Promise((r) => setTimeout(r, 80));
          } catch (err) {
            logger.error({ err, userId }, "daily forex news send failed");
          }
        }

        await armTenMinuteAlerts(bot);
      } catch (err) {
        logger.error({ err }, "forex news daily scheduler tick failed");
      }
      scheduleNext();
    }, delay);
    logger.info({ nextInMs: delay, at: "00:15 Africa/Nairobi" }, "Next daily Forex News scheduled");
  }

  scheduleNext();

  armTenMinuteAlerts(bot).catch((err) => logger.error({ err }, "boot armTenMinuteAlerts failed"));

  setInterval(() => {
    armTenMinuteAlerts(bot).catch((err) => logger.error({ err }, "refresh armTenMinuteAlerts failed"));
  }, 30 * 60 * 1000);
}

export function registerForexNewsHandlers(bot: MyBot): void {
  bot.command("fxnews", async (ctx) => {
    await openForexNews(ctx);
  });
  bot.command("forexnews", async (ctx) => {
    await openForexNews(ctx);
  });
  bot.command("calendar", async (ctx) => {
    await sendTodayCalendar(ctx);
  });

  bot.callbackQuery("fxnews:today", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendTodayCalendar(ctx);
  });
  bot.callbackQuery("fxnews:high", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendCalendar(ctx, "high");
  });
  bot.callbackQuery("fxnews:week", async (ctx) => {
    await ctx.answerCallbackQuery();
    await sendCalendar(ctx, "week");
  });
  bot.callbackQuery("menu:fxnews", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (userId && !isOwner(userId)) {
      const ok = await checkAccess(ctx, "premium");
      if (!ok) {
        await ctx
          .reply(
            `📰 *Forex category* is *Premium / VIP*.\n\n` +
              `As Free you still get *automatic 10‑minute* release alerts.\n` +
              `Upgrade to open the full calendar panel.`,
            { parse_mode: "Markdown", reply_markup: upgradeKeyboard() },
          )
          .catch(() => {});
        return;
      }
    }
    await openForexNews(ctx);
  });
}
