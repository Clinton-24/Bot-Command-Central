/**
 * ACCESS CONTROL SYSTEM
 * ──────────────────────────────────────────────────────────────────
 * Tiers:  free (approved) | premium | vip | blocked
 * Flow:   /start → request access → owner approves → user unlocked
 * Invites: owner generates codes → user starts with /start <code>
 * Guard:  checkAccess(ctx, "premium") → blocks if not high enough tier
 */

import { InlineKeyboard } from "grammy";
import { eq, desc, and } from "drizzle-orm";
import { db, accessTable, inviteCodesTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

// ── Tier hierarchy ────────────────────────────────────────────────────────────

const TIER_RANK: Record<string, number> = { free: 1, premium: 2, vip: 3 };
const TIER_EMOJI: Record<string, string> = { free: "🟢", premium: "💎", vip: "👑", blocked: "🚫" };
const TIER_LABEL: Record<string, string> = { free: "Free", premium: "Premium", vip: "VIP", blocked: "Blocked" };

export function tierRank(tier: string): number {
  return TIER_RANK[tier] ?? 0;
}

// ── Core access check ─────────────────────────────────────────────────────────

export async function checkAccess(
  ctx: BotContext,
  requiredTier: "free" | "premium" | "vip" = "free"
): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (isOwner(userId)) return true;

  try {
    const [record] = await db.select().from(accessTable).where(eq(accessTable.userId, userId));

    if (!record) {
      await sendRequestAccessMessage(ctx);
      return false;
    }

    if (record.tier === "blocked") {
      await ctx.reply(
        `🚫 *Access Denied*\n━━━━━━━━━━━━━━━━━━\n\nYour account has been blocked.\n${record.blockedReason ? `_Reason: ${record.blockedReason}_` : ""}`,
        { parse_mode: "Markdown" }
      );
      return false;
    }

    if (!record.isApproved) {
      if (record.isPending) {
        await ctx.reply(
          `⏳ *Pending Approval*\n━━━━━━━━━━━━━━━━━━\n\nYour access request is being reviewed.\n\n_You'll receive a notification once approved._`,
          { parse_mode: "Markdown" }
        );
      } else {
        await sendRequestAccessMessage(ctx);
      }
      return false;
    }

    // Check expiry
    if (record.expiresAt && record.expiresAt < new Date()) {
      await db.update(accessTable).set({ isApproved: false, isPending: false }).where(eq(accessTable.userId, userId));
      await ctx.reply(
        `⏰ *Access Expired*\n━━━━━━━━━━━━━━━━━━\n\nYour access has expired. Request renewal below.`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔑 Request Renewal", "access:request") }
      );
      return false;
    }

    // Check tier rank
    if (tierRank(record.tier) < tierRank(requiredTier)) {
      await ctx.reply(
        `💎 *${TIER_LABEL[requiredTier] ?? requiredTier} Required*\n━━━━━━━━━━━━━━━━━━\n\nThis feature requires *${TIER_LABEL[requiredTier]}* access.\nYour current tier: ${TIER_EMOJI[record.tier] ?? ""} *${TIER_LABEL[record.tier] ?? record.tier}*\n\n_Contact the owner to upgrade._`,
        { parse_mode: "Markdown" }
      );
      return false;
    }

    // Update last seen + message count
    await db.update(accessTable)
      .set({ lastSeenAt: new Date(), totalMessages: (record.totalMessages ?? 0) + 1 })
      .where(eq(accessTable.userId, userId))
      .catch(() => {});

    return true;
  } catch (err) {
    logger.error({ err }, "checkAccess error");
    return false;
  }
}

// ── Get user access record ────────────────────────────────────────────────────

export async function getAccess(userId: number) {
  const [record] = await db.select().from(accessTable).where(eq(accessTable.userId, userId));
  return record ?? null;
}

// ── Request access message ────────────────────────────────────────────────────

async function sendRequestAccessMessage(ctx: BotContext): Promise<void> {
  const name = ctx.from?.first_name ?? "User";
  await ctx.reply(
    `🔐 *ACCESS REQUIRED*\n━━━━━━━━━━━━━━━━━━\n\nWelcome, *${name}*.\n\nThis is a *private bot*. You need approval to access its features.\n\n_Submit a request and the owner will review it._`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🔑 Request Access", "access:request")
        .text("🎟️ I Have an Invite Code", "access:invite"),
    }
  );
}

// ── Notify owner of pending request ──────────────────────────────────────────

async function notifyOwnerRequest(bot: MyBot, userId: number, name: string, username: string | undefined, message: string): Promise<void> {
  const ownerIdStr = process.env["BOT_OWNER_ID"];
  if (!ownerIdStr) return;
  const ownerId = parseInt(ownerIdStr);
  try {
    await bot.api.sendMessage(
      ownerId,
      `🔔 *NEW ACCESS REQUEST*\n━━━━━━━━━━━━━━━━━━\n\n👤 *${name}*${username ? ` (@${username})` : ""}\n🆔 \`${userId}\`\n\n💬 _"${message}"_`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✅ Approve Free", `access:approve:${userId}:free`)
          .text("💎 Approve Premium", `access:approve:${userId}:premium`)
          .row()
          .text("👑 Approve VIP", `access:approve:${userId}:vip`)
          .text("🚫 Deny", `access:deny:${userId}`),
      }
    );
  } catch (err) {
    logger.error({ err }, "notifyOwnerRequest failed");
  }
}

// ── Invite code handler ───────────────────────────────────────────────────────

export async function handleInviteCode(bot: MyBot, ctx: BotContext, code: string): Promise<void> {
  const userId = ctx.from!.id;
  const name = ctx.from!.first_name ?? "User";

  try {
    const [invite] = await db.select().from(inviteCodesTable).where(eq(inviteCodesTable.code, code.toUpperCase()));

    if (!invite || !invite.isActive) {
      await ctx.reply("❌ *Invalid or expired invite code.*", { parse_mode: "Markdown" });
      return;
    }
    if (invite.expiresAt && invite.expiresAt < new Date()) {
      await ctx.reply("❌ *This invite code has expired.*", { parse_mode: "Markdown" });
      return;
    }
    if (invite.usedCount >= invite.maxUses) {
      await ctx.reply("❌ *This invite code has reached its usage limit.*", { parse_mode: "Markdown" });
      return;
    }

    // Upsert access record
    await db.insert(accessTable).values({
      userId,
      username: ctx.from!.username,
      firstName: name,
      tier: invite.tier,
      isApproved: true,
      isPending: false,
      approvedAt: new Date(),
      inviteCode: code.toUpperCase(),
    }).onConflictDoUpdate({
      target: accessTable.userId,
      set: { tier: invite.tier, isApproved: true, isPending: false, approvedAt: new Date(), inviteCode: code.toUpperCase() },
    });

    // Increment usage
    await db.update(inviteCodesTable)
      .set({ usedCount: invite.usedCount + 1 })
      .where(eq(inviteCodesTable.id, invite.id));

    if (invite.usedCount + 1 >= invite.maxUses) {
      await db.update(inviteCodesTable).set({ isActive: false }).where(eq(inviteCodesTable.id, invite.id));
    }

    const tierLabel = TIER_LABEL[invite.tier] ?? invite.tier;
    const tierEmoji = TIER_EMOJI[invite.tier] ?? "✅";

    await ctx.reply(
      `${tierEmoji} *Access Granted!*\n━━━━━━━━━━━━━━━━━━\n\nWelcome, *${name}*!\n\nTier: *${tierLabel}*\n\n_You now have full access. Use the menu below._`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("⚡ Open Bot Panel", "menu:main"),
      }
    );

    // Notify owner
    const ownerIdStr = process.env["BOT_OWNER_ID"];
    if (ownerIdStr) {
      await bot.api.sendMessage(
        parseInt(ownerIdStr),
        `✅ *Invite Used*\n\n👤 ${name}${ctx.from!.username ? ` (@${ctx.from!.username})` : ""}\n🎟️ Code: \`${code.toUpperCase()}\`\n${tierEmoji} Tier: ${tierLabel}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
  } catch (err) {
    logger.error({ err }, "handleInviteCode error");
    await ctx.reply("❌ Failed to process invite code.");
  }
}

// ── Access management panel (owner) ──────────────────────────────────────────

function accessPanelKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👥 All Users", "acl:users:all")
    .text("⏳ Pending", "acl:users:pending")
    .row()
    .text("💎 Premium", "acl:users:premium")
    .text("👑 VIP", "acl:users:vip")
    .row()
    .text("🚫 Blocked", "acl:users:blocked")
    .text("🎟️ Invite Codes", "acl:invites")
    .row()
    .text("➕ Generate Invite", "acl:invite:generate")
    .row()
    .text("🔙 Hex Panel", "hex:main");
}

// ── Register ──────────────────────────────────────────────────────────────────

export function registerAccessHandlers(bot: MyBot): void {
  // ── /start with optional invite code ──────────────────────────────────────
  // (Overrides welcome.ts /start — registered after so it takes priority via filter)
  bot.command("access", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.reply("⛔ Owner only."); return; }
    const pending = await db.select().from(accessTable).where(eq(accessTable.isPending, true));
    const all = await db.select().from(accessTable);
    const approved = all.filter((a) => a.isApproved);
    const blocked = all.filter((a) => a.tier === "blocked");

    await ctx.reply(
      `🔐 *ACCESS CONTROL*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `👥 Total users: *${all.length}*\n` +
      `✅ Approved: *${approved.length}*\n` +
      `⏳ Pending: *${pending.length}*\n` +
      `🚫 Blocked: *${blocked.length}*`,
      { parse_mode: "Markdown", reply_markup: accessPanelKeyboard() }
    );
  });

  // ── Request access callback ────────────────────────────────────────────────
  bot.callbackQuery("access:request", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "access:message";
    await ctx.reply(
      `💬 *REQUEST ACCESS*\n━━━━━━━━━━━━━━━━━━\n\nSend a short message explaining why you want access:\n\n_e.g. "Referred by @username" or "I'm a regular customer"_`,
      { parse_mode: "Markdown" }
    );
  });

  // ── Invite code callback ───────────────────────────────────────────────────
  bot.callbackQuery("access:invite", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "access:code";
    await ctx.reply(`🎟️ *INVITE CODE*\n\nSend your invite code:`, { parse_mode: "Markdown" });
  });

  // ── Owner: approve callback ────────────────────────────────────────────────
  bot.callbackQuery(/^access:approve:(\d+):(\w+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    const tier = ctx.match[2] as string;
    await ctx.answerCallbackQuery(`✅ Approving as ${tier}...`);

    try {
      await db.insert(accessTable).values({
        userId, tier, isApproved: true, isPending: false, approvedAt: new Date(), approvedBy: ctx.from.id,
      }).onConflictDoUpdate({
        target: accessTable.userId,
        set: { tier, isApproved: true, isPending: false, approvedAt: new Date(), approvedBy: ctx.from.id },
      });

      const emoji = TIER_EMOJI[tier] ?? "✅";
      const label = TIER_LABEL[tier] ?? tier;

      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
      await ctx.reply(`${emoji} Approved user \`${userId}\` as *${label}*.`, { parse_mode: "Markdown" });

      // Notify user
      await bot.api.sendMessage(userId,
        `${emoji} *Access Approved!*\n━━━━━━━━━━━━━━━━━━\n\nYour access request has been approved!\n\nTier: *${label}*\n\n_Welcome aboard. Tap below to open the bot._`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⚡ Open Bot Panel", "menu:main") }
      ).catch(() => {});
    } catch (err) {
      await ctx.reply(`❌ Error: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  });

  // ── Owner: deny callback ───────────────────────────────────────────────────
  bot.callbackQuery(/^access:deny:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    await ctx.answerCallbackQuery("🚫 Denied");

    await db.insert(accessTable).values({ userId, tier: "free", isApproved: false, isPending: false })
      .onConflictDoUpdate({ target: accessTable.userId, set: { isPending: false } });

    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    await ctx.reply(`🚫 Request from \`${userId}\` denied.`, { parse_mode: "Markdown" });

    await bot.api.sendMessage(userId,
      `🚫 *Access Denied*\n━━━━━━━━━━━━━━━━━━\n\nYour access request was not approved at this time.\n\n_You may reapply later._`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
  });

  // ── Owner: mark sold / upgrade callbacks ──────────────────────────────────
  bot.callbackQuery(/^acl:upgrade:(\d+):(\w+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    const tier = ctx.match[2] as string;
    await db.update(accessTable).set({ tier }).where(eq(accessTable.userId, userId));
    await ctx.answerCallbackQuery(`${TIER_EMOJI[tier]} Upgraded to ${TIER_LABEL[tier]}`);
    await ctx.reply(`${TIER_EMOJI[tier]} User \`${userId}\` upgraded to *${TIER_LABEL[tier]}*.`, { parse_mode: "Markdown" });
    await bot.api.sendMessage(userId,
      `${TIER_EMOJI[tier]} *Tier Upgraded!*\n\nYour tier has been upgraded to *${TIER_LABEL[tier]}*. Enjoy the new features!`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
  });

  bot.callbackQuery(/^acl:block:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    await db.update(accessTable).set({ tier: "blocked", isApproved: false, blockedAt: new Date() }).where(eq(accessTable.userId, userId));
    await ctx.answerCallbackQuery("🚫 Blocked");
    await ctx.reply(`🚫 User \`${userId}\` has been blocked.`, { parse_mode: "Markdown" });
  });

  // ── Access panel callbacks ─────────────────────────────────────────────────
  bot.callbackQuery("hex:access", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    const all = await db.select().from(accessTable);
    const pending = all.filter((a) => a.isPending);
    const approved = all.filter((a) => a.isApproved);
    const blocked = all.filter((a) => a.tier === "blocked");
    await ctx.editMessageText(
      `🔐 *ACCESS CONTROL*\n━━━━━━━━━━━━━━━━━━\n\n👥 Total: *${all.length}* · ✅ *${approved.length}* · ⏳ *${pending.length}* · 🚫 *${blocked.length}*`,
      { parse_mode: "Markdown", reply_markup: accessPanelKeyboard() }
    );
  });

  bot.callbackQuery(/^acl:users:(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    const filter = ctx.match[1] as string;

    const all = await db.select().from(accessTable).orderBy(desc(accessTable.createdAt)).limit(20);
    const filtered = filter === "all" ? all
      : filter === "pending" ? all.filter((a) => a.isPending)
      : filter === "blocked" ? all.filter((a) => a.tier === "blocked")
      : all.filter((a) => a.tier === filter && a.isApproved);

    const labels: Record<string, string> = { all: "ALL USERS", pending: "PENDING", premium: "PREMIUM", vip: "VIP", blocked: "BLOCKED" };

    const lines = filtered.length === 0 ? "_None._"
      : filtered.map((a) =>
        `${TIER_EMOJI[a.tier] ?? "⚪"} *${a.firstName ?? "Unknown"}*${a.username ? ` @${a.username}` : ""} \`${a.userId}\`\n` +
        `   ${a.isPending ? "⏳ Pending" : a.isApproved ? "✅ Approved" : "❌ Not approved"} · ${a.tier}\n` +
        `   Last seen: ${a.lastSeenAt ? new Date(a.lastSeenAt).toDateString() : "Never"}`
      ).join("\n\n");

    const kb = new InlineKeyboard().text("🔙 Back", "hex:access");
    await ctx.editMessageText(
      `🔐 *${labels[filter] ?? filter.toUpperCase()}*\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
  });

  // ── Invite codes panel ─────────────────────────────────────────────────────
  bot.callbackQuery("acl:invites", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    const codes = await db.select().from(inviteCodesTable).orderBy(desc(inviteCodesTable.createdAt)).limit(15);
    const lines = codes.length === 0 ? "_No codes generated yet._"
      : codes.map((c) =>
        `${c.isActive ? "🟢" : "🔴"} \`${c.code}\` — ${TIER_EMOJI[c.tier] ?? ""} ${c.tier} · ${c.usedCount}/${c.maxUses} uses${c.note ? ` · _${c.note}_` : ""}`
      ).join("\n");
    await ctx.editMessageText(
      `🎟️ *INVITE CODES*\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("➕ Generate", "acl:invite:generate").row().text("🔙 Back", "hex:access") }
    );
  });

  bot.callbackQuery("acl:invite:generate", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    ctx.session.pendingAction = "acl:generate_invite";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🎟️ *GENERATE INVITE CODE*\n━━━━━━━━━━━━━━━━━━\n\nSend details in format:\n\`TIER USES NOTE\`\n\nExamples:\n\`premium 1 For @username\`\n\`vip 3 Bulk access\`\n\`free 10 Open invite\`\n\n_Tiers: free · premium · vip_`,
      { parse_mode: "Markdown" }
    );
  });

  // ── /approve and /revoke commands ─────────────────────────────────────────
  bot.command("approve", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    const userId = parseInt(parts[0] ?? "");
    const tier = (parts[1] ?? "free") as string;
    if (isNaN(userId)) { await ctx.reply("Usage: /approve <userId> [tier]"); return; }

    await db.insert(accessTable).values({ userId, tier, isApproved: true, isPending: false, approvedAt: new Date(), approvedBy: ctx.from.id })
      .onConflictDoUpdate({ target: accessTable.userId, set: { tier, isApproved: true, isPending: false, approvedAt: new Date() } });

    await ctx.reply(`✅ User \`${userId}\` approved as *${TIER_LABEL[tier] ?? tier}*.`, { parse_mode: "Markdown" });
    await bot.api.sendMessage(userId, `✅ *Access Approved!*\n\nYou've been granted *${TIER_LABEL[tier] ?? tier}* access. Use /start to begin.`, { parse_mode: "Markdown" }).catch(() => {});
  });

  bot.command("revoke", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    const userId = parseInt(ctx.match?.trim() ?? "");
    if (isNaN(userId)) { await ctx.reply("Usage: /revoke <userId>"); return; }
    await db.update(accessTable).set({ isApproved: false, isPending: false }).where(eq(accessTable.userId, userId));
    await ctx.reply(`🚫 Access revoked for \`${userId}\`.`, { parse_mode: "Markdown" });
  });

  bot.command("block", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    const userId = parseInt(parts[0] ?? "");
    const reason = parts.slice(1).join(" ") || undefined;
    if (isNaN(userId)) { await ctx.reply("Usage: /block <userId> [reason]"); return; }
    await db.update(accessTable).set({ tier: "blocked", isApproved: false, blockedAt: new Date(), blockedReason: reason ?? null }).where(eq(accessTable.userId, userId));
    await ctx.reply(`🚫 User \`${userId}\` blocked.${reason ? `\nReason: ${reason}` : ""}`, { parse_mode: "Markdown" });
  });
}

// ── Input processor for access flows (called from menu.ts interceptor) ────────

export async function processAccessInput(bot: MyBot, ctx: BotContext, action: string, text: string): Promise<void> {
  const userId = ctx.from!.id;
  const name = ctx.from!.first_name ?? "User";

  if (action === "access:message") {
    // User submitting access request
    try {
      await db.insert(accessTable).values({
        userId,
        username: ctx.from!.username,
        firstName: name,
        tier: "free",
        isApproved: false,
        isPending: true,
        requestMessage: text.slice(0, 300),
      }).onConflictDoUpdate({
        target: accessTable.userId,
        set: { isPending: true, requestMessage: text.slice(0, 300), username: ctx.from!.username, firstName: name },
      });

      await ctx.reply(
        `✅ *Request Submitted*\n━━━━━━━━━━━━━━━━━━\n\nYour request has been sent to the owner.\n\n_You'll be notified once it's reviewed._`,
        { parse_mode: "Markdown" }
      );

      await notifyOwnerRequest(bot, userId, name, ctx.from!.username, text);
    } catch (err) {
      await ctx.reply(`❌ Failed: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  } else if (action === "access:code") {
    await handleInviteCode(bot, ctx, text.trim());
  } else if (action === "acl:generate_invite") {
    // Owner generating invite code
    const parts = text.trim().split(/\s+/);
    const tier = parts[0] ?? "free";
    const maxUses = parseInt(parts[1] ?? "1");
    const note = parts.slice(2).join(" ") || undefined;

    const validTiers = ["free", "premium", "vip"];
    if (!validTiers.includes(tier)) {
      await ctx.reply(`❌ Invalid tier. Use: free · premium · vip`);
      return;
    }

    // Generate random code
    const code = Array.from({ length: 8 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");

    await db.insert(inviteCodesTable).values({
      code,
      tier,
      maxUses: isNaN(maxUses) ? 1 : maxUses,
      createdBy: userId,
      note: note ?? null,
      isActive: true,
    });

    await ctx.reply(
      `🎟️ *INVITE CODE CREATED*\n━━━━━━━━━━━━━━━━━━\n\nCode: \`${code}\`\n${TIER_EMOJI[tier] ?? ""} Tier: *${TIER_LABEL[tier] ?? tier}*\nMax uses: *${isNaN(maxUses) ? 1 : maxUses}*${note ? `\nNote: ${note}` : ""}\n\n_Share via: /start ${code}_`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🎟️ Invite Codes", "acl:invites") }
    );
  }
}
