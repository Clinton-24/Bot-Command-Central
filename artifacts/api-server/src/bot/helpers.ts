import type { Bot, Context } from "grammy";

export async function isAdmin(ctx: Context, userId: number): Promise<boolean> {
  if (!ctx.chat || ctx.chat.type === "private") return false;
  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, userId);
    return ["administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

export async function isCreator(ctx: Context, userId: number): Promise<boolean> {
  if (!ctx.chat || ctx.chat.type === "private") return false;
  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, userId);
    return member.status === "creator";
  } catch {
    return false;
  }
}

export function parseTime(timeStr: string): number | null {
  const match = timeStr.match(/^(\d+)(h|d|m)$/);
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers: Record<string, number> = { h: 3600, d: 86400, m: 2592000 };
  return Date.now() / 1000 + amount * multipliers[unit];
}

export function formatUser(user: { first_name?: string; username?: string; id: number }): string {
  if (user.username) return `@${user.username}`;
  const name = user.first_name || "Unknown";
  return `[${name}](tg://user?id=${user.id})`;
}

export async function mustBeAdmin(ctx: Context): Promise<boolean> {
  const from = ctx.from;
  if (!from) return false;
  const ok = await isAdmin(ctx, from.id);
  if (!ok) {
    await ctx.reply("⚠️ This command is for admins only.").catch(() => {});
  }
  return ok;
}

export async function mustBeGroup(ctx: Context): Promise<boolean> {
  if (!ctx.chat || ctx.chat.type === "private") {
    await ctx.reply("This command can only be used in groups.").catch(() => {});
    return false;
  }
  return true;
}

export function isOwner(userId: number): boolean {
  const ownerIdStr = process.env["BOT_OWNER_ID"];
  if (!ownerIdStr) return false;
  return String(userId) === ownerIdStr;
}
