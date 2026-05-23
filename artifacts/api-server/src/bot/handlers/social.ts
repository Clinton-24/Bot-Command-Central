import type { Bot } from "grammy";
import { logger } from "../../lib/logger";

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

    return {
      title: titleMatch?.[1]?.trim(),
      description: descMatch?.[1]?.trim(),
    };
  } catch (err) {
    logger.warn({ err, url }, "Failed to fetch OG info");
    return {};
  }
}

function buildSocialReply(platform: string, url: string, info: OgInfo): string {
  const emoji: Record<string, string> = {
    Facebook: "📘",
    Instagram: "📸",
    Snapchat: "👻",
    Pinterest: "📌",
  };
  const e = emoji[platform] ?? "🔗";
  let msg = `${e} *${platform} Scrape*\n\nURL: ${url}\n`;
  if (info.title) msg += `Title: ${info.title}\n`;
  if (info.description) msg += `Description: ${info.description}\n`;
  if (!info.title && !info.description) msg += `No public info found.\n`;
  return msg;
}

export function registerSocialHandlers(bot: Bot) {
  const platforms: Array<{ cmd: string; name: string }> = [
    { cmd: "fb", name: "Facebook" },
    { cmd: "insta", name: "Instagram" },
    { cmd: "snap", name: "Snapchat" },
    { cmd: "pin", name: "Pinterest" },
  ];

  for (const { cmd, name } of platforms) {
    bot.command(cmd, async (ctx) => {
      if (ctx.chat?.type !== "private") {
        await ctx.reply(`📥 Please use /${cmd} in a private DM with the bot.`);
        return;
      }

      const url = ctx.match?.trim();
      if (!url || !url.startsWith("http")) {
        await ctx.reply(`Usage: /${cmd} [URL]\n\nExample: /${cmd} https://www.${name.toLowerCase()}.com/profile`);
        return;
      }

      await ctx.reply(`🔍 Fetching ${name} info...`);
      const info = await fetchOgInfo(url);
      const reply = buildSocialReply(name, url, info);
      await ctx.reply(reply, { parse_mode: "Markdown" });
    });
  }
}
