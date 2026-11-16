/**
 * Forex News — high-impact economic calendar (Nairobi times)
 * Free public calendar feeds; cached briefly to avoid rate limits.
 * Access: Free, Premium, and VIP (approved users).
 */
import { InlineKeyboard } from "grammy";
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
}

interface CacheEntry {
  at: number;
  events: CalendarEvent[];
}

const cache = new Map<string, CacheEntry>();
const CACHE_MS = 5 * 60 * 1000;

/** Forex News: free, premium, and VIP (any approved non-blocked tier). */
async function canUseForexNews(ctx: BotContext): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (isOwner(userId)) return true;
  // Minimum gate is free — premium and VIP rank higher and always pass.
  return checkAccess(ctx, "free");
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
  const horizon = now + 3 * 24 * 60 * 60 * 1000;
  return (data.events ?? [])
    .filter((e) => {
      const t = e.date ? new Date(e.date).getTime() : 0;
      return t >= now - 6 * 60 * 60 * 1000 && t <= horizon;
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

function formatEvents(events: CalendarEvent[], title: string): string {
  if (events.length === 0) {
    return `${title}\n━━━━━━━━━━━━━━━━━━\n\nNo events in this window.`;
  }
  const lines = events.slice(0, 18).map((e) => {
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
    `\n\nXAU tip: watch high-impact USD (NFP, CPI, FOMC) — gold often reacts hard.`
  );
}

function newsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🔴 High impact", "fxnews:high")
    .text("📅 Next 7 days", "fxnews:week")
    .row()
    .text("🔄 Refresh", "fxnews:high")
    .text("🏠 Menu", "menu:main");
}

export async function openForexNews(ctx: BotContext): Promise<void> {
  if (!(await canUseForexNews(ctx))) return;
  await ctx.reply(
    `📰 *FOREX NEWS*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `Live economic calendar for majors (USD · EUR · GBP · JPY…).\n` +
      `Open to *Free · Premium · VIP* users.\n` +
      `Best for XAUUSD: focus on *high-impact USD* releases.\n\n` +
      `Pick a view:`,
    { parse_mode: "Markdown", reply_markup: newsKeyboard() },
  );
}

async function sendCalendar(ctx: BotContext, mode: "high" | "week"): Promise<void> {
  if (!(await canUseForexNews(ctx))) return;
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

export function registerForexNewsHandlers(bot: MyBot): void {
  bot.command("fxnews", async (ctx) => {
    await openForexNews(ctx);
  });
  bot.command("forexnews", async (ctx) => {
    await openForexNews(ctx);
  });
  bot.command("calendar", async (ctx) => {
    await sendCalendar(ctx, "high");
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
    await openForexNews(ctx);
  });
}
