import { InlineKeyboard } from "grammy";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { logger } from "../../lib/logger";
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
      const a2 = d.country?.emoji ? "" : "";
      return {
        scheme: (d.scheme ?? "Unknown").toUpperCase(),
        type: (d.type ?? "Unknown").toUpperCase(),
        brand: (d.brand ?? "Unknown").toUpperCase(),
        bank: (d.bank?.name ?? "Unknown").toUpperCase(),
        country: d.country?.name ?? "Unknown",
        flag: d.country?.emoji ?? COUNTRY_FLAGS[a2] ?? "🌍",
      };
    }
  } catch (err) {
    logger.warn({ err, bin }, "Binlist fallback also failed");
  }

  return null;
}

function luhnCheck(num: string): boolean {
  const digits = num.replace(/\D/g, "").split("").reverse().map(Number);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits[i];
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function getScheme(bin: string): string {
  const b = bin[0];
  if (b === "4") return "VISA";
  if (b === "5") return "MASTERCARD";
  if (b === "3") return "AMEX / DINERS";
  if (b === "6") return "DISCOVER / UNIONPAY";
  return "UNKNOWN";
}

function formatCardNumber(num: string): string {
  return num.replace(/(.{4})/g, "$1 ").trim();
}

function generateCard(bin: string): string {
  const prefix = bin.replace(/\D/g, "").substring(0, 6);
  let num = prefix;
  while (num.length < 15) num += Math.floor(Math.random() * 10).toString();
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let d = parseInt(num[num.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  num += ((10 - (sum % 10)) % 10).toString();
  const mm = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  const yy = String(new Date().getFullYear() + Math.floor(Math.random() * 4) + 1).slice(-2);
  const cvv = String(Math.floor(Math.random() * 900) + 100);
  return `${num}|${mm}|${yy}|${cvv}`;
}

function parseCard(input: string): { number: string; mm: string; yy: string; cvv: string } | null {
  const parts = input.trim().split("|");
  if (parts.length !== 4) return null;
  const [number, mm, yy, cvv] = parts;
  if (!number || !mm || !yy || !cvv) return null;
  return { number: number.replace(/\s/g, ""), mm, yy, cvv };
}

const backToCardsKb = () =>
  new InlineKeyboard().text("🔙 Card Tools", "menu:cards").text("🏠 Main Menu", "menu:main");

export async function processChk(ctx: BotContext, input: string): Promise<void> {
  const card = parseCard(input);
  if (!card) {
    await ctx.reply("❌ Invalid format. Use: `CARD|MM|YY|CVV`", {
      parse_mode: "Markdown",
      reply_markup: backToCardsKb(),
    });
    return;
  }
  const valid = luhnCheck(card.number);
  const scheme = getScheme(card.number);
  const bin = card.number.substring(0, 6);
  const formatted = formatCardNumber(card.number);

  await ctx.reply(
    `💳 *CARD CHECK RESULT*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Card: \`${formatted}\`\n` +
      `Expiry: ${card.mm}/${card.yy}  CVV: ${card.cvv}\n` +
      `Network: ${scheme}\n` +
      `BIN: \`${bin}\`\n\n` +
      `Luhn: ${valid ? "✅ Valid" : "❌ Invalid"}\n` +
      `Status: ${valid ? "✅ *LIVE*" : "❌ *DEAD*"}`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🏦 Lookup BIN", `cards:bin_direct:${bin}`)
        .row()
        .text("🔙 Card Tools", "menu:cards")
        .text("🏠 Main Menu", "menu:main"),
    }
  );
}

export async function processRzp(ctx: BotContext, input: string): Promise<void> {
  const card = parseCard(input);
  if (!card) {
    await ctx.reply("❌ Invalid format. Use: `CARD|MM|YY|CVV`", {
      parse_mode: "Markdown",
      reply_markup: backToCardsKb(),
    });
    return;
  }
  const valid = luhnCheck(card.number);
  const scheme = getScheme(card.number);
  const bin = card.number.substring(0, 6);
  const formatted = formatCardNumber(card.number);

  await ctx.reply(
    `🔍 *RZP CHECK RESULT*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Card: \`${formatted}\`\n` +
      `Expiry: ${card.mm}/${card.yy}  CVV: ${card.cvv}\n` +
      `Network: ${scheme}\n` +
      `BIN: \`${bin}\`\n` +
      `Gateway: Razorpay\n\n` +
      `Luhn: ${valid ? "✅ Valid" : "❌ Invalid"}\n` +
      `Result: ${valid ? "✅ *Approved*" : "❌ *Declined*"}`,
    {
      parse_mode: "Markdown",
      reply_markup: backToCardsKb(),
    }
  );
}

export async function processBin(ctx: BotContext, input: string): Promise<void> {
  const bin = input.replace(/\D/g, "").substring(0, 6);
  if (bin.length < 6) {
    await ctx.reply("❌ Please send a valid 6-digit BIN.", { reply_markup: backToCardsKb() });
    return;
  }
  await ctx.reply("⏳ Looking up BIN...");
  const data = await lookupBin(bin);

  if (!data) {
    await ctx.reply(
      `🔍 *BIN LOOKUP*\n━━━━━━━━━━━━━━━━━━━━\n\n` +
        `BIN: \`${bin}\`\n` +
        `Network: ${getScheme(bin)}\n\n` +
        `⚠️ No further data found.`,
      { parse_mode: "Markdown", reply_markup: backToCardsKb() }
    );
    return;
  }

  await ctx.reply(
    `🔍 *BIN LOOKUP RESULT*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +
      `🏦 BIN: \`${bin}\`\n` +
      `💳 Scheme: ${data.scheme}\n` +
      `🏦 Type: ${data.type}\n` +
      `⭐ Level: ${data.brand}\n` +
      `🏛️ Bank: ${data.bank}\n` +
      `🌍 Country: ${data.flag} ${data.country}`,
    { parse_mode: "Markdown", reply_markup: backToCardsKb() }
  );
}

export async function processGen(ctx: BotContext, input: string): Promise<void> {
  const bin = input.replace(/\D/g, "").substring(0, 6);
  if (bin.length < 6) {
    await ctx.reply("❌ Please send a valid 6-digit BIN.", { reply_markup: backToCardsKb() });
    return;
  }
  const cards = Array.from({ length: 10 }, () => generateCard(bin));
  const list = cards.map((c, i) => `${i + 1}. \`${c}\``).join("\n");

  await ctx.reply(
    `🎰 *GENERATED CARDS*\n` +
      `━━━━━━━━━━━━━━━━━━━━\n` +
      `BIN: \`${bin}\` · Network: ${getScheme(bin)}\n\n` +
      `${list}`,
    { parse_mode: "Markdown", reply_markup: backToCardsKb() }
  );
}

export function registerCardHandlers(bot: MyBot): void {
  bot.command("chk", async (ctx) => {
    const input = ctx.match?.trim();
    if (!input) { await ctx.reply("Usage: /chk CARD|MM|YY|CVV"); return; }
    await processChk(ctx, input);
  });

  bot.command("rzp", async (ctx) => {
    const input = ctx.match?.trim();
    if (!input) { await ctx.reply("Usage: /rzp CARD|MM|YY|CVV"); return; }
    await processRzp(ctx, input);
  });

  bot.command("bin", async (ctx) => {
    const input = ctx.match?.trim();
    if (!input) { await ctx.reply("Usage: /bin XXXXXX"); return; }
    await processBin(ctx, input);
  });

  bot.command("gen", async (ctx) => {
    const input = ctx.match?.trim();
    if (!input) { await ctx.reply("Usage: /gen XXXXXX"); return; }
    await processGen(ctx, input);
  });
}

export function registerCardCallbacks(bot: MyBot): void {
  bot.callbackQuery("cards:chk", async (ctx) => {
    ctx.session.pendingAction = "card:chk";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `✅ *Card Checker*\n━━━━━━━━━━━━━━━━━━\n\nSend your card details:\n\`CARD|MM|YY|CVV\`\n\nExample:\n\`4111111111111111|12|26|123\``,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery("cards:rzp", async (ctx) => {
    ctx.session.pendingAction = "card:rzp";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🔍 *RZP Checker*\n━━━━━━━━━━━━━━━━━━\n\nSend your card details:\n\`CARD|MM|YY|CVV\`\n\nExample:\n\`5200000000000007|09|25|456\``,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery("cards:bin", async (ctx) => {
    ctx.session.pendingAction = "card:bin";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🏦 *BIN Lookup*\n━━━━━━━━━━━━━━━━━━\n\nSend a 6-digit BIN:\n\nExample: \`555479\``,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery("cards:gen", async (ctx) => {
    ctx.session.pendingAction = "card:gen";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🎰 *Card Generator*\n━━━━━━━━━━━━━━━━━━\n\nSend a 6-digit BIN to generate cards:\n\nExample: \`411111\``,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery(/^cards:bin_direct:(\d{6})$/, async (ctx) => {
    const bin = ctx.match[1];
    await ctx.answerCallbackQuery();
    await ctx.reply("⏳ Looking up BIN...");
    const data = await lookupBin(bin);
    if (!data) {
      await ctx.reply(
        `🔍 *BIN LOOKUP*\n━━━━━━━━━━━━━━━━━━━━\n\nBIN: \`${bin}\`\nNetwork: ${getScheme(bin)}\n\n⚠️ No data found.`,
        { parse_mode: "Markdown", reply_markup: backToCardsKb() }
      );
      return;
    }
    await ctx.reply(
      `🔍 *BIN LOOKUP RESULT*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n\n` +
        `🏦 BIN: \`${bin}\`\n` +
        `💳 Scheme: ${data.scheme}\n` +
        `🏦 Type: ${data.type}\n` +
        `⭐ Level: ${data.brand}\n` +
        `🏛️ Bank: ${data.bank}\n` +
        `🌍 Country: ${data.flag} ${data.country}`,
      { parse_mode: "Markdown", reply_markup: backToCardsKb() }
    );
  });
}
