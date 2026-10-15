/**
 * Crescent inline — ALWAYS answer within ~2s or Telegram spins forever.
 */
import type { Bot } from "grammy";
import type { InlineQueryResultArticle } from "grammy/types";
import { eq } from "drizzle-orm";
import { accessTable, db } from "@workspace/db";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";
import { routeChat } from "../../lib/model-router";
import { consumeCrescentQuota, formatCrescentQuota } from "./crescent-quota";
import { botUsername } from "./growth";

const AI_MS = 2_000;

function article(
  id: string,
  title: string,
  description: string,
  messageText: string,
): InlineQueryResultArticle {
  return {
    type: "article",
    id: id.slice(0, 64),
    title: title.slice(0, 64),
    description: description.slice(0, 120),
    input_message_content: { message_text: messageText.slice(0, 4096) },
  };
}

async function canUseInline(userId: number): Promise<{ ok: boolean; reason?: string }> {
  if (isOwner(userId)) return { ok: true };
  try {
    const [row] = await db.select().from(accessTable).where(eq(accessTable.userId, userId));
    if (row?.tier === "blocked") return { ok: false, reason: "Account blocked" };
    if (!row?.isApproved) {
      return { ok: false, reason: `Open @${botUsername()} → /start first` };
    }
    return { ok: true };
  } catch {
    return { ok: true };
  }
}

async function aiOrTimeout(q: string): Promise<string | null> {
  try {
    const work = routeChat("chat", [
      {
        role: "system",
        content: "You are Crescent. Max 350 characters. Plain text. Help the user reply or answer.",
      },
      { role: "user", content: q.slice(0, 400) },
    ]);
    const result = await Promise.race([
      work,
      new Promise<null>((r) => setTimeout(() => r(null), AI_MS)),
    ]);
    if (!result) return null;
    return (result.reply || "").trim().slice(0, 800) || null;
  } catch {
    return null;
  }
}

export function registerInlineCrescent(bot: Bot<BotContext>): void {
  bot.on("inline_query", async (ctx) => {
    const userId = ctx.from?.id;
    const q = (ctx.inlineQuery.query ?? "").trim();

    // Safety: always end with answerInlineQuery
    const answer = async (results: InlineQueryResultArticle[], extra?: object) => {
      try {
        await ctx.answerInlineQuery(results, {
          cache_time: 2,
          is_personal: true,
          ...extra,
        });
      } catch (err) {
        logger.warn({ err }, "answerInlineQuery failed");
      }
    };

    try {
      if (!userId) {
        await answer([]);
        return;
      }

      const access = await canUseInline(userId);
      if (!access.ok) {
        await answer(
          [
            article(
              "noacc",
              "Open Crescent first",
              access.reason ?? "/start the bot",
              `${access.reason}\n\nt.me/${botUsername()}`,
            ),
          ],
          { switch_pm_text: "Open Crescent", switch_pm_parameter: "inline" },
        );
        return;
      }

      if (!q) {
        await answer(
          [
            article(
              "hint",
              "Type a question",
              `After @${botUsername()}`,
              `Example:\n@${botUsername()} how do I reply to this?\n\nThen tap the result to send.`,
            ),
          ],
          { switch_pm_text: "Open Crescent", switch_pm_parameter: "inline" },
        );
        return;
      }

      const consumed = await consumeCrescentQuota(userId).catch(() => ({ allowed: true } as any));
      if (consumed && consumed.allowed === false) {
        await answer([
          article(
            "quota",
            "Quota exceeded",
            formatCrescentQuota(consumed),
            `Quota exceeded. Open @${botUsername()} or wait for reset.`,
          ),
        ]);
        return;
      }

      const reply = await aiOrTimeout(q);

      if (reply) {
        await answer([
          article(
            `a${Date.now()}`,
            "Crescent",
            reply.slice(0, 100),
            `Crescent\n————————\n\n${reply}\n\n— @${botUsername()}`,
          ),
          article(`r${Date.now()}`, "Answer only", "Plain text", reply),
        ]);
        return;
      }

      // AI too slow — still return something so the spinner stops
      await answer(
        [
          article(
            `slow${Date.now()}`,
            "Open Crescent for full answer",
            "AI is slow — tap to chat with the bot",
            `Crescent is taking longer than usual.\n\nYour question:\n${q}\n\n→ Open @${botUsername()} and send it there for a full reply.`,
          ),
        ],
        { switch_pm_text: "Ask Crescent now", switch_pm_parameter: "inline_slow" },
      );
    } catch (err) {
      logger.error({ err, userId, q: q.slice(0, 60) }, "inline_query error");
      await answer([
        article("err", "Try again", "Or open the bot", `Open @${botUsername()} and use /crescent`),
      ]);
    }
  });
}
