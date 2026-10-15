/**
 * Instant kill switch — owner only.
 */

import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

let killed = false;
let killedAt: Date | null = null;
let killReason = "";

export function isBotKilled(): boolean {
  return killed;
}

export function getKillStatus(): {
  killed: boolean;
  killedAt: string | null;
  reason: string;
} {
  return {
    killed,
    killedAt: killedAt ? killedAt.toISOString() : null,
    reason: killReason,
  };
}

export function activateKill(reason = "owner"): void {
  killed = true;
  killedAt = new Date();
  killReason = reason;
  logger.warn({ reason }, "KILL SWITCH activated — non-owner traffic blocked");
}

export function deactivateKill(): void {
  killed = false;
  killedAt = null;
  killReason = "";
  logger.info("KILL SWITCH deactivated — bot live again");
}

/** Middleware: runs first. Owner always passes; others blocked when killed. */
export function killSwitchMiddleware() {
  return async (ctx: any, next: () => Promise<void>) => {
    if (!killed) return next();

    const uid = ctx.from?.id;
    if (uid && isOwner(uid)) return next();

    // MUST answer inline/callback or Telegram spins forever
    try {
      if (ctx.inlineQuery) {
        await ctx.answerInlineQuery(
          [
            {
              type: "article",
              id: "killed",
              title: "Bot offline",
              description: "Kill switch is on",
              input_message_content: {
                message_text: "Crescent is offline (kill switch). Contact the owner.",
              },
            },
          ],
          { cache_time: 5, is_personal: true },
        );
      } else if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "Bot offline (kill switch)", show_alert: true });
      } else if (ctx.message) {
        await ctx.reply("⛔ Bot is offline (emergency stop). Contact the owner.");
      }
    } catch {
      // ignore
    }
  };
}

export function registerKillHandlers(bot: Bot<BotContext>): void {
  bot.command("kill", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner only.");
      return;
    }
    if (killed) {
      await ctx.reply(
        `⛔ Already KILLED since ${killedAt?.toISOString() ?? "?"}\nReason: ${killReason || "—"}\n\n/unkill to restore`,
      );
      return;
    }
    await ctx.reply(
      "🛑 KILL SWITCH\n━━━━━━━━━━━━━━━━━━\n\nSoft kill blocks all users instantly. Owner can still use /unkill.\n\nConfirm:",
      {
        reply_markup: new InlineKeyboard()
          .text("🛑 KILL NOW", "kill:confirm")
          .text("Cancel", "kill:cancel"),
      },
    );
  });

  bot.command("unkill", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner only.");
      return;
    }
    if (!killed) {
      await ctx.reply("✅ Bot is already live.");
      return;
    }
    deactivateKill();
    await ctx.reply("✅ KILL SWITCH OFF — bot is live again.");
  });

  bot.command("killstatus", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner only.");
      return;
    }
    const s = getKillStatus();
    await ctx.reply(
      s.killed
        ? `⛔ KILLED\nSince: ${s.killedAt}\nReason: ${s.reason || "—"}\n\n/unkill to restore`
        : "✅ Bot is LIVE (kill switch off)",
    );
  });

  bot.command("killhard", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner only.");
      return;
    }
    await ctx.reply(
      "☠️ HARD KILL — process will exit in a few seconds.\nRender may auto-restart the service.\n\nConfirm:",
      {
        reply_markup: new InlineKeyboard()
          .text("☠️ EXIT PROCESS", "kill:hard")
          .text("Cancel", "kill:cancel"),
      },
    );
  });

  bot.callbackQuery("kill:confirm", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    activateKill(`telegram:${ctx.from.id}`);
    await ctx.answerCallbackQuery("Killed");
    await ctx.editMessageText(
      "🛑 KILL SWITCH ON\n━━━━━━━━━━━━━━━━━━\nAll non-owner traffic is blocked.\n\n/unkill to restore\n/killhard to exit the process",
    );
  });

  bot.callbackQuery("kill:cancel", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("Kill cancelled — bot still live.");
  });

  bot.callbackQuery("kill:hard", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    activateKill(`hard:${ctx.from.id}`);
    await ctx.answerCallbackQuery("Exiting…");
    await ctx.editMessageText("☠️ Process exiting in 2s…");
    logger.error({ by: ctx.from.id }, "HARD KILL — process.exit(1)");
    setTimeout(() => process.exit(1), 2000);
  });
}
