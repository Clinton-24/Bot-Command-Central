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

  bot.command("start", async (ctx) => {
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
      logger.warn({ err }, "start user upsert failed");
    }

    const owner = isOwner(from.id);
    const payload = (ctx.match as string | undefined)?.trim() ?? "";

    if (payload && !payload.toLowerCase().startsWith("ref") && !owner) {
      try {
        await handleInviteCode(bot, ctx, payload);
        return;
      } catch {
        /* fall through to normal start */
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
  });

  bot.command("invite", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const link = referralLink(from.id);
    await ctx.reply(
      `🔗 Your invite link\n━━━━━━━━━━━━━━━━━━\n\n` +
        `${link}\n\n` +
        `• Friends get free access + Crescent AI\n` +
        `• You get +5 Crescent bonus per join\n` +
        `Unlimited invites.`,
      {
        reply_markup: new InlineKeyboard()
          .url("Share link", `https://t.me/share/url?url=${encodeURIComponent(link)}`)
          .row()
          .text("🏠 Main Menu", "menu:main"),
      },
    );
  });

  bot.callbackQuery("growth:invite", async (ctx) => {
    await ctx.answerCallbackQuery();
    const from = ctx.from;
    if (!from) return;
    const link = referralLink(from.id);
    await ctx.reply(
      `🔗 Your invite link\n\n${link}\n\nFriends get free access. You get +5 Crescent bonus per join.`,
      {
        reply_markup: new InlineKeyboard()
          .url("Share", `https://t.me/share/url?url=${encodeURIComponent(link)}`)
          .row()
          .text("🏠 Menu", "menu:main"),
      },
    );
  });

  bot.callbackQuery("growth:try_crescent", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!isOwner(ctx.from!.id)) {
      await ensureAutoFreeAccess({
        id: ctx.from!.id,
        username: ctx.from!.username,
        firstName: ctx.from!.first_name,
      }).catch(() => {});
    }
    ctx.session.crescentMode = true;
    ctx.session.pendingAction = "hexagon:input";
    await ctx.reply(
      `🤖 CRESCENT AI\n━━━━━━━━━━━━━━━━━━\n\nChat mode is on. Send a message.\n\n` +
        `• /exit — leave chat mode\n` +
        `• /briefing — daily briefing\n` +
        (isOwner(ctx.from!.id) ? "" : "• /invite — earn bonus queries"),
      {
        reply_markup: new InlineKeyboard()
          .text("🏠 Main Menu", "menu:main")
          .text("🚪 Exit chat", "crescent:exit"),
      },
    );
  });

  bot.command("menu", async (ctx) => {
    await sendMainMenu(ctx);
  });

  bot.command("ping", async (ctx) => {
    const start = Date.now();
    const msg = await ctx.reply("🏓 Pinging...");
    const elapsed = Date.now() - start;
    await ctx.api.editMessageText(
      ctx.chat.id,
      msg.message_id,
      `🏓 Pong!\n━━━━━━━━━━━━━━━━━━\n⚡ Response: ${elapsed}ms\n✅ Bot is online`,
    );
  });

  bot.command("id", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const chatType = ctx.chat.type;
    const isGroup = chatType === "group" || chatType === "supergroup";
    await ctx.reply(
      `🪪 Your Info\n━━━━━━━━━━━━━━━━━━\n` +
        `👤 Name: ${from.first_name}${from.last_name ? ` ${from.last_name}` : ""}\n` +
        `🆔 User ID: ${from.id}\n` +
        (from.username ? `📛 Username: @${from.username}\n` : "") +
        (isGroup
          ? `\n💬 Chat ID: ${ctx.chat.id}\n📂 Chat: ${(ctx.chat as { title?: string }).title ?? "Group"}`
          : ""),
    );
  });

  bot.command("report", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const reason = (ctx.match as string | undefined)?.trim() ?? "";
    if (!reason) {
      await ctx.reply("Usage: /report <reason>");
      return;
    }
    const ownerId = parseInt(process.env.BOT_OWNER_ID ?? "0");
    if (!ownerId) {
      await ctx.reply("Report received. Owner will review.");
      return;
    }
    try {
      await bot.api.sendMessage(
        ownerId,
        `🚨 REPORT\n━━━━━━━━━━━━━━━━━━\n\n` +
          `From: ${from.first_name} (${from.id})\n` +
          (from.username ? `@${from.username}\n` : "") +
          `\n${reason}`,
      );
      await ctx.reply("✅ Report sent to admin.");
    } catch (err) {
      logger.error({ err }, "report failed");
      await ctx.reply("❌ Failed to send report. Please try again.");
    }
  });

  bot.command("help", async (ctx) => {
    const owner = ctx.from ? isOwner(ctx.from.id) : false;
    await ctx.reply(
      `⚡ CRESCENT — COMMANDS\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🤖 CRESCENT AI\n` +
        `/crescent — Chat with Crescent\n` +
        `/briefing — Daily briefing\n` +
        `/imagine <prompt> — Generate image\n` +
        `/exit — Leave chat mode\n` +
        (owner ? "" : `/invite — Referral link (+5 bonus)\n`) +
        `\n🛒 SHOP\n` +
        `/shop · /buy — Open CardShop\n` +
        `/orders · /myorders — Your orders\n` +
        `\n⏰ REMINDERS\n` +
        `/remind <time> <msg> · /reminders · /digest\n` +
        `/connect_gmail · /inbox\n` +
        `\n🩺 STATUS\n` +
        `/health · /ping · /id · /menu\n` +
        `/report <reason> — Report to admin\n` +
        `\n💳 TIERS\n` +
        `/subscribe · /plans — Premium / VIP\n` +
        (owner
          ? `\n📢 OWNER\n/broadcast · /stats · /kill · /unkill\n/hex · /access · /online\n`
          : ""),
      {
        reply_markup: new InlineKeyboard()
          .text("🤖 Try Crescent", "growth:try_crescent")
          .text("🏠 Main Menu", "menu:main"),
      },
    );
  });
}
