import type { MyBot } from "../index";
import { InlineKeyboard } from "grammy";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";
import type { Express } from "express";

interface BatteryReport {
  level: number;
  charging: boolean;
  reportedAt: Date;
}

let lastBatteryReport: BatteryReport | null = null;

export function getLastBatteryReport(): BatteryReport | null {
  return lastBatteryReport;
}

export function registerBatteryWebhook(app: Express, bot: MyBot): void {
  const ownerId = parseInt(process.env["BOT_OWNER_ID"] ?? "0", 10);
  if (!ownerId) return;

  app.post("/api/battery", async (req, res) => {
    try {
      const { level, charging, token } = req.body as {
        level?: number;
        charging?: boolean;
        token?: string;
      };

      if (token !== process.env["BOT_OWNER_ID"]) {
        res.status(401).json({ error: "Unauthorized" });
        return;
      }

      if (typeof level !== "number" || level < 0 || level > 100) {
        res.status(400).json({ error: "Invalid level" });
        return;
      }

      lastBatteryReport = {
        level,
        charging: charging ?? false,
        reportedAt: new Date(),
      };

      const shouldAlert = level <= 20 && !charging;

      if (shouldAlert) {
        const icon = level <= 10 ? "🪫" : "🔋";
        await bot.api
          .sendMessage(
            ownerId,
            `${icon} *LOW BATTERY ALERT*\n━━━━━━━━━━━━━━━━━━\n\n` +
              `📱 Battery: *${level}%*\n` +
              `⚡ Charging: ${charging ? "Yes ✅" : "No ❌"}\n\n` +
              `_Plug in your phone!_`,
            { parse_mode: "Markdown" }
          )
          .catch(() => {});
      }

      res.json({ ok: true, alerted: shouldAlert });
    } catch (err) {
      logger.error({ err }, "battery webhook error");
      res.status(500).json({ error: "Internal error" });
    }
  });

  logger.info("Battery webhook registered at POST /api/battery");
}

export function registerBatteryHandlers(bot: MyBot): void {
  bot.command("battery", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner only.");
      return;
    }

    const report = getLastBatteryReport();
    if (!report) {
      await ctx.reply(
        `🔋 *BATTERY STATUS*\n━━━━━━━━━━━━━━━━━━\n\n` +
          `No data yet.\n\n` +
          `📲 *How to set up automatic battery reporting:*\n\n` +
          `Use an automation app on your phone to POST to:\n` +
          `\`POST /api/battery\`\n\n` +
          `Body (JSON):\n` +
          `\`{"level": 85, "charging": false, "token": "<BOT_OWNER_ID>"}\`\n\n` +
          `*Android:* Use Tasker or MacroDroid\n` +
          `*iPhone:* Use Shortcuts app\n\n` +
          `The bot will alert you when battery drops below 20%.`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("🤖 Hexagon", "menu:hexagon"),
        }
      );
      return;
    }

    const icon =
      report.level > 80 ? "🟢" : report.level > 40 ? "🟡" : report.level > 20 ? "🟠" : "🔴";
    const chargeStr = report.charging ? "⚡ Charging" : "🔌 Not charging";
    const age = Math.round((Date.now() - report.reportedAt.getTime()) / 60000);

    await ctx.reply(
      `🔋 *BATTERY STATUS*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `${icon} Level: *${report.level}%*\n` +
        `${chargeStr}\n` +
        `🕐 Last updated: ${age}m ago`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🤖 Hexagon", "menu:hexagon"),
      }
    );
  });
}
