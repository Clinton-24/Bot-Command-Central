import { InlineKeyboard } from "grammy";
import type { MyBot } from "../index";
import { sendMainMenu } from "./menu";
import { db } from "@workspace/db";
import { usersTable, groupSettingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { isOwner } from "../helpers";
import { handleInviteCode } from "./access";
import {
  applyReferralReward,
  ensureAutoFreeAccess,
  growthWelcomeKeyboard,
  growthWelcomeText,
  parseReferralPayload,
  referralLink,
} from "./growth";

export function registerWelcomeHandler(bot: MyBot): void {
  bot.on("message:new_chat_members", async (ctx) => {
    const chatId = ctx.chat.id;
    const newMembers = ctx.message.new_chat_members;
    const groupName = ctx.chat.title ?? "this group";

    try {
      const [settings] = await db
        .select()
        .from(groupSettingsTable)
        .where(eq(groupSettingsTable.chatId, chatId));

      for (const member of newMembers) {
        if (member.is_bot) continue;
        await db
          .insert(usersTable)
          .values({
            id: member.id,
            username: member.username,
            firstName: member.first_name,
            lastName: member.last_name,
          })
          .onConflictDoUpdate({
            target: usersTable.id,
            set: { username: member.username, firstName: member.first_name, lastName: member.last_name },
          });

        const name = member.first_name || member.username || "User";
        const username = member.username ? `@${member.username}` : name;

        if (settings?.welcomeMessage) {
          const msg = settings.welcomeMessage
            .replace(/\{name\}/g, name)
            .replace(/\{username\}/g, username)
            .replace(/\{group\}/g, groupName);

          const kb = new InlineKeyboard();
          if (settings.groupRules) {
            kb.text("📜 Group Rules", `welcome:rules:${chatId}`);
          }

          await ctx.reply(msg, {
            parse_mode: "Markdown",
            reply_markup: settings.groupRules ? kb : undefined,
          }).catch(() => {});
        } else {
          const defaultMsg =
            `👋 Welcome to *${groupName}*, ${name}!\n\n` +
            `We're glad to have you here. Please read the rules and enjoy your stay.`;

          const kb = new InlineKeyboard();
          if (settings?.groupRules) {
            kb.text("📜 Group Rules", `welcome:rules:${chatId}`);
          }

          await ctx.reply(defaultMsg, {
            parse_mode: "Markdown",
            reply_markup: settings?.groupRules ? kb : undefined,
          }).catch(() => {});
        }
      }
    } catch (err) {
      logger.error({ err }, "welcome handler error");
    }
  });

  bot.callbackQuery(/^welcome:rules:(-?\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const chatId = parseInt(ctx.match[1]!);
    try {
      const [settings] = await db
        .select()
        .from(groupSettingsTable)
        .where(eq(groupSettingsTable.chatId, chatId));

      if (settings?.groupRules) {
        await ctx.reply(
          `📜 *Group Rules*\n━━━━━━━━━━━━━━━━━━\n\n${settings.groupRules}`,
          { parse_mode: "Markdown" }
        );
      } else {
        await ctx.answerCallbackQuery("No rules set for this group.");
      }
    } catch (err) {
      logger.error({ err }, "rules callback error");
    }
  });

  bot.command("start", async (ctx) => {
    const from = ctx.from;
    if (!from) return;

    try {
      await db.insert(usersTable).values({
        id: from.id, username: from.username,
        firstName: from.first_name, lastName: from.last_name,
      }).onConflictDoUpdate({
        target: usersTable.id,
        set: { username: from.username, firstName: from.first_name, lastName: from.last_name },
      });
    } catch (err) {
      logger.error({ err }, "start: failed to save user");
    }

    const payload = ctx.match?.trim() ?? "";
    const name = from.first_name ?? "there";

    if (payload.startsWith("tier_subscription_")) {
      await sendMainMenu(ctx);
      return;
    }

    const inviterId = parseReferralPayload(payload);
    if (inviterId && !isOwner(from.id)) {
      const rewarded = await applyReferralReward(
        bot,
        { id: from.id, username: from.username, firstName: from.first_name },
        inviterId,
      );
      if (!rewarded) {
        await ensureAutoFreeAccess({
          id: from.id,
          username: from.username,
          firstName: from.first_name,
        });
      }
      await ctx.reply(growthWelcomeText(name, true), {
        parse_mode: "Markdown",
        reply_markup: growthWelcomeKeyboard(),
      });
      return;
    }

    if (payload.length > 0 && !isOwner(from.id)) {
      await handleInviteCode(bot, ctx, payload);
      return;
    }

    let isNew = false;
    if (!isOwner(from.id)) {
      const status = await ensureAutoFreeAccess({
        id: from.id,
        username: from.username,
        firstName: from.first_name,
      });
      isNew = status === "created";
      if (status === "blocked") {
        await ctx.reply("🚫 Your account is blocked. Contact the owner if this is a mistake.");
        return;
      }
    }

    await ctx.reply(growthWelcomeText(name, isNew || isOwner(from.id)), {
      parse_mode: "Markdown",
      reply_markup: growthWelcomeKeyboard(),
    });
  });

  bot.command("invite", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const link = referralLink(from.id);
    await ctx.reply(
      `🔗 *Your invite link*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `\`${link}\`\n\n` +
        `Share it. When someone joins:\n` +
        `• They get *free* access + Crescent AI\n` +
        `• You get *+5 bonus* Crescent queries\n\n` +
        `_Unlimited invites._`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .url("📤 Share link", `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Try this AI secretary bot:")}`)
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
      `🔗 *Your invite link*\n\n\`${link}\`\n\n` +
        `Friends get free access. You get +5 Crescent bonus per join.`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .url("📤 Share", `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Try this AI secretary bot:")}`)
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
      });
    }
    ctx.session.crescentMode = true;
    ctx.session.pendingAction = undefined;
    await ctx.reply(
      `🤖 *Crescent is listening*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Send any message or photo.\n` +
        `• /exit — leave chat mode\n` +
        `• /briefing — daily briefing\n` +
        `• /invite — earn bonus queries`,
      {
        parse_mode: "Markdown",
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
      `🏓 *Pong!*\n━━━━━━━━━━━━━━━━━━\n⚡ Response: ${elapsed}ms\n✅ Bot is online`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("id", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const chatType = ctx.chat.type;
    const isGroup = chatType === "group" || chatType === "supergroup";
    await ctx.reply(
      `🪪 *Your Info*\n━━━━━━━━━━━━━━━━━━\n` +
        `👤 Name: ${from.first_name}${from.last_name ? ` ${from.last_name}` : ""}\n` +
        `🆔 User ID: \`${from.id}\`\n` +
        (from.username ? `📛 Username: @${from.username}\n` : "") +
        (isGroup ? `\n💬 Chat ID: \`${ctx.chat.id}\`\n📂 Chat: ${(ctx.chat as { title?: string }).title ?? "Group"}` : ""),
      { parse_mode: "Markdown" }
    );
  });

  bot.command("report", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    const reason = ctx.match?.trim();
    if (!reason) {
      await ctx.reply("Usage: /report <reason>\n\nExample: /report Spam in group");
      return;
    }

    const ownerIdStr = process.env["BOT_OWNER_ID"];
    if (!ownerIdStr) {
      await ctx.reply("⚠️ Report system not configured.");
      return;
    }

    const ownerId = parseInt(ownerIdStr, 10);
    const chatInfo = ctx.chat.type !== "private"
      ? `\n💬 Chat: ${(ctx.chat as { title?: string }).title ?? "Unknown"} (\`${ctx.chat.id}\`)`
      : "";

    try {
      await ctx.api.sendMessage(
        ownerId,
        `🚨 *USER REPORT*\n━━━━━━━━━━━━━━━━━━\n\n` +
          `👤 From: ${from.first_name}${from.username ? ` (@${from.username})` : ""}\n` +
          `🆔 ID: \`${from.id}\`${chatInfo}\n\n` +
          `📝 Reason:\n${reason}`,
        { parse_mode: "Markdown" }
      );
      await ctx.reply("✅ Your report has been sent to the admin. Thank you!");
    } catch (err) {
      logger.error({ err }, "report command error");
      await ctx.reply("❌ Failed to send report. Please try again.");
    }
  });

  bot.command("help", async (ctx) => {
    await ctx.reply(
      `⚡ *FULL COMMAND LIST*\n` +
        `━━━━━━━━━━━━━━━━━━\n\n` +
        `🛍️ *CARDSHOP*\n` +
        `/shop — Open the CardShop\n` +
        `/myorders — View your orders\n\n` +
        `🤖 *CRESCENT AI*\n` +
        `/crescent — Chat with Crescent\n` +
        `/invite — Your referral link (+5 bonus)\n` +
        `/briefing — Daily briefing\n\n` +
        `🛠️ *GENERAL*\n` +
        `/ping — Latency check\n` +
        `/id — Your Telegram ID\n` +
        `/menu — Main menu\n` +
        `/report <reason> — Report to admin\n\n` +
        `📢 *OWNER*\n` +
        `/broadcast · /stats · /hex · /access`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("🤖 Try Crescent", "growth:try_crescent")
          .text("🏠 Main Menu", "menu:main"),
      }
    );
  });
}
