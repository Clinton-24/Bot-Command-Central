import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { InlineKeyboard } from "grammy";
import { isOwner } from "../helpers";
import { askHexagon } from "./hexagon";
import { logger } from "../../lib/logger";

export function registerEmailHandlers(bot: MyBot): void {
  bot.command("email", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner only.");
      return;
    }

    const input = ctx.match?.trim();
    if (!input) {
      await ctx.reply(
        `📧 *DRAFT EMAIL*\n━━━━━━━━━━━━━━━━━━\n\n` +
          `Tell me what to write:\n\n` +
          `Examples:\n` +
          `• /email postpone tomorrow's call with client to next Friday\n` +
          `• /email thank John for the proposal and say we'll review it\n` +
          `• /email ask the team to submit timesheets by EOD`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("🤖 Crescent", "menu:hexagon"),
        }
      );
      return;
    }

    await draftEmail(ctx, input);
  });
}

export async function draftEmail(ctx: BotContext, brief: string): Promise<void> {
  const thinking = await ctx.reply("✍️ _Drafting email..._", { parse_mode: "Markdown" });
  const userId = ctx.from!.id;

  try {
    const prompt = `Please draft a professional email for the following:\n\n${brief}\n\nFormat with Subject, then blank line, then body. End with [EMAIL_READY].`;
    const draft = await askHexagon(userId, prompt);

    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});

    await ctx.reply(
      `📧 *EMAIL DRAFT*\n━━━━━━━━━━━━━━━━━━\n\n${draft}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✏️ Revise", "email:revise")
          .text("📧 Another", "hexagon:email")
          .row()
          .text("🤖 Crescent", "menu:hexagon"),
      }
    );
  } catch (err) {
    logger.error({ err }, "draftEmail error");
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply("❌ Failed to draft email. Check your OpenAI API key.");
  }
}

export function registerEmailCallbacks(bot: MyBot): void {
  bot.callbackQuery("email:revise", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    ctx.session.pendingAction = "hexagon:input";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `✏️ *Revise Email*\n━━━━━━━━━━━━━━━━━━\n\nTell me what to change:`,
      { parse_mode: "Markdown" }
    );
  });
}
