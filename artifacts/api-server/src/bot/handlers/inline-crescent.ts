/**
 * Crescent inline — ALWAYS answer quickly; only burn quota on success.
 */
import type { Bot } from "grammy";
import type { InlineQueryResultArticle } from "grammy/types";
import { eq } from "drizzle-orm";
import { accessTable, db } from "@workspace/db";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";
import { routeChat } from "../../lib/model-router";
import {
  consumeCrescentQuota,
  formatCrescentQuota,
  getCrescentQuotaStatus,
  refundCrescentQuota,
} from "./crescent-quota";
import { botUsername } from "./growth";

const AI_MS = 2_500;

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

      // Check only — do NOT consume until AI succeeds
      const status = await getCrescentQuotaStatus(userId);
      if (!status.allowed) {
        await answer([
          article(
            "quota",
            "Quota exceeded",
            formatCrescentQuota(status),
            `Daily Crescent limit reached (${formatCrescentQuota(status)}).\nResets at midnight Nairobi.\n\nOr open @${botUsername()} to top up / upgrade.`,
          ),
        ]);
        return;
      }

      const reply = await aiOrTimeout(q);

      if (reply) {
        // Successful answer → count 1 query
        await consumeCrescentQuota(userId).catch(() => {});
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

      // Failed / timeout — do NOT consume quota
      await answer(
        [
          article(
            `slow${Date.now()}`,
            "Open Crescent for full answer",
            "No quota used — AI was slow",
            `Crescent is slow right now (no quota used).\n\nYour question:\n${q}\n\n→ Open @${botUsername()} and send it there.`,
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
