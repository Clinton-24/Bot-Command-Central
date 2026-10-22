import { InlineKeyboard } from "grammy";
import { eq } from "drizzle-orm";
import { sendMainMenu } from "./menu";
import {
  ensureAutoFreeAccess,
  growthWelcomeKeyboard,
  growthWelcomeText,
  parseReferralPayload,
  referralLink,
  applyReferralReward,
} from "./growth";
import { handleInviteCode } from "./access";
import { isOwner } from "../helpers";
import { db, usersTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { logger } from "../../lib/logger";

function displayName(from: { first_name?: string; username?: string }): string {
  if (from.username) return `@${from.username}`;
  return from.first_name ?? "there";
}

export function registerWelcomeHandler(bot: MyBot): void {
  bot.on("message:new_chat_members", async (ctx) => {
    const chatId = ctx.chat.id;
    for (const member of ctx.message.new_chat_members) {
      if (member.is_bot) continue;
      try {
        await db
          .insert(usersTable)
          .values({
            id: member.id,
            username: member.username ?? null,
            firstName: member.first_name ?? null,
          })
          .onConflictDoUpdate({
            target: usersTable.id,
            set: {
              username: member.username ?? null,
              firstName: member.first_name ?? null,
            },
          });
      } catch (err) {
        logger.warn({ err, chatId }, "new_chat_members user upsert failed");
      }
    }
  });

  const runWelcome = async (ctx: BotContext) => {
    const from = ctx.from;
    if (!from) return;

    try {
      await db
        .insert(usersTable)
        .values({
          id: from.id,
          username: from.username ?? null,
          firstName: from.first_name ?? null,
        })
        .onConflictDoUpdate({
          target: usersTable.id,
          set: {
            username: from.username ?? null,
            firstName: from.first_name ?? null,
          },
        });
    } catch (err) {
      logger.warn({ err }, "welcome user upsert failed");
    }

    const owner = isOwner(from.id);
    const payload = (ctx.match as string | undefined)?.trim() ?? "";

    if (payload && !payload.toLowerCase().startsWith("ref") && !owner) {
      try {
        await handleInviteCode(bot, ctx, payload);
        return;
      } catch {
        /* fall through to normal welcome */
      }
    }

    const inviterId = parseReferralPayload(payload);
    if (inviterId && !owner) {
      await applyReferralReward(
        bot,
        { id: from.id, username: from.username, firstName: from.first_name },
        inviterId,
      );
    }

    let isNew = false;
    if (!owner) {
      const status = await ensureAutoFreeAccess({
        id: from.id,
        username: from.username,
        firstName: from.first_name,
      }).catch(() => "already" as const);
      isNew = status === "created";
    }

    // Welcome only — main menu is opened via button or /menu
    const name = displayName(from);
    await ctx.reply(growthWelcomeText(name, isNew, owner), {
      parse_mode: "Markdown",
      reply_markup: growthWelcomeKeyboard(owner),
    });
  };

  // Primary welcome command
  bot.command("sharp", runWelcome);
  // Keep /start for Telegram deep links (invite / referral payloads)
  bot.command("start", runWelcome);

  bot.command("invite", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const link = referralLink(from.id);
    await ctx.reply(
      `🔗 Your invite link\n━━━━━━━━━━━━━━━━━━\n\n` +
        `${link}\n\n` +
        `• Friends get free access + Crescent AI\n` +
        `• You get +5 Crescent bonus per join\n` +
        `Share the link or use /menu after they join.`,
    );
  });

  bot.command("menu", async (ctx) => {
    await sendMainMenu(ctx);
  });

  bot.command("ping", async (ctx) => {
    const start = Date.now();
    const msg = await ctx.reply("🏓 pong");
    const elapsed = Date.now() - start;
    await ctx.api
      .editMessageText(ctx.chat!.id, msg.message_id, `🏓 pong — ${elapsed}ms`)
      .catch(() => {});
  });

  bot.command("id", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    await ctx.reply(
      `🆔 Your ID: \`${from.id}\`\n` +
        (from.username ? `Username: @${from.username}\n` : "") +
        `Chat: \`${ctx.chat?.id}\``,
      { parse_mode: "Markdown" },
    );
  });

  bot.command("report", async (ctx) => {
    const reason = (ctx.match as string | undefined)?.trim();
    if (!reason) {
      await ctx.reply("Usage: /report <reason>");
      return;
    }
    const ownerId = parseInt(process.env["BOT_OWNER_ID"] ?? "0", 10);
    if (!ownerId) {
      await ctx.reply("Report channel not configured.");
      return;
    }
    const from = ctx.from!;
    try {
      await bot.api.sendMessage(
        ownerId,
        `📣 REPORT\n━━━━━━━━━━━━━━━━━━\n\nFrom: ${from.first_name ?? ""} (@${from.username ?? "n/a"})\nID: ${from.id}\n\n${reason}`,
      );
      await ctx.reply("✅ Report sent to the owner.");
    } catch (err) {
      logger.error({ err }, "report failed");
      await ctx.reply("❌ Could not deliver report.");
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `📖 HELP\n━━━━━━━━━━━━━━━━━━\n\n` +
        `🚀 /sharp — Welcome\n` +
        `/menu — Main menu\n\n` +
        `🤖 CRESCENT\n` +
        `/crescent · /imagine · /briefing · /exit\n\n` +
        `🛒 SHOP\n` +
        `/orders · /myorders — Your orders\n\n` +
        `⏰ REMINDERS\n` +
        `/remind <time> <msg> · /reminders · /digest\n` +
        `/connect_gmail · /inbox\n\n` +
        `🩺 STATUS\n` +
        `/health · /ping · /id · /menu\n` +
        `/report <reason> — Report to admin\n`,
    );
  });
}
