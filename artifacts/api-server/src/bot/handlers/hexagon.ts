/**
 * CRESCENT — AI Agent for Bot-Command-Central
 * ─────────────────────────────────────────────
 * • Free model fallback loop (5 models)
 * • Daily quota: 50 queries/day (resets midnight Nairobi)
 * • Group analyst: reads group messages, summarises user behaviour
 * • Agent mode: performs live tasks (broadcast, ban, product ops, etc.)
 * • Shop-aware: live product + order context injected into every prompt
 */

// TEMPORARY STUB - will be replaced
export async function sendDailyDigest(userId: number, bot: any): Promise<void> {
  const now = new Date();
  const digest =
    `🌅 *GOOD MORNING — DAILY DIGEST*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📅 ${now.toLocaleDateString("en-KE", { timeZone: "Africa/Nairobi", weekday: "long", month: "long", day: "numeric" })}\n\n` +
    `🛍️ *SHOP SNAPSHOT*\n` +
    `• Loading...\n\n` +
    `🤖 *CRESCENT AI*\n` +
    `• Quota: check /crescent\n\n` +
    `_Have a productive day! /crescent to chat._`;
  await bot.api.sendMessage(userId, digest, { parse_mode: "Markdown" });
}

export function registerHexagonHandlers(bot: any): void {}
export function registerHexagonCallbacks(bot: any): void {}
export async function sendDailyGroupDigest(bot: any, chatId: number, ownerId: number): Promise<void> {}
export async function handleHexagonMessage(ctx: any, input: string): Promise<void> {}
export async function logGroupMessage(ctx: any): Promise<void> {}
export function scheduleReminder(bot: any, userId: number, label: string, fireAt: Date): string { return ""; }
export function clearAllReminders(userId: number): number { return 0; }
export async function askHexagon(..._args: any[]): Promise<any> { return { reply: "", model: "" }; }
