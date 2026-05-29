import { InlineKeyboard } from "grammy";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { logger } from "../../lib/logger";
import { socialMenuKeyboard } from "./menu";

interface OgInfo {
  title?: string;
  description?: string;
}

async function fetchOgInfo(url: string): Promise<OgInfo> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; TelegramBot/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    const html = await res.text();
    const titleMatch =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const descMatch =
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    return { title: titleMatch?.[1]?.trim(), description: descMatch?.[1]?.trim() };
  } catch (err) {
    logger.warn({ err, url }, "Failed to fetch OG info");
    return {};
  }
}

const PLATFORM_META: Record<string, { emoji: string; name: string }> = {
  fb: { emoji: "📘", name: "Facebook" },
  insta: { emoji: "📸", name: "Instagram" },
  snap: { emoji: "👻", name: "Snapchat" },
  pin: { emoji: "📌", name: "Pinterest" },
};

const backKb = () =>
  new InlineKeyboard()
    .text("🔙 Social Tools", "menu:social")
    .text("🏠 Main Menu", "menu:main");

export async function processSocial(ctx: BotContext, platform: string, input: string): Promise<void> {
  const meta = PLATFORM_META[platform];
  if (!meta) return;

  if (ctx.chat?.type !== "private") {
    await ctx.reply("⚠️ Social tools only work in private DM with the bot.");
    return;
  }

  const url = input.trim();
  if (!url.startsWith("http")) {
    await ctx.reply(`❌ Invalid URL. Please send a valid http/https link.`, { reply_markup: backKb() });
    return;
  }

  await ctx.reply(`⏳ Fetching ${meta.name} info...`);
  const info = await fetchOgInfo(url);

  let msg =
    `${meta.emoji} *${meta.name.toUpperCase()} SCRAPE*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🔗 URL: ${url}\n`;

  if (info.title) msg += `\n📌 Title:\n${info.title}\n`;
  if (info.description) msg += `\n📝 Description:\n${info.description}\n`;
  if (!info.title && !info.description) msg += `\n⚠️ No public metadata found.`;

  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: backKb() });
}

export function registerSocialHandlers(bot: MyBot): void {
  const platforms = Object.keys(PLATFORM_META);

  for (const platform of platforms) {
    const meta = PLATFORM_META[platform]!;
    bot.command(platform, async (ctx) => {
      if (ctx.chat?.type !== "private") {
        await ctx.reply(`📥 Use /${platform} in a private DM with the bot.`);
        return;
      }
      const url = ctx.match?.trim();
      if (!url || !url.startsWith("http")) {
        await ctx.reply(`Usage: /${platform} https://...`);
        return;
      }
      await processSocial(ctx, platform, url);
    });
  }
}

export function registerSocialCallbacks(bot: MyBot): void {
  const platforms = Object.keys(PLATFORM_META);

  for (const platform of platforms) {
    const meta = PLATFORM_META[platform]!;
    bot.callbackQuery(`social:${platform}`, async (ctx) => {
      if (ctx.chat?.type !== "private") {
        await ctx.answerCallbackQuery("⚠️ Open a private DM with the bot to use this.");
        return;
      }
      ctx.session.pendingAction = `social:${platform}`;
      await ctx.answerCallbackQuery();
      await ctx.reply(
        `${meta.emoji} *${meta.name} Lookup*\n━━━━━━━━━━━━━━━━━━\n\nSend the URL to fetch:\n\nExample: \`https://www.${meta.name.toLowerCase()}.com/someprofile\``,
        { parse_mode: "Markdown" }
      );
    });
  }
}
