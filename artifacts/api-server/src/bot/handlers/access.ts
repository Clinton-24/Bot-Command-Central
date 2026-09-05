/**
 * ACCESS CONTROL SYSTEM
 * ─────────────────────────────────────────────────────────────────────────────
 * Flow A (OTP): user requests → OTP sent to owner → owner forwards to user → user enters within 60s
 * Flow B (Invite): owner generates code → shares link → user enters code → instant access
 * Flow C (Simple): user taps Request → owner gets Confirm/Decline buttons → one-by-one or all
 */

import { InlineKeyboard } from "grammy";
import { eq, desc } from "drizzle-orm";
import { db, accessTable, inviteCodesTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

// ── Safe text — strips ALL Markdown special chars from user-provided strings ──
function s(t: string | undefined | null): string {
  if (!t) return "";
  return t
    .replace(/\\/g, "")
    .replace(/\*/g, "")
    .replace(/_/g, " ")
    .replace(/`/g, "")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/~/g, "")
    .replace(/>/g, "")
    .replace(/\|/g, " ");
}

// ── Tier config ───────────────────────────────────────────────────────────────

const TIER_RANK: Record<string, number> = { free: 1, premium: 2, vip: 3 };
export const TIER_EMOJI: Record<string, string> = { free: "🟢", premium: "💎", vip: "👑", blocked: "🚫" };
export const TIER_LABEL: Record<string, string> = { free: "Free", premium: "Premium", vip: "VIP", blocked: "Blocked" };

export function tierRank(tier: string): number {
  return TIER_RANK[tier] ?? 0;
}

// ── In-memory OTP store ───────────────────────────────────────────────────────

interface PendingOTP {
  otp: string;
  expiresAt: number;
  tier: "free" | "premium" | "vip";
  name: string;
  username?: string;
}

const pendingOTPs = new Map<number, PendingOTP>();

function generateCode(len = 6): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// ── DB helpers ────────────────────────────────────────────────────────────────

export async function getAccess(userId: number) {
  try {
    const [r] = await db.select().from(accessTable).where(eq(accessTable.userId, userId));
    return r ?? null;
  } catch { return null; }
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
    const rec = await getAccess(userId);

    if (!rec || !rec.isApproved) {
      await showGate(ctx);
      return false;
    }
    if (rec.tier === "blocked") {
      await ctx.reply(`🚫 *Access Denied*\n\nYour account has been blocked.${rec.blockedReason ? `\n_Reason: ${s(rec.blockedReason)}_` : ""}`, { parse_mode: "Markdown" });
      return false;
    }
    if (rec.expiresAt && rec.expiresAt < new Date()) {
      await db.update(accessTable).set({ isApproved: false }).where(eq(accessTable.userId, userId));
      await showGate(ctx, true);
      return false;
    }
    if (tierRank(rec.tier) < tierRank(requiredTier)) {
      await ctx.reply(`💎 *${TIER_LABEL[requiredTier]} Required*\n\nYour tier: ${TIER_EMOJI[rec.tier] ?? ""} *${TIER_LABEL[rec.tier] ?? rec.tier}*\n\n_Contact the owner to upgrade._`, { parse_mode: "Markdown" });
      return false;
    }
    db.update(accessTable)
      .set({ lastSeenAt: new Date(), totalMessages: (rec.totalMessages ?? 0) + 1 })
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
    const rec = await getAccess(userId);
    if (rec?.tier === "blocked") {
      await ctx.reply("🚫 Your account has been blocked.");
      return false;
    }
    if (rec) {
      db.update(accessTable)
        .set({ lastSeenAt: new Date(), totalMessages: (rec.totalMessages ?? 0) + 1 })
        .where(eq(accessTable.userId, userId))
        .catch(() => {});
    }
    return true;
  } catch { return true; }
}

// ── Access gate ───────────────────────────────────────────────────────────────

async function showGate(ctx: BotContext, expired = false): Promise<void> {
  const name = s(ctx.from?.first_name ?? "User");
  const text = expired
    ? `⏰ *Access Expired*\n\nWelcome back, ${name}.\n\nYour access has expired. Request access again below.`
    : `🔐 *PRIVATE BOT*\n\nWelcome, ${name}.\n\nThis bot requires approval to use.\nTap below to request access:`;

  const kb = new InlineKeyboard()
    .text("🔑 Request Access", "access:request")
    .text("🎟️ Enter Code", "access:enter_code");

  if (ctx.callbackQuery) {
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb }).catch(() =>
      ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb })
    );
    await ctx.answerCallbackQuery().catch(() => {});
  } else {
    await ctx.reply(text, { parse_mode: "Markdown", reply_markup: kb });
  }
}

// ── Notify owner of access request ───────────────────────────────────────────

async function notifyOwner(bot: MyBot, userId: number, name: string, username: string | undefined): Promise<void> {
  const ownerIdStr = process.env["BOT_OWNER_ID"];
  if (!ownerIdStr) { logger.warn("BOT_OWNER_ID not set"); return; }

  const displayName = s(name);
  const displayUser = username ? ` (@${s(username)})` : "";

  await bot.api.sendMessage(
    parseInt(ownerIdStr),
    `🔔 *ACCESS REQUEST*\n━━━━━━━━━━━━━━━━━━\n\n` +
    `👤 ${displayName}${displayUser}\n` +
    `🆔 \`${userId}\`\n\n` +
    `_Approve or decline:_`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ Approve Free", `access:approve:${userId}:free`)
        .text("💎 Premium", `access:approve:${userId}:premium`)
        .row()
        .text("👑 VIP", `access:approve:${userId}:vip`)
        .text("🚫 Decline", `access:deny:${userId}`),
    }
  ); // let errors propagate so caller can handle
}

// ── OTP verification ──────────────────────────────────────────────────────────

async function verifyOTP(bot: MyBot, ctx: BotContext, code: string): Promise<void> {
  const userId = ctx.from!.id;
  const entry = pendingOTPs.get(userId);

  if (!entry) {
    await ctx.reply(`❌ *No active code*\n\nRequest a new one:`, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🔑 Request Access", "access:request"),
    });
    return;
  }
  if (Date.now() > entry.expiresAt) {
    pendingOTPs.delete(userId);
    await ctx.reply(`⏰ *Code expired*\n\nRequest a new code:`, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🔑 Request Again", "access:request"),
    });
    return;
  }
  if (code.trim().toUpperCase() !== entry.otp) {
    const secs = Math.max(0, Math.round((entry.expiresAt - Date.now()) / 1000));
    await ctx.reply(`❌ *Wrong code*\n\n_${secs}s remaining to retry._`, { parse_mode: "Markdown" });
    return;
  }

  pendingOTPs.delete(userId);
  await approveUser(bot, ctx, userId, entry.tier, s(entry.name), entry.username);
}

// ── Core approve function ─────────────────────────────────────────────────────

async function approveUser(
  bot: MyBot,
  ctx: BotContext | null,
  userId: number,
  tier: string,
  displayName: string,
  username?: string | null,
): Promise<void> {
  try {
    await db.insert(accessTable).values({
      userId,
      username: username ?? undefined,
      firstName: displayName,
      tier,
      isApproved: true,
      isPending: false,
      approvedAt: new Date(),
    }).onConflictDoUpdate({
      target: accessTable.userId,
      set: { tier, isApproved: true, isPending: false, approvedAt: new Date() },
    });

    const emoji = TIER_EMOJI[tier] ?? "✅";
    const label = TIER_LABEL[tier] ?? tier;

    await bot.api.sendMessage(
      userId,
      `${emoji} *Access Granted!*\n━━━━━━━━━━━━━━━━━━\n\nWelcome, ${displayName}!\n\nTier: *${label}*\n\n_You now have full access._`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⚡ Open Bot Panel", "menu:main") }
    ).catch(() => {});
  } catch (err) {
    logger.error({ err }, "approveUser error");
    if (ctx) await ctx.reply(`❌ Failed to approve: ${err instanceof Error ? err.message : "Unknown"}`);
  }
}

// ── Invite code handler ───────────────────────────────────────────────────────

export async function handleInviteCode(bot: MyBot, ctx: BotContext, code: string): Promise<void> {
  const userId = ctx.from!.id;
  const name = s(ctx.from!.first_name ?? "User");
  const upper = code.trim().toUpperCase();

  // Check OTP first
  const otpEntry = pendingOTPs.get(userId);
  if (otpEntry && upper === otpEntry.otp) {
    await verifyOTP(bot, ctx, upper);
    return;
  }

  // Try permanent invite code
  try {
    const [invite] = await db.select().from(inviteCodesTable).where(eq(inviteCodesTable.code, upper));

    if (!invite || !invite.isActive) { await ctx.reply("❌ Invalid or expired code."); return; }
    if (invite.expiresAt && invite.expiresAt < new Date()) { await ctx.reply("❌ This code has expired."); return; }
    if (invite.usedCount >= invite.maxUses) { await ctx.reply("❌ This code has reached its usage limit."); return; }

    await db.insert(accessTable).values({
      userId, username: ctx.from!.username, firstName: name,
      tier: invite.tier, isApproved: true, isPending: false,
      approvedAt: new Date(), inviteCode: upper,
    }).onConflictDoUpdate({
      target: accessTable.userId,
      set: { tier: invite.tier, isApproved: true, isPending: false, approvedAt: new Date(), inviteCode: upper },
    });

    await db.update(inviteCodesTable)
      .set({ usedCount: invite.usedCount + 1, isActive: invite.usedCount + 1 < invite.maxUses })
      .where(eq(inviteCodesTable.id, invite.id));

    const emoji = TIER_EMOJI[invite.tier] ?? "✅";
    const label = TIER_LABEL[invite.tier] ?? invite.tier;

    await ctx.reply(
      `${emoji} *Access Granted!*\n━━━━━━━━━━━━━━━━━━\n\nWelcome, ${name}!\n\nTier: *${label}*`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⚡ Open Bot Panel", "menu:main") }
    );

    const ownerIdStr = process.env["BOT_OWNER_ID"];
    if (ownerIdStr) {
      await bot.api.sendMessage(parseInt(ownerIdStr),
        `✅ *Invite Used*\n\n👤 ${name}${ctx.from!.username ? ` (@${s(ctx.from!.username)})` : ""}\n🎟️ Code: \`${upper}\`\n${emoji} ${label}`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
    }
  } catch (err) {
    logger.error({ err }, "handleInviteCode error");
    await ctx.reply("❌ Failed to process code. Please try again.");
  }
}

// ── Register all handlers ─────────────────────────────────────────────────────

export function registerAccessHandlers(bot: MyBot): void {

  // ── User: Request Access button ────────────────────────────────────────────
  bot.callbackQuery("access:request", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;
    const name = ctx.from.first_name ?? "User";
    const username = ctx.from.username;

    // Save to DB (non-blocking — notification fires regardless)
    db.insert(accessTable).values({
      userId,
      username,
      firstName: name,
      tier: "free",
      isApproved: false,
      isPending: true,
      requestMessage: `Requested at ${new Date().toISOString()}`,
    }).onConflictDoUpdate({
      target: accessTable.userId,
      set: { isPending: true, username, firstName: name },
    }).catch((err) => logger.error({ err }, "access:request DB insert failed"));

    // Always notify owner with approve/decline buttons
    const ownerIdStr = process.env["BOT_OWNER_ID"];
    if (ownerIdStr) {
      const displayName = s(name);
      const displayUser = username ? ` (@${s(username)})` : "";
      bot.api.sendMessage(
        parseInt(ownerIdStr),
        `🔔 ACCESS REQUEST
━━━━━━━━━━━━━━━━━━

👤 ${displayName}${displayUser}
🆔 ${userId}

Approve or decline:`,
        {
          reply_markup: new InlineKeyboard()
            .text("✅ Approve Free", `access:approve:${userId}:free`)
            .text("💎 Premium", `access:approve:${userId}:premium`)
            .row()
            .text("👑 VIP", `access:approve:${userId}:vip`)
            .text("🚫 Decline", `access:deny:${userId}`),
        }
      ).catch((err) => logger.error({ err }, "owner notify failed"));
    }

    // Confirm to user
    await ctx.reply(
      "✅ Request Sent!
━━━━━━━━━━━━━━━━━━

Your request has been sent to the owner.
You will be notified once approved.

If you have an invite code:",
      { reply_markup: new InlineKeyboard().text("🎟️ Enter Code", "access:enter_code") }
    );
  });

  // ── User: Enter code button ────────────────────────────────────────────────
  bot.callbackQuery("access:enter_code", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "access:code";
    await ctx.reply(`🎟️ *ENTER CODE*\n\nSend your invite code or one-time code:`, { parse_mode: "Markdown" });
  });

  // Legacy callback alias
  bot.callbackQuery("access:invite", async (ctx) => {
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "access:code";
    await ctx.reply(`🎟️ *ENTER CODE*\n\nSend your invite code:`, { parse_mode: "Markdown" });
  });

  // ── Owner: Approve one user ────────────────────────────────────────────────
  bot.callbackQuery(/^access:approve:(\d+):(\w+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    const tier = ctx.match[2]!;
    await ctx.answerCallbackQuery(`${TIER_EMOJI[tier] ?? "✅"} Approving...`);

    const [rec] = await db.select().from(accessTable).where(eq(accessTable.userId, userId)).catch(() => [null]);
    const displayName = s(rec?.firstName ?? String(userId));

    await approveUser(bot, null, userId, tier, displayName, rec?.username);

    await ctx.editMessageText(
      `${TIER_EMOJI[tier] ?? "✅"} *Approved*\n\n👤 ${displayName}\n🆔 \`${userId}\`\nTier: *${TIER_LABEL[tier] ?? tier}*`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("👥 View All", "acl:users:all") }
    ).catch(() => ctx.reply(`✅ Approved \`${userId}\` as ${tier}.`));
  });

  // ── Owner: Decline one user ────────────────────────────────────────────────
  bot.callbackQuery(/^access:deny:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    await ctx.answerCallbackQuery("🚫 Declined");

    await db.insert(accessTable)
      .values({ userId, tier: "free", isApproved: false, isPending: false })
      .onConflictDoUpdate({ target: accessTable.userId, set: { isPending: false } })
      .catch(() => {});

    await ctx.editMessageText(
      `🚫 *Request Declined*\n\n🆔 \`${userId}\``,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("⏳ View Pending", "acl:users:pending") }
    ).catch(() => {});

    await bot.api.sendMessage(userId,
      `🚫 *Access Declined*\n\nYour request was not approved at this time.`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔑 Try Again", "access:request") }
    ).catch(() => {});
  });

  // ── Owner: Approve ALL pending users ──────────────────────────────────────
  bot.callbackQuery("acl:approve_all", async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery("✅ Approving all...");

    try {
      const pending = await db.select().from(accessTable).where(eq(accessTable.isPending, true));
      if (pending.length === 0) {
        await ctx.reply("⏳ No pending requests.");
        return;
      }
      let approved = 0;
      for (const rec of pending) {
        await approveUser(bot, null, rec.userId, "free", s(rec.firstName ?? String(rec.userId)), rec.username);
        approved++;
        await new Promise((r) => setTimeout(r, 300)); // rate limit
      }
      await ctx.reply(`✅ Approved *${approved}* pending users as Free.`, { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  // ── Owner: Decline ALL pending users ──────────────────────────────────────
  bot.callbackQuery("acl:decline_all", async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery("🚫 Declining all...");

    try {
      const pending = await db.select().from(accessTable).where(eq(accessTable.isPending, true));
      if (pending.length === 0) { await ctx.reply("⏳ No pending requests."); return; }

      await db.update(accessTable).set({ isPending: false }).where(eq(accessTable.isPending, true));

      for (const rec of pending) {
        await bot.api.sendMessage(rec.userId,
          `🚫 *Access Declined*\n\nYour request was not approved.`,
          { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔑 Try Again", "access:request") }
        ).catch(() => {});
        await new Promise((r) => setTimeout(r, 300));
      }
      await ctx.reply(`🚫 Declined *${pending.length}* pending requests.`, { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  // ── Owner: hex:access panel ────────────────────────────────────────────────
  bot.callbackQuery("hex:access", async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    try {
      const all = await db.select().from(accessTable);
      const pending = all.filter((a) => a.isPending);
      const approved = all.filter((a) => a.isApproved);
      const blocked = all.filter((a) => a.tier === "blocked");

      await ctx.editMessageText(
        `🔐 *ACCESS CONTROL*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `👥 Total: *${all.length}*\n` +
        `✅ Approved: *${approved.length}*\n` +
        `⏳ Pending: *${pending.length}*\n` +
        `🚫 Blocked: *${blocked.length}*`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("👥 All Users", "acl:users:all").text("⏳ Pending", "acl:users:pending").row()
            .text("💎 Premium", "acl:users:premium").text("👑 VIP", "acl:users:vip").row()
            .text("🚫 Blocked", "acl:users:blocked").text("🎟️ Invite Codes", "acl:invites").row()
            .text("✅ Approve All Pending", "acl:approve_all").row()
            .text("🚫 Decline All Pending", "acl:decline_all").row()
            .text("➕ Generate Invite", "acl:invite:generate").row()
            .text("🔙 Hex Panel", "hex:main"),
        }
      );
    } catch (err) { await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`); }
  });

  // ── Owner: view users by filter ────────────────────────────────────────────
  bot.callbackQuery(/^acl:users:(.+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
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

      const lines = filtered.length === 0 ? "_No users found._"
        : filtered.map((a) => {
            const name = s(a.firstName ?? "Unknown");
            const user = a.username ? ` @${s(a.username)}` : "";
            const status = a.isPending ? "⏳ Pending" : a.isApproved ? "✅ Active" : "❌ Inactive";
            return `${TIER_EMOJI[a.tier] ?? "⚪"} ${name}${user} \`${a.userId}\`\n   ${status} · ${a.tier}`;
          }).join("\n\n");

      const kb = new InlineKeyboard();
      if (filter === "pending" && filtered.length > 0) {
        kb.text("✅ Approve All", "acl:approve_all").text("🚫 Decline All", "acl:decline_all").row();
        // One-by-one approve buttons for first 5
        for (const u of filtered.slice(0, 5)) {
          const name = s(u.firstName ?? String(u.userId)).slice(0, 15);
          kb.text(`✅ ${name}`, `access:approve:${u.userId}:free`)
            .text(`🚫`, `access:deny:${u.userId}`).row();
        }
      }
      kb.text("🔙 Back", "hex:access");

      await ctx.editMessageText(
        `🔐 *${titles[filter] ?? filter.toUpperCase()}*\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
        { parse_mode: "Markdown", reply_markup: kb }
      );
    } catch (err) { await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`); }
  });

  // ── Owner: view invite codes ───────────────────────────────────────────────
  bot.callbackQuery("acl:invites", async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    await ctx.answerCallbackQuery();
    try {
      const codes = await db.select().from(inviteCodesTable)
        .orderBy(desc(inviteCodesTable.createdAt)).limit(15);

      const lines = codes.length === 0 ? "_No codes yet._"
        : codes.map((c) => {
            // Sanitise note field — this was causing the parse error
            const note = c.note ? ` - ${s(c.note)}` : "";
            const status = c.isActive ? "🟢" : "🔴";
            const tier = TIER_EMOJI[c.tier] ?? "";
            return `${status} \`${c.code}\` ${tier} ${c.tier} - ${c.usedCount}/${c.maxUses} uses${note}`;
          }).join("\n");

      await ctx.editMessageText(
        `🎟️ INVITE CODES\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
        {
          reply_markup: new InlineKeyboard()
            .text("➕ Generate New", "acl:invite:generate").row()
            .text("🔙 Back", "hex:access"),
        }
      );
    } catch (err) {
      logger.error({ err }, "acl:invites error");
      await ctx.reply(`❌ ${err instanceof Error ? err.message : "Error"}`);
    }
  });

  // ── Owner: generate invite code prompt ────────────────────────────────────
  bot.callbackQuery("acl:invite:generate", async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    ctx.session.pendingAction = "acl:generate_invite";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `🎟️ GENERATE INVITE CODE\n━━━━━━━━━━━━━━━━━━\n\nSend in format:\nTIER USES NOTE\n\nExamples:\npremium 1 For username\nvip 3 Bulk access\nfree 10 Open invite\n\nTiers: free - premium - vip`,
    );
  });

  // ── Owner: upgrade user ────────────────────────────────────────────────────
  bot.callbackQuery(/^acl:upgrade:(\d+):(\w+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!); const tier = ctx.match[2]!;
    await db.update(accessTable).set({ tier }).where(eq(accessTable.userId, userId));
    await ctx.answerCallbackQuery(`${TIER_EMOJI[tier] ?? ""} Upgraded`);
    await bot.api.sendMessage(userId, `${TIER_EMOJI[tier] ?? ""} Your tier has been upgraded to ${TIER_LABEL[tier] ?? tier}!`).catch(() => {});
  });

  // ── Owner: block user ──────────────────────────────────────────────────────
  bot.callbackQuery(/^acl:block:(\d+)$/, async (ctx) => {
    if (!isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔"); return; }
    const userId = parseInt(ctx.match[1]!);
    await db.update(accessTable).set({ tier: "blocked", isApproved: false, blockedAt: new Date() }).where(eq(accessTable.userId, userId));
    await ctx.answerCallbackQuery("🚫 Blocked");
    await ctx.reply(`🚫 User \`${userId}\` has been blocked.`, { parse_mode: "Markdown" });
  });

  // ── Owner commands ─────────────────────────────────────────────────────────
  bot.command("access", async (ctx) => {
    if (!isOwner(ctx.from!.id)) { await ctx.reply("⛔ Owner only."); return; }
    const all = await db.select().from(accessTable).catch(() => []);
    const pending = all.filter((a) => a.isPending);
    await ctx.reply(
      `🔐 ACCESS CONTROL\n━━━━━━━━━━━━━━━━━━\n\n` +
      `Total: ${all.length} - Approved: ${all.filter((a) => a.isApproved).length}\n` +
      `Pending: ${pending.length} - Blocked: ${all.filter((a) => a.tier === "blocked").length}`,
      {
        reply_markup: new InlineKeyboard()
          .text("👥 All Users", "acl:users:all").text("⏳ Pending", "acl:users:pending").row()
          .text("✅ Approve All", "acl:approve_all").text("🚫 Decline All", "acl:decline_all").row()
          .text("🎟️ Invite Codes", "acl:invites").text("➕ Generate", "acl:invite:generate"),
      }
    );
  });

  // ── Debug: test owner notification ───────────────────────────────────────
  bot.command("testnotify", async (ctx) => {
    if (!isOwner(ctx.from!.id)) return;
    const ownerIdStr = process.env["BOT_OWNER_ID"];
    await ctx.reply(
      `🔧 Debug:
BOT_OWNER_ID = \`${ownerIdStr ?? "NOT SET"}\`
Your ID = \`${ctx.from!.id}\`
Match = ${String(ctx.from!.id) === ownerIdStr}`,
      { parse_mode: "Markdown" }
    );
    try {
      await bot.api.sendMessage(
        parseInt(ownerIdStr ?? "0"),
        `🔔 TEST NOTIFICATION

This is a test from /testnotify
If you see this, owner notifications work.`,
      );
      await ctx.reply("✅ Test notification sent to owner ID.");
    } catch (err) {
      await ctx.reply(`❌ Failed to send to owner: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  });

  bot.command("approve", async (ctx) => {
    if (!isOwner(ctx.from!.id)) return;
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    const userId = parseInt(parts[0] ?? ""); const tier = parts[1] ?? "free";
    if (isNaN(userId)) { await ctx.reply("Usage: /approve <userId> [free|premium|vip]"); return; }
    const [rec] = await db.select().from(accessTable).where(eq(accessTable.userId, userId)).catch(() => [null]);
    await approveUser(bot, ctx, userId, tier, s(rec?.firstName ?? String(userId)), rec?.username);
    await ctx.reply(`✅ Approved ${userId} as ${tier}.`);
  });

  bot.command("revoke", async (ctx) => {
    if (!isOwner(ctx.from!.id)) return;
    const userId = parseInt(ctx.match?.trim() ?? "");
    if (isNaN(userId)) { await ctx.reply("Usage: /revoke <userId>"); return; }
    await db.update(accessTable).set({ isApproved: false }).where(eq(accessTable.userId, userId));
    await ctx.reply(`🚫 Access revoked for ${userId}.`);
  });

  bot.command("block", async (ctx) => {
    if (!isOwner(ctx.from!.id)) return;
    const parts = ctx.match?.trim().split(/\s+/) ?? [];
    const userId = parseInt(parts[0] ?? "");
    const reason = parts.slice(1).join(" ") || undefined;
    if (isNaN(userId)) { await ctx.reply("Usage: /block <userId> [reason]"); return; }
    await db.update(accessTable)
      .set({ tier: "blocked", isApproved: false, blockedAt: new Date(), blockedReason: reason ?? null })
      .where(eq(accessTable.userId, userId));
    await ctx.reply(`🚫 ${userId} blocked.${reason ? ` Reason: ${reason}` : ""}`);
  });
}

// ── Input processor (called from menu.ts) ─────────────────────────────────────

export async function processAccessInput(bot: MyBot, ctx: BotContext, action: string, text: string): Promise<void> {
  if (action === "access:verify_otp") {
    await verifyOTP(bot, ctx, text);

  } else if (action === "access:code") {
    await handleInviteCode(bot, ctx, text.trim());

  } else if (action === "acl:generate_invite") {
    const parts = text.trim().split(/\s+/);
    const tier = parts[0] ?? "free";
    const maxUses = parseInt(parts[1] ?? "1");
    const note = parts.slice(2).join(" ") || undefined;

    if (!["free", "premium", "vip"].includes(tier)) {
      await ctx.reply("❌ Invalid tier. Use: free - premium - vip");
      return;
    }
    const code = generateCode(8);
    const uses = isNaN(maxUses) ? 1 : Math.max(1, maxUses);

    try {
      await db.insert(inviteCodesTable).values({
        code, tier, maxUses: uses,
        createdBy: ctx.from!.id,
        note: note ?? null,
        isActive: true,
      });

      const botUsername = process.env.BOT_USERNAME ?? "crescent07_bot";
      await ctx.reply(
        `🎟️ INVITE CODE CREATED\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Code: ${code}\n` +
        `Tier: ${TIER_LABEL[tier] ?? tier}\n` +
        `Max uses: ${uses}\n` +
        (note ? `Note: ${note}\n` : "") +
        `\nShare link:\nt.me/${botUsername}?start=${code}`,
        { reply_markup: new InlineKeyboard().text("🎟️ View Codes", "acl:invites") }
      );
    } catch (err) {
      await ctx.reply(`❌ Failed: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  }
}
