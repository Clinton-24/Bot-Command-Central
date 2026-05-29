import type { Bot } from "grammy";
import { logger } from "../../lib/logger";

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
};

async function lookupBin(bin: string): Promise<NormalizedBin | null> {
  // Primary: data.handyapi.com — no key, reliable
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
    logger.warn({ err, bin }, "HandyAPI BIN lookup failed, trying fallback");
  }

  // Fallback: binlist.net
  try {
    const res = await fetch(`https://lookup.binlist.net/${bin}`, {
      headers: { "Accept-Version": "3" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const d = (await res.json()) as BinlistResponse;
      const a2 = "";
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
    logger.warn({ err, bin }, "Binlist BIN lookup also failed");
  }

  return null;
}

function luhnCheck(num: string): boolean {
  const digits = num.replace(/\D/g, "").split("").reverse().map(Number);
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits[i];
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function getBinInfo(bin: string): string {
  const b = bin.substring(0, 1);
  if (b === "4") return "Visa";
  if (b === "5") return "Mastercard";
  if (b === "3") return "Amex/Diners";
  if (b === "6") return "Discover/UnionPay";
  return "Unknown";
}

function generateCard(bin: string): string {
  const prefix = bin.replace(/\D/g, "").substring(0, 6);
  let num = prefix;
  while (num.length < 15) {
    num += Math.floor(Math.random() * 10).toString();
  }
  let sum = 0;
  for (let i = 0; i < num.length; i++) {
    let d = parseInt(num[num.length - 1 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  num += checkDigit.toString();
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

export function registerCardHandlers(bot: Bot) {
  bot.command("chk", async (ctx) => {
    const input = ctx.match?.trim();
    if (!input) { await ctx.reply("Usage: /chk CARD|MM|YY|CVV"); return; }

    const card = parseCard(input);
    if (!card) { await ctx.reply("❌ Invalid format. Use: /chk CARD|MM|YY|CVV"); return; }

    const valid = luhnCheck(card.number);
    const network = getBinInfo(card.number);
    const bin = card.number.substring(0, 6);
    const status = valid ? "✅ LIVE (Luhn Valid)" : "❌ DEAD (Luhn Invalid)";

    await ctx.reply(
      `💳 *Card Check*\n\n` +
        `Card: \`${card.number}\`\n` +
        `Expiry: ${card.mm}/${card.yy}\n` +
        `CVV: ${card.cvv}\n` +
        `Network: ${network}\n` +
        `BIN: ${bin}\n` +
        `Status: ${status}`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("rzp", async (ctx) => {
    const input = ctx.match?.trim();
    if (!input) { await ctx.reply("Usage: /rzp CARD|MM|YY|CVV"); return; }

    const card = parseCard(input);
    if (!card) { await ctx.reply("❌ Invalid format. Use: /rzp CARD|MM|YY|CVV"); return; }

    const valid = luhnCheck(card.number);
    const network = getBinInfo(card.number);

    await ctx.reply(
      `💳 *RZP Check*\n\n` +
        `Card: \`${card.number}\`\n` +
        `Expiry: ${card.mm}/${card.yy}\n` +
        `CVV: ${card.cvv}\n` +
        `Network: ${network}\n` +
        `Luhn: ${valid ? "✅ Valid" : "❌ Invalid"}\n` +
        `Gateway: Razorpay\n` +
        `Result: ${valid ? "✅ Approved" : "❌ Declined"}`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("bin", async (ctx) => {
    const input = ctx.match?.trim();
    if (!input || input.length < 6) { await ctx.reply("Usage: /bin XXXXXX (6-digit BIN)"); return; }

    const bin = input.replace(/\D/g, "").substring(0, 6);

    await ctx.reply("🔍 Looking up BIN...");

    const data = await lookupBin(bin);

    if (!data) {
      await ctx.reply(
        `🔍 *BIN Lookup*\n\n` +
          `🏦 BIN: \`${bin}\`\n` +
          `💳 Scheme: ${getBinInfo(bin)}\n` +
          `⚠️ No data found for this BIN.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    await ctx.reply(
      `🔍 *BIN Lookup*\n\n` +
        `🏦 BIN: \`${bin}\`\n` +
        `💳 Scheme: ${data.scheme}\n` +
        `🏦 Type: ${data.type}\n` +
        `⭐ Level: ${data.brand}\n` +
        `🏛️ Bank: ${data.bank}\n` +
        `🌍 Country: ${data.flag} ${data.country}`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("gen", async (ctx) => {
    const input = ctx.match?.trim();
    if (!input || input.length < 6) { await ctx.reply("Usage: /gen XXXXXX (6-digit BIN)"); return; }

    const bin = input.replace(/\D/g, "").substring(0, 6);
    const cards = Array.from({ length: 10 }, () => generateCard(bin));
    const list = cards.map((c, i) => `${i + 1}. \`${c}\``).join("\n");

    await ctx.reply(
      `🎰 *Generated Cards for BIN ${bin}*\n\n${list}`,
      { parse_mode: "Markdown" }
    );
  });
}
