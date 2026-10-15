/**
 * Crescent inline mode
 * Anyone in any chat types: @YourBot <question>
 * Both participants can do this — Telegram sends inline_query per user.
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

export function registerInlineCrescent(bot: Bot<BotContext>): void {
  bot.on("inline_query", async (ctx) => {
    const userId = ctx.from?.id;
    const q = (ctx.inlineQuery.query ?? "").trim();
    const qid = ctx.inlineQuery.id;

    try {
      if (!userId) {
        await ctx.answerInlineQuery([], { cache_time: 1, is_personal: true });
        return;
      }

      const access = await canUseInline(userId);
      if (!access.ok) {
        await ctx.answerInlineQuery(
          [
            article(
              "no-access",
              "Crescent — access required",
              access.reason ?? "Start the bot first",
              `Crescent\n\n${access.reason ?? "Open the bot and /start for free access."}\n\nt.me/${botUsername()}`,
            ),
          ],
          {
            cache_time: 5,
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
              "Ask Crescent anything",
              "Type your question after @bot…",
              `Crescent\n\nType a question after @${botUsername()} in any chat.\nExample: @${botUsername()} summarize this idea…\n\nBoth people in the chat can do this.`,
            ),
          ],
          {
            cache_time: 10,
            is_personal: true,
            switch_pm_text: "Open Crescent chat",
            switch_pm_parameter: "inline",
          },
        );
        return;
      }

      const consumed = await consumeCrescentQuota(userId);
      if (!consumed.allowed) {
        await ctx.answerInlineQuery(
          [
            article(
              "quota",
              "Quota exceeded",
              formatCrescentQuota(consumed),
              `Crescent quota exceeded\n${formatCrescentQuota(consumed)}\n\nResets midnight Nairobi · or upgrade in @${botUsername()}`,
            ),
          ],
          { cache_time: 5, is_personal: true },
        );
        return;
      }

      const response = await routeChat("chat", [
        {
          role: "system",
          content:
            "You are Crescent, a sharp AI assistant. Answer concisely for Telegram (under 800 characters). No markdown fences. Plain text.",
        },
        { role: "user", content: q },
      ]);

      const reply = (response.reply || "...").trim();
      const body =
        `Crescent\n————————\n\n` +
        `Q: ${q.slice(0, 200)}${q.length > 200 ? "..." : ""}\n\n` +
        `${reply}\n\n` +
        `— via @${botUsername()}`;

      const quota = await getCrescentQuotaStatus(userId);
      const quotaHint = quota.unlimited ? "Unlimited" : formatCrescentQuota(quota);

      await ctx.answerInlineQuery(
        [
          article(`ans-${Date.now()}`, "Crescent answer", reply.slice(0, 100), body),
          article(`raw-${Date.now()}`, "Answer only (no header)", quotaHint, reply.slice(0, 4096)),
        ],
        { cache_time: 2, is_personal: true },
      );
    } catch (err) {
      logger.error({ err, userId, qid, q: q.slice(0, 80) }, "inline_query failed");
      try {
        await ctx.answerInlineQuery(
          [
            article(
              "err",
              "Crescent error",
              "Try again or open the bot",
              `Crescent could not answer right now.\n\nOpen @${botUsername()} and try /crescent.`,
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
