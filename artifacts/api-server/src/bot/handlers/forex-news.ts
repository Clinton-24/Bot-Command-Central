/**
 * Forex News — Forex Factory economic calendar (Nairobi times)
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

/**
 * Forex Factory calendar (https://www.forexfactory.com/calendar).
 * The site is Cloudflare-protected for scrapers; we use the public weekly JSON
 * mirror that carries the same FF calendar rows.
 */
async function fetchForexFactory(): Promise<CalendarEvent[]> {
  const urls = [
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
    "https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json",
  ];
  let lastErr: unknown;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15_000),
        headers: {
          Accept: "application/json",
          "User-Agent": "CrescentBot/1.0 (Forex Factory calendar)",
        },
      });
      if (!res.ok) throw new Error(`ForexFactory feed HTTP ${res.status}`);
      const data = (await res.json()) as Array<{
        title?: string;
        country?: string;
        date?: string;
        impact?: string;
        forecast?: string;
        previous?: string;
      }>;
      if (!Array.isArray(data)) throw new Error("ForexFactory feed: unexpected shape");
      return data
        .filter((e) => e.date && e.title)
        .map((e) => ({
          time: e.date!,
          currency: (e.country ?? "—").toUpperCase(),
          impact: (e.impact ?? "low").toLowerCase(),
          title: e.title ?? "Event",
          forecast: e.forecast || undefined,
          previous: e.previous || undefined,
          id: `ff:${e.date}:${e.country}:${e.title}`,
        }));
    } catch (err) {
      lastErr = err;
      logger.warn({ err, url }, "Forex Factory feed attempt failed");
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("Forex Factory calendar unavailable");
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
  let source = "forexfactory";
  try {
    events = await fetchForexFactory();
  } catch (err) {
    logger.warn({ err }, "Forex Factory primary failed — trying fallbacks");
    try {
      events = await fetchShowMyTrades(mode === "week" ? 7 : 2, mode === "high" ? "high" : "medium");
      source = "showmytrades";
    } catch (err2) {
      logger.warn({ err2 }, "showmytrades failed — trying pipatlas");
      try {
        events = await fetchPipAtlas();
        source = "pipatlas";
      } catch (err3) {
        logger.error({ err3 }, "all calendar sources failed");
        throw err3;
      }
    }
  }

  if (mode === "high") {
    events = events.filter((e) => e.impact === "high");
  } else {
    events = events.filter((e) => e.impact === "high" || e.impact === "medium");
  }

  events.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  cache.set(key, { at: Date.now(), events });
  logger.info({ source, mode, count: events.length }, "forex calendar loaded");
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
    `Times: Africa/Nairobi · Source: Forex Factory\n` +
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
    `⏰ *NEWS IN 10 MIN*\n━━━━━━━━━━━━━━━━━━\n` +
    `${impactEmoji(e.impact)} *${e.currency}* — ${e.title}\n` +
    `${fmtNairobi(e.time)} (Nairobi)\n` +
    (nums ? `${nums}\n` : "") +
    `\nSource: Forex Factory`
  );
}

function forexKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📅 Today", "fxnews:today")
    .text("🔴 High impact", "fxnews:high")
    .row()
    .text("📆 This week", "fxnews:week")
    .text("🔄 Refresh", "fxnews:refresh")
    .row()
    .text("🏠 Main Menu", "menu:main");
}

export async function openForexNews(ctx: BotContext): Promise<void> {
  if (!(await canUseForexCategory(ctx))) {
    await ctx.reply(
      `📰 *FOREX NEWS*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Full calendar is *Premium / VIP*.\n` +
        `Free users still get *10‑min news alerts* when events are near.\n\n` +
        `Upgrade: /plans`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("💎 Plans", "access:plans")
          .row()
          .text("🏠 Main Menu", "menu:main"),
      },
    );
    return;
  }

  const label = nairobiWeekdayLabel();
  const thinking = await ctx.reply("⏳ Loading Forex Factory calendar…");
  try {
    const events = await loadEventsForNairobiDay();
    const text = formatEvents(events, `📰 FOREX — ${label}`);
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(text, { reply_markup: forexKeyboard() });
  } catch (err) {
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    logger.error({ err }, "openForexNews failed");
    await ctx.reply(
      `❌ Could not load Forex Factory calendar.\n${err instanceof Error ? err.message : "error"}`,
      { reply_markup: forexKeyboard() },
    );
  }
}

export function registerForexNewsHandlers(bot: MyBot): void {
  bot.command("fxnews", async (ctx) => {
    await openForexNews(ctx);
  });
  bot.command("calendar", async (ctx) => {
    await openForexNews(ctx);
  });

  bot.callbackQuery("fxnews:today", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await canUseForexCategory(ctx))) return;
    try {
      const events = await loadEventsForNairobiDay();
      const text = formatEvents(events, `📰 FOREX — ${nairobiWeekdayLabel()}`);
      await ctx.editMessageText(text, { reply_markup: forexKeyboard() }).catch(async () => {
        await ctx.reply(text, { reply_markup: forexKeyboard() });
      });
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "error"}`);
    }
  });

  bot.callbackQuery("fxnews:high", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await canUseForexCategory(ctx))) return;
    try {
      const events = await loadEvents("high");
      const text = formatEvents(events, "🔴 HIGH IMPACT (this week)");
      await ctx.editMessageText(text, { reply_markup: forexKeyboard() }).catch(async () => {
        await ctx.reply(text, { reply_markup: forexKeyboard() });
      });
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "error"}`);
    }
  });

  bot.callbackQuery("fxnews:week", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!(await canUseForexCategory(ctx))) return;
    try {
      const events = await loadEvents("week");
      const text = formatEvents(events, "📆 THIS WEEK (high + medium)");
      await ctx.editMessageText(text, { reply_markup: forexKeyboard() }).catch(async () => {
        await ctx.reply(text, { reply_markup: forexKeyboard() });
      });
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "error"}`);
    }
  });

  bot.callbackQuery("fxnews:refresh", async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Refreshing…" });
    cache.clear();
    await openForexNews(ctx);
  });
}

async function listAlertRecipients(): Promise<number[]> {
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
    logger.warn({ err }, "listAlertRecipients failed");
  }
  return [...ids];
}

async function sendPreEventAlert(bot: MyBot, e: CalendarEvent): Promise<void> {
  const text = formatPreAlert(e).replace(/\*/g, "");
  const recipients = await listAlertRecipients();
  for (const userId of recipients) {
    try {
      await bot.api.sendMessage(userId, text);
    } catch (err) {
      logger.warn({ err, userId }, "forex pre-alert send failed");
    }
  }
}

function schedulePreAlertsForDay(bot: MyBot, events: CalendarEvent[]): void {
  const now = Date.now();
  for (const e of events) {
    const key = eventKey(e);
    const t = new Date(e.time).getTime();
    if (!Number.isFinite(t)) continue;
    const fireAt = t - 10 * 60 * 1000;
    if (fireAt <= now) continue;
    if (fireAt - now > 36 * 60 * 60 * 1000) continue;

    const existing = preAlertTimers.get(key);
    if (existing) clearTimeout(existing);

    const delay = fireAt - now;
    const timer = setTimeout(() => {
      preAlertTimers.delete(key);
      sendPreEventAlert(bot, e).catch((err) => logger.error({ err }, "pre-alert failed"));
    }, delay);
    preAlertTimers.set(key, timer);
  }
  logger.info({ scheduled: preAlertTimers.size }, "forex 10-min pre-alerts armed");
}

async function sendDailyForexDigest(bot: MyBot): Promise<void> {
  const label = nairobiWeekdayLabel();
  let events: CalendarEvent[] = [];
  try {
    events = await loadEventsForNairobiDay();
  } catch (err) {
    logger.error({ err }, "daily forex digest load failed");
    return;
  }
  schedulePreAlertsForDay(bot, events);

  const text = formatEvents(events, `📰 FOREX DAY — ${label}`);
  const recipients = await listAlertRecipients();
  for (const userId of recipients) {
    try {
      await bot.api.sendMessage(userId, text);
    } catch (err) {
      logger.warn({ err, userId }, "daily forex digest send failed");
    }
  }
}

function msUntilNextNairobi(hour: number, minute: number): number {
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
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  const h = get("hour");
  const mi = get("minute");
  const s = get("second");
  const nowN = Date.UTC(y, mo - 1, d, h, mi, s);
  let target = Date.UTC(y, mo - 1, d, hour, minute, 0);
  if (target <= nowN) target += 24 * 60 * 60 * 1000;
  return target - nowN;
}

/** Daily at 00:15 Nairobi: full day FF list + arm 10-min pre-alerts. */
export function startForexNewsDailyScheduler(bot: MyBot): void {
  const scheduleNext = (): void => {
    const delay = msUntilNextNairobi(0, 15);
    setTimeout(async () => {
      try {
        await sendDailyForexDigest(bot);
      } catch (err) {
        logger.error({ err }, "forex daily scheduler failed");
      }
      scheduleNext();
    }, delay);
    logger.info({ nextInMs: delay }, "Next Forex Factory daily digest scheduled (00:15 Nairobi)");
  };
  scheduleNext();

  // Boot: arm today's remaining pre-alerts without full broadcast
  loadEventsForNairobiDay()
    .then((events) => schedulePreAlertsForDay(bot, events))
    .catch((err) => logger.warn({ err }, "boot forex pre-alerts failed"));
}
