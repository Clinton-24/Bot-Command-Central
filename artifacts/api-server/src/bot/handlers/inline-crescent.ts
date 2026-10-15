/**
 * Crescent inline mode — optimized for speed (Telegram expects quick answerInlineQuery).
 * NOTE: Do not import from ../index (circular).
 */
import type { Bot } from "grammy";
import type { InlineQueryResultArticle } from "grammy/types";
import { eq } from "drizzle-orm";
import { accessTable, db } from "@workspace/db";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";
import { routeChat } from "../../lib/model-router";
import { consumeCrescentQuota, formatCrescentQuota, getCrescentQuotaStatus } from "./crescent-quota";
import { botUsername } from "./growth";

const INLINE_AI_TIMEOUT_MS = 5_000;

async function canUseInline(userId: number): Promise<{ ok: boolean; reason?: string }> {
  if (isOwner(userId)) return { ok: true };
  try {
    const [row] = await db.select().from(accessTable).where(eq(accessTable.userId, userId));
    if (row?.tier === "blocked") return { ok: false, reason: "Account blocked" };
    if (!row?.isApproved) {
      return {
        ok: false,
        reason: `Open @${botUsername()} and tap Start for free access first`,
      };
    }
    return { ok: true };
  } catch (err) {
    logger.warn({ err, userId }, "inline access check failed");
    return { ok: true };
  }
}

function article(
  id: string,
  title: string,
  description: string,
  messageText: string,
): InlineQueryResultArticle {
  return {
    type: "article",
    id,
    title: title.slice(0, 64),
    description: description.slice(0, 120),
    input_message_content: {
      message_text: messageText.slice(0, 4096),
    },
  };
}

async function quickAnswer(question: string): Promise<string> {
  const work = routeChat("chat", [
    {
      role: "system",
      content:
        "You are Crescent. Reply in under 400 characters. Plain text only. Be direct.",
    },
    { role: "user", content: question.slice(0, 500) },
  ]);

  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), INLINE_AI_TIMEOUT_MS),
  );

  const result = await Promise.race([work, timeout]);
  if (!result) {
    throw new Error("inline_ai_timeout");
  }
  return (result.reply || "...").trim().slice(0, 900);
}

export function registerInlineCrescent(bot: Bot<BotContext>): void {
  bot.on("inline_query", async (ctx) => {
    const userId = ctx.from?.id;
    const q = (ctx.inlineQuery.query ?? "").trim();
    const started = Date.now();

    try {
      if (!userId) {
        await ctx.answerInlineQuery([], { cache_time: 1, is_personal: true });
        return;
      }

      // Access (fast path)
      const access = await canUseInline(userId);
      if (!access.ok) {
        await ctx.answerInlineQuery(
          [
            article(
              "no-access",
              "Crescent — open bot first",
              access.reason ?? "Start the bot",
              `Crescent\n\n${access.reason ?? "Open the bot and /start."}\n\nt.me/${botUsername()}`,
            ),
          ],
          {
            cache_time: 10,
            is_personal: true,
            switch_pm_text: "Open Crescent",
            switch_pm_parameter: "inline_access",
          },
        );
        return;
      }

      if (!q) {
        await ctx.answerInlineQuery(
          [
            article(
              "hint",
              "Ask Crescent",
              "Type your question after @bot",
              `Type a question after @${botUsername()} then tap the result.\n\nExample: @${botUsername()} how should I reply?`,
            ),
          ],
          {
            cache_time: 30,
            is_personal: true,
            switch_pm_text: "Open Crescent",
            switch_pm_parameter: "inline",
          },
        );
        return;
      }

      // Quota
      const consumed = await consumeCrescentQuota(userId);
      if (!consumed.allowed) {
        await ctx.answerInlineQuery(
          [
            article(
              "quota",
              "Quota exceeded",
              formatCrescentQuota(consumed),
              `Quota exceeded — ${formatCrescentQuota(consumed)}\n\nOpen @${botUsername()} to upgrade or wait for reset.`,
            ),
          ],
          { cache_time: 15, is_personal: true },
        );
        return;
      }

      let reply: string;
      try {
        reply = await quickAnswer(q);
      } catch (err) {
        const timedOut =
          err instanceof Error && err.message === "inline_ai_timeout";
        logger.warn(
          { err, userId, ms: Date.now() - started, timedOut },
          "inline AI slow/fail",
        );
        await ctx.answerInlineQuery(
          [
            article(
              `slow-${Date.now()}`,
              timedOut ? "Still thinking — open bot" : "AI busy — open bot",
              "Tap to open Crescent for the full answer",
              timedOut
                ? `Crescent needs a bit longer for that question.\n\nOpen @${botUsername()} and ask there for the full reply.\n\nYour question:\n${q.slice(0, 300)}`
                : `Crescent is busy. Open @${botUsername()} and try /crescent.\n\nQ: ${q.slice(0, 200)}`,
            ),
          ],
          {
            cache_time: 1,
            is_personal: true,
            switch_pm_text: "Ask in Crescent",
            switch_pm_parameter: "inline_slow",
          },
        );
        return;
      }

      const body =
        `Crescent\n————————\n\n` +
        `Q: ${q.slice(0, 150)}${q.length > 150 ? "..." : ""}\n\n` +
        `${reply}\n\n` +
        `— @${botUsername()}`;

      await ctx.answerInlineQuery(
        [
          article(`ans-${Date.now()}`, "Crescent", reply.slice(0, 100), body),
          article(`raw-${Date.now()}`, "Answer only", "Plain reply", reply),
        ],
        { cache_time: 5, is_personal: true },
      );

      logger.info(
        { userId, ms: Date.now() - started, qLen: q.length },
        "inline ok",
      );
    } catch (err) {
      logger.error({ err, userId, q: q.slice(0, 80) }, "inline_query failed");
      try {
        await ctx.answerInlineQuery(
          [
            article(
              "err",
              "Try again",
              "Or open the bot",
              `Could not answer. Open @${botUsername()} and use /crescent.`,
            ),
          ],
          { cache_time: 1, is_personal: true },
        );
      } catch {
        /* ignore */
      }
    }
  });

  bot.on("chosen_inline_result", async (ctx) => {
    logger.info(
      {
        userId: ctx.from?.id,
        resultId: ctx.chosenInlineResult.result_id,
        query: ctx.chosenInlineResult.query?.slice(0, 80),
      },
      "inline result chosen",
    );
  });
}
