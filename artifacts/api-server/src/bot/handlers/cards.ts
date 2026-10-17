import { InlineKeyboard } from "grammy";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { logger } from "../../lib/logger";
import { consumeFeatureUse } from "../../lib/feature-usage";
import { cardMenuKeyboard } from "./menu";

interface NormalizedBin {
  scheme: string;
  type: string;
  brand: string;
  bank: string;
  country: string;
  flag: string;
}

interface HandyApiResponse {
  Status?: string;
  Scheme?: string;
  Type?: string;
  Issuer?: string;
  CardTier?: string;
  Country?: { Name?: string; A2?: string };
}

interface BinlistResponse {
  scheme?: string;
  type?: string;
  brand?: string;
  country?: { name?: string; emoji?: string };
  bank?: { name?: string };
}

const COUNTRY_FLAGS: Record<string, string> = {
  US: "🇺🇸", GB: "🇬🇧", QA: "🇶🇦", AE: "🇦🇪", SA: "🇸🇦", IN: "🇮🇳",
  DE: "🇩🇪", FR: "🇫🇷", CN: "🇨🇳", JP: "🇯🇵", RU: "🇷🇺", BR: "🇧🇷",
  CA: "🇨🇦", AU: "🇦🇺", MX: "🇲🇽", IT: "🇮🇹", ES: "🇪🇸", NL: "🇳🇱",
  TR: "🇹🇷", KR: "🇰🇷", ID: "🇮🇩", PK: "🇵🇰", NG: "🇳🇬", ZA: "🇿🇦",
  EG: "🇪🇬", PH: "🇵🇭", TH: "🇹🇭", MY: "🇲🇾", SG: "🇸🇬", KW: "🇰🇼",
  BH: "🇧🇭", OM: "🇴🇲", JO: "🇯🇴", LB: "🇱🇧", IQ: "🇮🇶", IR: "🇮🇷",
  GH: "🇬🇭", KE: "🇰🇪", TZ: "🇹🇿", MA: "🇲🇦", ET: "🇪🇹", CI: "🇨🇮",
};

async function requireCardToolQuota(ctx: BotContext): Promise<boolean> {
  const uid = ctx.from?.id;
  if (!uid) return false;
  const r = await consumeFeatureUse(uid, "card_tools");
  if (!r.allowed) {
    await ctx.reply(
      `🔒 Card Tools limit reached (${r.used}/${r.limit} today).\n\n` +
        `Free: 4/day · Premium: 50/day · VIP: 999/day.\nUpgrade for more.`,
    );
    return false;
  }
  return true;
}

async function lookupBin(bin: string): Promise<NormalizedBin | null> {
  try {
    const res = await fetch(`https://data.handyapi.com/bin/${bin}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const d = (await res.json()) as HandyApiResponse;
      if (d.Status === "SUCCESS") {
        const a2 = d.Country?.A2 ?? "";
        return {
          scheme: (d.Scheme ?? "Unknown").toUpperCase(),
          type: (d.Type ?? "Unknown").toUpperCase(),
          brand: (d.CardTier ?? "Unknown").toUpperCase(),
          bank: (d.Issuer ?? "Unknown").toUpperCase(),
          country: d.Country?.Name ?? "Unknown",
          flag: COUNTRY_FLAGS[a2] ?? "🌍",
        };
      }
    }
  } catch (err) {
    logger.warn({ err, bin }, "HandyAPI failed, trying fallback");
  }

  try {
    const res = await fetch(`https://lookup.binlist.net/${bin}`, {
      headers: { "Accept-Version": "3" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const d = (await res.json()) as BinlistResponse;
      return {
        scheme: (d.scheme ?? "Unknown").toUpperCase(),
        type: (d.type ?? "Unknown").toUpperCase(),
        brand: (d.brand ?? "Unknown").toUpperCase(),
        bank: (d.bank?.name ?? "Unknown").toUpperCase(),
        country: d.country?.name ?? "Unknown",
        flag: d.country?.emoji ?? "🌍",
      };
    }
  } catch (err) {
    logger.warn({ err, bin }, "binlist fallback failed");
  }
  return null;
}

function getScheme(bin: string): string {
  const f = bin[0];
  if (f === "4") return "VISA";
  if (f === "5") return "MASTERCARD";
  if (f === "3") return "AMEX";
  if (f === "6") return "DISCOVER";
  return "UNKNOWN";
}

function backToCardsKb(): InlineKeyboard {
  return new InlineKeyboard().text("💳 Card Tools", "menu:cards").text("🏠 Menu", "menu:main");
}

export async function processChk(ctx: BotContext, input: string): Promise<void> {
  if (!(await requireCardToolQuota(ctx))) return;
  await ctx.reply(`✅ CHK received.\n\n\`${input}\`\n\n_Processing…_`, { parse_mode: "Markdown" });
  // Keep existing CHK implementation path — placeholder response if API not wired
  logger.info({ input: input.slice(0, 6) }, "chk request");
}

export async function processRzp(ctx: BotContext, input: string): Promise<void> {
  if (!(await requireCardToolQuota(ctx))) return;
  await ctx.reply(`🔍 RZP check received.\n\n\`${input}\``, { parse_mode: "Markdown" });
  logger.info({ input: input.slice(0, 6) }, "rzp request");
}

export async function processBin(ctx: BotContext, input: string): Promise<void> {
  if (!(await requireCardToolQuota(ctx))) return;
  const bin = input.replace(/\D/g, "").slice(0, 6);
  if (bin.length < 6) {
    await ctx.reply("❌ Need a 6-digit BIN.");
    return;
  }
  await ctx.reply("⏳ Looking up BIN...");
  const data = await lookupBin(bin);
  if (!data) {
    await ctx.reply(
      `🔍 BIN LOOKUP\n━━━━━━━━━━━━━━━━━━━━\n\nBIN: \`${bin}\`\nNetwork: ${getScheme(bin)}\n\n⚠️ No data found.`,
      { parse_mode: "Markdown", reply_markup: backToCardsKb() },
    );
    return;
  }
  await ctx.reply(
    `🔍 BIN LOOKUP RESULT\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🏦 BIN: \`${bin}\`\n` +
      `💳 Scheme: ${data.scheme}\n` +
      `🏦 Type: ${data.type}\n` +
      `⭐ Level: ${data.brand}\n` +
      `🏛️ Bank: ${data.bank}\n` +
      `🌍 Country: ${data.flag} ${data.country}`,
    { parse_mode: "Markdown", reply_markup: backToCardsKb() },
  );
}

export async function processGen(ctx: BotContext, input: string): Promise<void> {
  if (!(await requireCardToolQuota(ctx))) return;
  const bin = input.replace(/\D/g, "").slice(0, 6);
  if (bin.length < 6) {
    await ctx.reply("❌ Need a 6-digit BIN.");
    return;
  }
  await ctx.reply(`🎰 GEN for BIN \`${bin}\` — request received.`, {
    parse_mode: "Markdown",
    reply_markup: backToCardsKb(),
  });
  logger.info({ bin }, "gen request");
}

export function registerCardHandlers(bot: MyBot): void {
  bot.command("chk", async (ctx) => {
    const input = ctx.match?.trim();
    if (!input) {
      await ctx.reply("Usage: /chk CARD|MM|YY|CVV");
      return;
    }
    await processChk(ctx, input);
  });

  bot.command("rzp", async (ctx) => {
    const input = ctx.match?.trim();
    if (!input) {
      await ctx.reply("Usage: /rzp CARD|MM|YY|CVV");
      return;
    }
    await processRzp(ctx, input);
  });

  bot.command("bin", async (ctx) => {
    const input = ctx.match?.trim();
    if (!input) {
      await ctx.reply("Usage: /bin XXXXXX");
      return;
    }
    await processBin(ctx, input);
  });

  bot.command("gen", async (ctx) => {
    const input = ctx.match?.trim();
    if (!input) {
      await ctx.reply("Usage: /gen XXXXXX");
      return;
    }
    await processGen(ctx, input);
  });
}

export function registerCardCallbacks(bot: MyBot): void {
  bot.callbackQuery("cards:chk", async (ctx) => {
    ctx.session.pendingAction = "card:chk";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `✅ *Card Checker*\n━━━━━━━━━━━━━━━━━━\n\nSend your card details:\n\`CARD|MM|YY|CVV\``,
      { parse_mode: "Markdown" },
    );
  });

  bot.callbackQuery("cards:rzp", async (ctx) => {
    ctx.session.pendingAction = "card:rzp";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🔍 *RZP Checker*\n━━━━━━━━━━━━━━━━━━\n\nSend:\n\`CARD|MM|YY|CVV\``,
      { parse_mode: "Markdown" },
    );
  });

  bot.callbackQuery("cards:bin", async (ctx) => {
    ctx.session.pendingAction = "card:bin";
    await ctx.answerCallbackQuery();
    await ctx.reply(`🏦 *BIN Lookup*\n\nSend a 6-digit BIN.`, { parse_mode: "Markdown" });
  });

  bot.callbackQuery("cards:gen", async (ctx) => {
    ctx.session.pendingAction = "card:gen";
    await ctx.answerCallbackQuery();
    await ctx.reply(`🎰 *Card Generator*\n\nSend a 6-digit BIN.`, { parse_mode: "Markdown" });
  });

  bot.callbackQuery(/^cards:bin_direct:(\d{6})$/, async (ctx) => {
    const bin = ctx.match[1]!;
    await ctx.answerCallbackQuery();
    await processBin(ctx, bin);
  });
}
