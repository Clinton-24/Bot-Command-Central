/**
 * ACCESS CONTROL SYSTEM
 * ─────────────────────────────────────────────────────────────────────────────
 * Tiers:   free | premium | vip | blocked
 * Flow:    /start → gate → request access → owner approves → unlocked
 * Invites: owner generates codes → user uses /start <code> → instant access
 * Guard:   checkAccess(ctx, "premium") → blocks if tier too low
 */

import { InlineKeyboard } from "grammy";
import { eq, desc } from "drizzle-orm";
import { db, accessTable, inviteCodesTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

// Sanitise user text — strip chars that break Telegram Markdown v1
function esc(t: string | undefined | null): string {
  if (!t) return "";
  return t.replace(/\*/g, "").replace(/_/g, "").replace(/`/g, "").replace(/\[/g, "(").replace(/\]/g, ")");
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TIER_RANK: Record<string, number> = { free: 1, premium: 2, vip: 3 };
export const TIER_EMOJI: Record<string, string> = { free: "🟢", premium: "💎", vip: "👑", blocked: "🚫" };
export const TIER_LABEL: Record<string, string> = { free: "Free", premium: "Premium", vip: "VIP", blocked: "Blocked" };

export function tierRank(tier: string): number {
  return TIER_RANK[tier] ?? 0;
}

// ── Get user record ───────────────────────────────────────────────────────────

export async function getAccess(userId: number) {
  try {
    const [record] = await db.select().from(accessTable).where(eq(accessTable.userId, userId));
    return record ?? null;
  } catch {
    return null;
  }
}

// ── Core access guard ─────────────────────────────────────────────────────────

export async function checkAccess(
  ctx: BotContext,
  requiredTier: "free" | "premium" | "vip" = "free"
): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (isOwner(userId)) return true;

  try {
    const record = await getAccess(userId);

    if (!record) { await showAccessGate(ctx); return false; }

    if (record.tier === "blocked") {
      await ctx.reply(
        `🚫 *Access Denied*\n━━━━━━━━━━━━━━━━━━\n\nYour account has been blocked.${record.blockedReason ? `\n_Reason: ${record.blockedReason}_` : ""}`,
        { parse_mode: "Markdown" }
      );
      return false;
    }

    if (!record.isApproved) {
      if (record.isPending) {
        await ctx.reply(
          `⏳ *Pending Approval*\n━━━━━━━━━━━━━━━━━━\n\nYour request is being reviewed.\n\n_You'll be notified once approved._`,
          { parse_mode: "Markdown" }
        );
      } else {
        await showAccessGate(ctx);
      }
      return false;
    }

    if (record.expiresAt && record.expiresAt < new Date()) {
      await db.update(accessTable).set({ isApproved: false, isPending: false }).where(eq(accessTable.userId, userId));
      await ctx.reply(
        `⏰ *Access Expired*\n━━━━━━━━━━━━━━━━━━\n\nYour access has expired.`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔑 Request Renewal", "access:request") }
      );
      return false;
    }

    if (tierRank(record.tier) < tierRank(requiredTier)) {
      await ctx.reply(
        `💎 *${TIER_LABEL[requiredTier]} Required*\n━━━━━━━━━━━━━━━━━━\n\nThis feature requires *${TIER_LABEL[requiredTier]}* access.\nYour tier: ${TIER_EMOJI[record.tier] ?? ""} *${TIER_LABEL[record.tier] ?? record.tier}*\n\n_Contact the owner to upgrade._`,
        { parse_mode: "Markdown" }
      );
      return false;
    }

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

export async function checkCrescentAccess(ctx: BotContext): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!userId) return false;
  if (isOwner(userId)) return true;
  try {
    const record = await getAccess(userId);
    if (record?.tier === "blocked") {
      await ctx.reply(`🚫 *Access Denied*\n\nYour account has been blocked.`, { parse_mode: "Markdown" });
      return false;
    }
    if (record) {
      await db.update(accessTable)
        .set({ lastSeenAt: new Date(), totalMessages: (record.totalMessages ?? 0) + 1 })
        .where(eq(accessTable.userId, userId)).catch(() => {});
    }
    return true;
  } catch { return true; }
}

// ── Access gate ───────────────────────────────────────────────────────────────

async function showAccessGate(ctx: BotContext): Promise<void> {
  const name = ctx.from?.first_name ?? "User";
  const text =
    `🔐 *ACCESS REQUIRED*\n━━━━━━━━━━━━━━━━━━\n\n` +
    `Welcome, *${esc(name)}*.\n\n` +
    `This is a *private bot*. You need approval to access its features.\n\n` +
    `_Submit a request and the owner will review it._`;
  const kb = new InlineKeyboard()
    .text("🔑 Request Access", "access:request")
    .text("🎟️ I Have an Invite Code", "access:invite");

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb }).catch(() =>
      ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb })
    );
    await ctx.answerCallbackQuery().catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  }
}

// ── Notify owner ──────────────────────────────────────────────────────────────

async function notifyOwner(bot: MyBot, userId: number, name: string, username: string | undefined, message: string): Promise<void> {
  const ownerIdStr = process.env["BOT_OWNER_ID"];
  logger.info({ ownerIdStr, userId, name, username }, "notifyOwnerRequest called");
  
  if (!ownerIdStr) {
    logger.warn("BOT_OWNER_ID not set — cannot notify owner of access request");
    return;
  }
  const ownerId = parseInt(ownerIdStr);
  
  // Generate temporary 6-digit code valid for 1 minute
  const tempCode = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 60000); // 1 minute from now
  
  // Store temporary code in database
  try {
    await db.insert(accessTable).values({
      userId,
      username: username ?? null,
      firstName: name,
      tier: "free",
      isApproved: false,
      isPending: true,
      requestMessage: message.slice(0, 300),
      inviteCode: tempCode,
      expiresAt,
    }).onConflictDoUpdate({
      target: accessTable.userId,
      set: { 
        isPending: true, 
        requestMessage: message.slice(0, 300), 
        username: username ?? null, 
        firstName: name,
        inviteCode: tempCode,
        expiresAt,
      },
    });
  } catch (err) {
    logger.error({ err }, "Failed to store temporary code");
  }
  
  logger.info({ ownerId, userId, tempCode }, "Sending owner notification with temporary code");
  
  try {
    await bot.api.sendMessage(
      ownerId,
      `🔔 *Access Request*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `👤 ${name}${username ? ` (@${esc(username)})` : ""}\n🆔 \`${userId}\`\n\n💬 "${message.slice(0, 100)}${message.length > 100 ? '...' : ''}"\n\n` +
      `🔑 Temporary Code: \`${tempCode}\`\n⏰ Valid for 1 minute`,
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
    logger.info({ ownerId, userId }, "Owner notification sent successfully");
  } catch (err) {
    logger.error({ err, ownerId, userId }, "notifyOwnerRequest failed");
  }
}

// ── Invite code ───────────────────────────────────────────────────────────────

export async function handleInviteCode(bot: MyBot, ctx: BotContext, code: string): Promise<void> {
  const userId = ctx.from!.id;
  const name = ctx.from!.first_name ?? "User";
  const inputCode = code.trim();

  try {
    // First check if it's a temporary 6-digit code from access request
    if (/^\d{6}$/.test(inputCode)) {
      const [accessRecord] = await db.select().from(accessTable).where(eq(accessTable.userId, userId));
      
      if (accessRecord && accessRecord.inviteCode === inputCode && accessRecord.expiresAt && accessRecord.expiresAt > new Date()) {
        // Valid temporary code within time window
        await db.update(accessTable).set({
          isApproved: true,
          isPending: false,
          approvedAt: new Date(),
          approvedBy: parseInt(process.env["BOT_OWNER_ID"] || "0"),
          expiresAt: null, // Clear expiry since access is now granted
        }).where(eq(accessTable.userId, userId));

        await ctx.reply(
          `✅ *Access Granted!*\n━━━━━━━━━━━━━━━━━━\n\nWelcome, *${esc(name)}*!\n\n_You now have full access._`,
          { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⚡ Open Bot Panel", "menu:main") }
        );

        const ownerIdStr = process.env["BOT_OWNER_ID"];
        if (ownerIdStr) {
          await bot.api.sendMessage(parseInt(ownerIdStr),
            `✅ *Access Granted*\n\n👤 ${name}${ctx.from!.username ? ` (@${esc(ctx.from!.username)})` : ""}\n🆔 \`${userId}\`\n🔑 Used code: \`${inputCode}\``,
            { parse_mode: "Markdown" }
          ).catch(() => {});
        }
        return;
      } else if (accessRecord && accessRecord.inviteCode === inputCode) {
        await ctx.reply("❌ *Code expired.*\n\nThe temporary code has expired. Please request access again.", { parse_mode: "Markdown" });
        return;
      } else {
        await ctx.reply("❌ *Invalid code.*\n\nThis code doesn't match your request.", { parse_mode: "Markdown" });
        return;
      }
    }

    // Handle regular invite codes (uppercase alphanumeric)
    const upper = inputCode.toUpperCase();
    const [invite] = await db.select().from(inviteCodesTable).where(eq(inviteCodesTable.code, upper));

    if (!invite || !invite.isActive) { await ctx.reply("❌ *Invalid or expired invite code.*", { parse_mode: "Markdown" }); return; }
    if (invite.expiresAt && invite.expiresAt < new Date()) { await ctx.reply("❌ *This invite code has expired.*", { parse_mode: "Markdown" }); return; }
    if (invite.usedCount >= invite.maxUses) { await ctx.reply("❌ *This invite code has reached its usage limit.*", { parse_mode: "Markdown" }); return; }

    await db.insert(accessTable).values({
      userId, username: ctx.from!.username, firstName: name,
      tier: invite.tier, isApproved: true, isPending: false,
      approvedAt: new Date(), inviteCode: upper,
    }).onConflictDoUpdate({
      target: accessTable.userId,
      set: { tier: invite.tier, isApproved: true, isPending: false, approvedAt: new Date(), inviteCode: upper },
    });

    await db.update(inviteCodesTable).set({ usedCount: invite.usedCount + 1 }).where(eq(inviteCodesTable.id, invite.id));
    if (invite.usedCount + 1 >= invite.maxUses) {
      await db.update(inviteCodesTable).set({ isActive: false }).where(eq(inviteCodesTable.id, invite.id));
    }

    const emoji = TIER_EMOJI[invite.tier] ?? "✅";
    const label = TIER_LABEL[invite.tier] ?? invite.tier;

    await ctx.reply(
      `${emoji} *Access Granted!*\n━━━━━━━━━━━━━━━━━━\n\nWelcome, *${esc(name)}*!\n\nTier: *${label}*\n\n_You now have full access._`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⚡ Open Bot Panel", "menu:main") }
    );

    const ownerIdStr = process.env["BOT_OWNER_ID"];
    if (ownerIdStr) {
      await bot.api.sendMessage(parseInt(ownerIdStr),
        `✅ *Invite Used*\n\n👤 ${name}${ctx.from!.username ? ` (@${esc(ctx.from!.username)})` : ""}\n🎟️ Code: \`${upper}\`\n${emoji} Tier: ${label}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
  } catch (err) {
    logger.error({ err }, "handleInviteCode error");
    await ctx.reply("❌ Failed to process code. Please try again.");
  }
}

// ── Owner panel keyboard ──────────────────────────────────────────────────────

function accessPanelKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👥 All Users", "acl:users:all").text("⏳ Pending", "acl:users:pending").row()
    .text("💎 Premium", "acl:users:premium").text("👑 VIP", "acl:users:vip").row()
    .text("🚫 Blocked", "acl:users:blocked").text("🎟️ Invite Codes", "acl:invites").row()
    .text("➕ Generate Invite", "acl:invite:generate").row()
    .text("🔙 Hex Panel", "hex:main");
}

// ── Register ──────────────────────────────────────────────────────────────────

export function registerAccessHandlers(bot: MyBot): void {

  bot.command("access", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.reply("⛔ Owner only."); return; }
    try {
      const all = await db.select().from(accessTable);
      const p = all.filter((a) => a.isPending).length;
      const a = all.filter((a) => a.isApproved).length;
      const b = all.filter((a) => a.tier === "blocked").length;
      await ctx.reply(
        `🔐 *ACCESS CONTROL*\n━━━━━━━━━━━━━━━━━━\n\n👥 Total: *${all.length}*\n✅ Approved: *${a}*\n⏳ Pending: *${p}*\n🚫 Blocked: *${b}*`,
        { parse_mode: "Markdown", reply_markup: accessPanelKeyboard() }
      );
    } catch (err) { await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`); }
  });

  bot.callbackQuery("access:request", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "access:message";
    await ctx.reply(
      `💬 *REQUEST ACCESS*\n━━━━━━━━━━━━━━━━━━\n\nSend a short message explaining why you want access:\n\n_e.g. "Referred by @username" or "I'm a regular customer"_`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("❌ Cancel", "menu:main") }
    );
  });

  bot.callbackQuery("access:invite", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "access:code";
    await ctx.reply(
      `🎟️ *INVITE CODE*\n━━━━━━━━━━━━━━━━━━\n\nSend your invite code:`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("❌ Cancel", "menu:main") }
    );
  });

  bot.callbackQuery(/^access:approve:(\d+):(\w+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    const tier = ctx.match[2]!;
    await ctx.answerCallbackQuery(`✅ Approving...`);
    try {
      await db.insert(accessTable).values({
        userId, tier, isApproved: true, isPending: false, approvedAt: new Date(), approvedBy: ctx.from.id,
      }).onConflictDoUpdate({
        target: accessTable.userId,
        set: { tier, isApproved: true, isPending: false, approvedAt: new Date(), approvedBy: ctx.from.id },
      });

      const emoji = TIER_EMOJI[tier] ?? "✅";
      const label = TIER_LABEL[tier] ?? tier;
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
      await ctx.reply(`${emoji} Approved \`${userId}\` as *${label}*.`, { parse_mode: "Markdown" });
      await bot.api.sendMessage(userId,
        `${emoji} *Access Approved!*\n━━━━━━━━━━━━━━━━━━\n\nYour request has been approved!\n\nTier: *${label}*\n\n_Welcome aboard!_`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⚡ Open Bot Panel", "menu:main") }
      ).catch(() => {});
    } catch (err) { await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`); }
  });

  bot.callbackQuery(/^access:deny:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    await ctx.answerCallbackQuery("🚫 Denied");
    try {
      await db.insert(accessTable).values({ userId, tier: "free", isApproved: false, isPending: false })
        .onConflictDoUpdate({ target: accessTable.userId, set: { isPending: false } });
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
      await ctx.reply(`🚫 Request from \`${userId}\` denied.`, { parse_mode: "Markdown" });
      await bot.api.sendMessage(userId,
        `🚫 *Access Denied*\n━━━━━━━━━━━━━━━━━━\n\nYour request was not approved at this time.\n\n_You may reapply later._`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔑 Try Again", "access:request") }
      ).catch(() => {});
    } catch (err) { await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`); }
  });

  bot.callbackQuery(/^acl:upgrade:(\d+):(\w+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    const tier = ctx.match[2]!;
    await db.update(accessTable).set({ tier }).where(eq(accessTable.userId, userId));
    await ctx.answerCallbackQuery(`${TIER_EMOJI[tier]} Upgraded`);
    await ctx.reply(`${TIER_EMOJI[tier]} \`${userId}\` → *${TIER_LABEL[tier] ?? tier}*.`, { parse_mode: "Markdown" });
    await bot.api.sendMessage(userId, `${TIER_EMOJI[tier]} *Tier Upgraded!*\n\nYou've been upgraded to *${TIER_LABEL[tier] ?? tier}*!`, { parse_mode: "Markdown" }).catch(() => {});
  });

  bot.callbackQuery(/^acl:block:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    await db.update(accessTable).set({ tier: "blocked", isApproved: false, blockedAt: new Date() }).where(eq(accessTable.userId, userId));
    await ctx.answerCallbackQuery("🚫 Blocked");
    await ctx.reply(`🚫 \`${userId}\` blocked.`, { parse_mode: "Markdown" });
  });

  bot.callbackQuery("hex:access", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    try {
      const all = await db.select().from(accessTable);
      const p = all.filter((a) => a.isPending).length;
      const a = all.filter((a) => a.isApproved).length;
      const b = all.filter((a) => a.tier === "blocked").length;
      await ctx.editMessageText(
        `🔐 *ACCESS CONTROL*\n━━━━━━━━━━━━━━━━━━\n\n👥 Total: *${all.length}* · ✅ *${a}* · ⏳ *${p}* · 🚫 *${b}*`,
        { parse_mode: "Markdown", reply_markup: accessPanelKeyboard() }
      );
    } catch (err) { await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`); }
  });

  bot.callbackQuery(/^acl:users:(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    try {
      const filter = ctx.match[1]!;
      const all = await db.select().from(accessTable).orderBy(desc(accessTable.createdAt)).limit(20);
      const filtered = filter === "all" ? all
        : filter === "pending" ? all.filter((a) => a.isPending)
        : filter === "blocked" ? all.filter((a) => a.tier === "blocked")
        : all.filter((a) => a.tier === filter && a.isApproved);

      const titles: Record<string, string> = {
        all: "ALL USERS", pending: "PENDING REQUESTS",
        premium: "PREMIUM USERS", vip: "VIP USERS", blocked: "BLOCKED USERS",
      };

      const lines = filtered.length === 0 ? "_None._"
        : filtered.map((a) =>
          `${TIER_EMOJI[a.tier] ?? "⚪"} *${esc(a.firstName ?? "Unknown")}*${a.username ? ` @${esc(a.username)}` : ""} \`${a.userId}\`\n` +
          `   ${a.isPending ? "⏳ Pending" : a.isApproved ? "✅ Approved" : "❌ Not approved"} · ${a.tier}\n` +
          `   Last seen: ${a.lastSeenAt ? new Date(a.lastSeenAt).toDateString() : "Never"}`
        ).join("\n\n");

      await ctx.editMessageText(
        `🔐 *${titles[filter] ?? filter.toUpperCase()}*\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Back", "hex:access") }
      );
    } catch (err) { await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`); }
  });

  bot.callbackQuery("acl:invites", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    try {
      const codes = await db.select().from(inviteCodesTable).orderBy(desc(inviteCodesTable.createdAt)).limit(15);
      const lines = codes.length === 0 ? "_No codes yet._"
        : codes.map((c) =>
          `${c.isActive ? "🟢" : "🔴"} \`${c.code}\` — ${TIER_EMOJI[c.tier] ?? ""} ${c.tier} · ${c.usedCount}/${c.maxUses} uses${c.note ? ` · _${c.note}_` : ""}`
        ).join("\n");
      await ctx.editMessageText(
        `🎟️ *INVITE CODES*\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("➕ Generate", "acl:invite:generate").row().text("🔙 Back", "hex:access") }
      );
    } catch (err) { await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`); }
  });

  bot.callbackQuery("acl:invite:generate", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    ctx.session.pendingAction = "acl:generate_invite";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🎟️ *GENERATE INVITE CODE*\n━━━━━━━━━━━━━━━━━━\n\nSend in format:\n\`TIER USES NOTE\`\n\nExamples:\n\`premium 1 For @username\`\n\`vip 3 Bulk access\`\n\`free 10 Open invite\`\n\n_Tiers: free · premium · vip_`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("approve", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return;
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    const userId = parseInt(parts[0] ?? "");
    const tier = parts[1] ?? "free";
    if (isNaN(userId)) { await ctx.reply("Usage: /approve <userId> [free|premium|vip]"); return; }
    await db.insert(accessTable).values({ userId, tier, isApproved: true, isPending: false, approvedAt: new Date(), approvedBy: ctx.from.id })
      .onConflictDoUpdate({ target: accessTable.userId, set: { tier, isApproved: true, isPending: false, approvedAt: new Date() } });
    await ctx.reply(`✅ \`${userId}\` approved as *${TIER_LABEL[tier] ?? tier}*.`, { parse_mode: "Markdown" });
    await bot.api.sendMessage(userId, `✅ *Access Approved!*\n\nYou've been granted *${TIER_LABEL[tier] ?? tier}* access.`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⚡ Open Bot Panel", "menu:main") }
    ).catch(() => {});
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
    await ctx.reply(`🚫 \`${userId}\` blocked.${reason ? `\nReason: ${reason}` : ""}`, { parse_mode: "Markdown" });
  });
}

// ── Input processor ───────────────────────────────────────────────────────────

export async function processAccessInput(bot: MyBot, ctx: BotContext, action: string, text: string): Promise<void> {
  const userId = ctx.from!.id;
  const name = ctx.from!.first_name ?? "User";

  if (action === "access:message") {
    try {
      await notifyOwner(bot, userId, name, ctx.from!.username, text);
      await ctx.reply(
        `✅ *Request Sent*\n━━━━━━━━━━━━━━━━━━\n\nYour request has been sent to the owner.\n\n🔑 *Enter the 6-digit code* the owner provides within 1 minute to gain access.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      logger.error({ err }, "processAccessInput error");
      await ctx.reply(`❌ Failed to submit: ${err instanceof Error ? err.message : "Unknown error"}`);
    }

  } else if (action === "access:code") {
    await handleInviteCode(bot, ctx, text.trim());

  } else if (action === "acl:generate_invite") {
    const parts = text.trim().split(/\s+/);
    const tier = parts[0] ?? "free";
    const maxUses = parseInt(parts[1] ?? "1");
    const note = parts.slice(2).join(" ") || undefined;

    if (!["free", "premium", "vip"].includes(tier)) {
      await ctx.reply("❌ Invalid tier. Use: `free` · `premium` · `vip`", { parse_mode: "Markdown" });
      return;
    }

    const code = Array.from({ length: 8 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
    const uses = isNaN(maxUses) ? 1 : maxUses;

    try {
      await db.insert(inviteCodesTable).values({ code, tier, maxUses: uses, createdBy: userId, note: note ?? null, isActive: true });
      await ctx.reply(
        `🎟️ *INVITE CODE CREATED*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Code: \`${code}\`\n${TIER_EMOJI[tier] ?? ""} Tier: *${TIER_LABEL[tier] ?? tier}*\nMax uses: *${uses}*${note ? `\nNote: ${note}` : ""}\n\n` +
        `📎 Share link:\n\`t.me/${process.env.BOT_USERNAME ?? "crescent07_bot"}?start=${code}\``,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🎟️ View Codes", "acl:invites") }
      );
    } catch (err) {
      await ctx.reply(`❌ Failed to create code: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  }
}
