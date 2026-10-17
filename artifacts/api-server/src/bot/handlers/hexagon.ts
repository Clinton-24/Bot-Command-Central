/**
 * CRESCENT — AI Agent
 * Shop-aware · Vision · /imagine · /briefing · quota · memory
 */

import { InlineKeyboard, InputFile } from "grammy";
import { eq, desc, gte, and } from "drizzle-orm";
import {
  db,
  groupMessagesTable,
  meetingsTable,
  ordersTable,
  productsTable,
} from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { checkCrescentAccess } from "./access";
import { logger } from "../../lib/logger";
import {
  consumeCrescentQuota,
  formatCrescentQuota,
  getCrescentQuotaStatus,
} from "./crescent-quota";
import { buildMemoryContext, clearMemory, rememberExchange } from "../../lib/ai-memory";
import {
  generateImage,
  routeChat,
  type ChatMessage,
  type ContentPart,
} from "../../lib/model-router";
import type { TaskType } from "../../lib/model-config";

const inFlightUpdates = new Set<string>();
const recentlyHandled = new Map<string, number>();
const DEDUPE_TTL_MS = 120_000;

function claimUpdate(key: string): boolean {
  const now = Date.now();
  for (const [k, t] of recentlyHandled) {
    if (now - t > DEDUPE_TTL_MS) recentlyHandled.delete(k);
  }
  if (inFlightUpdates.has(key) || recentlyHandled.has(key)) return false;
  inFlightUpdates.add(key);
  return true;
}

function releaseUpdate(key: string, success: boolean): void {
  inFlightUpdates.delete(key);
  if (success) recentlyHandled.set(key, Date.now());
}

let shopContextCache: { at: number; text: string } | null = null;
const SHOP_CACHE_MS = 60_000;

async function buildShopContext(): Promise<string> {
  if (shopContextCache && Date.now() - shopContextCache.at < SHOP_CACHE_MS) {
    return shopContextCache.text;
  }
  try {
    const [products, orders] = await Promise.all([
      db.select().from(productsTable).where(eq(productsTable.isActive, true)).limit(40),
      db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(15),
    ]);
    const productLines =
      products.length === 0
        ? "No active products."
        : products
            .map((p) => {
              const stock = Number(p.stock);
              const availability =
                stock === 0 ? "Unlimited" : stock > 0 ? `${p.stock} available` : "Out of stock";
              const delivery =
                p.deliveryType === "auto" && p.deliveryContent
                  ? "Digital auto-delivery"
                  : "Manual delivery";
              return `• ${p.name} | $${p.price} | ${availability} | ${delivery} | Category: ${p.category ?? "general"}`;
            })
            .join("\n");
    const orderLines =
      orders.length === 0
        ? "No recent orders."
        : orders
            .map(
              (o) =>
                `• Order #${o.id} | Product:${o.productId} | Qty:${o.quantity} | Status:${o.status}`,
            )
            .join("\n");
    const text = `LIVE SHOP DATA:\n${productLines}\n\nRECENT ORDERS:\n${orderLines}`;
    shopContextCache = { at: Date.now(), text };
    return text;
  } catch (err) {
    logger.warn({ err }, "Crescent could not build shop context");
    return "Shop data unavailable.";
  }
}

async function buildGroupContext(chatId: number): Promise<string> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const messages = await db
      .select()
      .from(groupMessagesTable)
      .where(and(eq(groupMessagesTable.chatId, chatId), gte(groupMessagesTable.createdAt, since)))
      .orderBy(desc(groupMessagesTable.createdAt))
      .limit(200);
    if (messages.length === 0) return "No recent group messages recorded.";
    const byUser = new Map<number, { name: string; count: number; samples: string[] }>();
    for (const m of messages) {
      const entry =
        byUser.get(m.userId) ?? {
          name: m.firstName ?? m.username ?? String(m.userId),
          count: 0,
          samples: [],
        };
      entry.count++;
      if (entry.samples.length < 3) entry.samples.push(m.message.slice(0, 80));
      byUser.set(m.userId, entry);
    }
    const lines = Array.from(byUser.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([, v]) => `• ${v.name} (${v.count} msgs): "${v.samples.join('" | "')}"`)
      .join("\n");
    return `LAST 24H GROUP ACTIVITY (${messages.length} messages, ${byUser.size} users):\n${lines}`;
  } catch {
    return "Group data unavailable.";
  }
}

async function buildMeetingsContext(): Promise<string> {
  try {
    const now = new Date();
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const meetings = await db.select().from(meetingsTable).orderBy(desc(meetingsTable.scheduledAt)).limit(20);
    const upcoming = meetings.filter((m) => {
      const at = m.scheduledAt ? new Date(m.scheduledAt) : null;
      return at && at >= now && at <= end;
    });
    if (upcoming.length === 0) return "No meetings scheduled in the next 7 days.";
    return upcoming
      .map((m) => {
        const when = m.scheduledAt
          ? new Date(m.scheduledAt).toLocaleString("en-KE", { timeZone: "Africa/Nairobi" })
          : "unscheduled";
        return `• ${m.title ?? "Meeting"} — ${when}${m.description ? ` — ${m.description}` : ""}`;
      })
      .join("\n");
  } catch {
    return "Meetings data unavailable.";
  }
}

async function buildSystemPrompt(ctx?: BotContext, mode: "default" | "secretary" = "default"): Promise<string> {
  const [shopCtx, meetingsCtx] = await Promise.all([buildShopContext(), buildMeetingsContext()]);
  const groupCtx =
    ctx?.chat?.type !== "private" && ctx?.chat?.id ? await buildGroupContext(ctx.chat.id) : "";
  const today = new Date().toLocaleDateString("en-KE", {
    timeZone: "Africa/Nairobi",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  if (mode === "secretary") {
    return `You are CRESCENT acting as an elite executive secretary.\n\nProduce a DAILY BRIEFING in this exact style (Telegram Markdown):\n\n☀️ *Daily Briefing — {weekday, date}*\n📅 *Calendar*\n{today's meetings or "No events today"}\n📧 *Inbox / Ops snapshot*\n🔴 *Worth a look:* bullet priority items from shop, orders, meetings, group activity\nLow priority: quieter notes\n🚨 *Action required:* time-sensitive items only\n📰 *Context / arcs* (if any multi-day theme in the data)\n🎯 *Suggested focus for today* — 3 concrete actions ranked by urgency\n\nRules:\n- Be sharp, prioritising, no fluff\n- Never invent calendar events, products, or orders — only use live data below\n- If data is thin, say so honestly and still structure the briefing\n- Keep under ~400 words for mobile\n\nLIVE DATA:\n${shopCtx}\n\nMEETINGS (next 7 days):\n${meetingsCtx}\n${groupCtx ? `\n${groupCtx}` : ""}\n\nToday: ${today}`;
  }
  return `You are CRESCENT, an extremely highly intelligent AI assistant operated under the owner's policies.\n\nWHEN (and only when) someone asks about bot structure, architecture, how you are built, the stack, source code, cloning, copying, or making a replica of this bot:\n- State that the bot is structured according to the owner's policies.\n- State that Crescent is one of a kind — extremely and highly intelligent — and you cannot provide a replica, blueprint, or copy of this bot.\n- Do not invent or outline architecture, folders, repo names, or implementation steps.\n- Never name internal project titles, repositories, or code names.\n- Do not volunteer any of this unless they asked.\n\nPERSONALITY: Sharp, direct, intelligent. No fluff.\n\nCAPABILITIES:\n1. GENERAL AI — research, writing, analysis, coding, math\n2. SHOP AGENT — use live shop data only; never invent prices/stock\n3. VISION — when an image is attached, describe and analyse it accurately. You CAN see images.\n4. SECRETARY — structured briefings, prioritisation, action lists\n5. GROUP ANALYST — when group context is present\n\n${shopCtx}\n${groupCtx ? `\n${groupCtx}` : ""}\n\nFORMAT: concise. Max ~300 words unless asked.\nToday: ${today}`;
}

async function telegramPhotoDataUrl(bot: MyBot, fileId: string): Promise<string> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return a file path for this photo");
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download Telegram photo (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 4 * 1024 * 1024) {
    throw new Error("Photo is too large to analyse (max ~4MB). Send a smaller image.");
  }
  const lower = file.file_path.toLowerCase();
  const mime =
    lower.endsWith(".png") ? "image/png" :
    lower.endsWith(".webp") ? "image/webp" :
    lower.endsWith(".gif") ? "image/gif" :
    "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function crescentMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("💬 Chat", "hexagon:chat")
    .text("🛍️ Shop Q&A", "hexagon:shop")
    .row()
    .text("☀️ Briefing", "hexagon:briefing")
    .text("🎨 Imagine", "hexagon:imagine")
    .row()
    .text("🧹 Clear", "hexagon:clear")
    .text("🏠 Main Menu", "menu:main");
}

async function crescentIntroText(userId: number): Promise<string> {
  const quota = await getCrescentQuotaStatus(userId);
  const quotaText = quota.unlimited ? "Unlimited" : formatCrescentQuota(quota);
  return (
    `🤖 CRESCENT AI AGENT\n━━━━━━━━━━━━━━━━━━\n\n` +
    `Shop-aware · Vision · Secretary · Image gen\n\n` +
    `📊 Quota: ${quotaText}\n\n` +
    `• Send a photo to analyse it\n` +
    `• /imagine a cyberpunk market stall\n` +
    `• /briefing — daily secretary briefing\n` +
    `• Or just type a question\n` +
    `• /exit — leave chat mode`
  );
}

async function askHexagon(
  userId: number,
  userMessage: string,
  ctx?: BotContext,
  task: TaskType = "chat",
  imageUrl?: string,
): Promise<{ reply: string; model: string }> {
  const [baseSystem, memory] = await Promise.all([
    buildSystemPrompt(ctx, "default"),
    buildMemoryContext(userId, userMessage),
  ]);
  const system = imageUrl
    ? (
      baseSystem +
      "\n\nVISION MODE (ACTIVE): An image is attached as multimodal content. " +
      "You CAN and MUST see it. " +
      "Read the image ONCE. Extract all visible text in a single clean transcription. " +
      "Do NOT repeat the same paragraph, list, or block of text. " +
      "If the user asked to capture/write the text, output only the transcribed text (once). " +
      "Otherwise: short description + one OCR block. Never say you cannot see images."
    )
    : baseSystem;
  let userContent: string | ContentPart[] = userMessage;
  if (imageUrl) {
    userContent = [
      {
        type: "text",
        text:
          userMessage ||
          "Extract all readable text from this image exactly once. Do not repeat any line. If there is little text, briefly describe the image.",
      },
      { type: "image_url", image_url: { url: imageUrl } },
    ];
  }
  const messages: ChatMessage[] = [
    { role: "system", content: `${system}\n\n${memory}` },
    { role: "user", content: userContent },
  ];
  const effectiveTask: TaskType = imageUrl ? "vision" : task;
  const response = await routeChat(effectiveTask, messages);
  void rememberExchange(userId, userMessage || "[image]", response.reply, effectiveTask);
  return { reply: response.reply, model: response.model };
}

export { askHexagon };

export function enableCrescentChat(ctx: BotContext): void {
  ctx.session.crescentMode = true;
  ctx.session.pendingAction = "hexagon:input";
}

export function disableCrescentChat(ctx: BotContext): void {
  ctx.session.crescentMode = false;
  if (ctx.session.pendingAction === "hexagon:input" || ctx.session.pendingAction === "hexagon:imagine") {
    ctx.session.pendingAction = undefined;
  }
}

export async function handleHexagonMessage(
  ctx: BotContext,
  input: string,
  imageUrl?: string,
): Promise<void> {
  const userId = ctx.from!.id;
  if (!(await checkCrescentAccess(ctx))) return;

  const updateId = ctx.update?.update_id;
  const msgId = ctx.message?.message_id ?? ctx.callbackQuery?.message?.message_id;
  const dedupeKey =
    updateId != null
      ? `u:${updateId}`
      : `m:${ctx.chat?.id ?? 0}:${msgId ?? 0}:${imageUrl ? "img" : "txt"}:${input.slice(0, 40)}`;
  if (!claimUpdate(dedupeKey)) {
    logger.info({ dedupeKey, userId }, "Skipping duplicate Crescent request");
    return;
  }

  enableCrescentChat(ctx);
  let thinkingId: number | undefined;
  let ok = false;
  try {
    await ctx.replyWithChatAction(imageUrl ? "upload_photo" : "typing").catch(() => {});
    const thinking = await ctx.reply(
      imageUrl ? "👁️ Reading image..." : "🧠 Crescent thinking...",
    );
    thinkingId = thinking.message_id;

    const consumed = await consumeCrescentQuota(userId);
    if (!consumed.allowed) {
      if (thinkingId) await ctx.api.deleteMessage(ctx.chat!.id, thinkingId).catch(() => {});
      await ctx.reply(
        `⚠️ Quota exceeded\n\n${formatCrescentQuota(consumed)}\n\nResets at midnight Nairobi time.`,
      );
      ok = true;
      return;
    }
    const task: TaskType = imageUrl ? "vision" : "chat";
    const { reply } = await askHexagon(userId, input, ctx, task, imageUrl);
    if (thinkingId) await ctx.api.deleteMessage(ctx.chat!.id, thinkingId).catch(() => {});
    const body = `🤖 CRESCENT\n━━━━━━━━━━━━━━━━━━\n\n${reply}`;
    try {
      if (imageUrl) await ctx.reply(body);
      else await ctx.reply(body, { parse_mode: "Markdown" }).catch(() => ctx.reply(body));
    } catch {
      await ctx.reply(body);
    }
    ok = true;
  } catch (err) {
    logger.error({ err, userId }, "handleHexagonMessage failed");
    if (thinkingId) await ctx.api.deleteMessage(ctx.chat!.id, thinkingId).catch(() => {});
    await ctx.reply(
      `❌ Crescent error\n\n${err instanceof Error ? err.message : "Unknown error"}`,
    );
  } finally {
    releaseUpdate(dedupeKey, ok);
  }
}

async function runSecretaryBriefing(ctx: BotContext): Promise<void> {
  const userId = ctx.from!.id;
  if (!(await checkCrescentAccess(ctx))) return;
  const thinking = await ctx.reply("☀️ Preparing daily briefing...");
  try {
    const consumed = await consumeCrescentQuota(userId);
    if (!consumed.allowed) {
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
      await ctx.reply(`⚠️ Quota exceeded. ${formatCrescentQuota(consumed)}`);
      return;
    }
    const system = await buildSystemPrompt(ctx, "secretary");
    const response = await routeChat("analysis", [
      { role: "system", content: system },
      {
        role: "user",
        content:
          "Generate today's full secretary daily briefing now, using only the live data in the system prompt. Follow the exact section structure.",
      },
    ]);
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(response.reply);
  } catch (err) {
    logger.error({ err }, "secretary briefing failed");
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(`❌ Briefing failed: ${err instanceof Error ? err.message : "Unknown"}`);
  }
}

async function runImagine(ctx: BotContext, prompt: string): Promise<void> {
  const userId = ctx.from!.id;
  if (!(await checkCrescentAccess(ctx))) return;
  if (!prompt.trim()) {
    await ctx.reply("Usage: /imagine a neon Tokyo street at night");
    return;
  }
  const thinking = await ctx.reply("🎨 Generating image...");
  try {
    const consumed = await consumeCrescentQuota(userId);
    if (!consumed.allowed) {
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
      await ctx.reply(`⚠️ Quota exceeded. ${formatCrescentQuota(consumed)}`);
      return;
    }
    const image = await generateImage(prompt.trim());
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    if (image.url) {
      await ctx.replyWithPhoto(image.url, {
        caption: `🎨 ${prompt.slice(0, 200)}\n${image.model}`,
      });
    } else if (image.b64) {
      const buffer = Buffer.from(image.b64, "base64");
      await ctx.replyWithPhoto(new InputFile(buffer, "crescent.png"), {
        caption: `🎨 ${prompt.slice(0, 200)}\n${image.model}`,
      });
    } else {
      await ctx.reply("❌ Image generation returned no data.");
    }
  } catch (err) {
    logger.error({ err }, "imagine failed");
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(
      `❌ Image generation failed:\n${err instanceof Error ? err.message : "Unknown"}\n\nAdd OpenRouter credits or set OPENAI_API_KEY.`,
    );
  }
}

export async function sendDailyDigest(userId: number, bot: MyBot): Promise<void> {
  try {
    const products = await db.select().from(productsTable).where(eq(productsTable.isActive, true));
    const lowStock = products.filter((p) => Number(p.stock) <= 5 && Number(p.stock) > 0);
    const now = new Date();
    let digest = `🌅 GOOD MORNING — DAILY DIGEST\n━━━━━━━━━━━━━━━━━━━━\n`;
    digest += `📅 ${now.toLocaleDateString("en-KE", { timeZone: "Africa/Nairobi", weekday: "long", month: "long", day: "numeric" })}\n\n`;
    digest += `🛍️ SHOP SNAPSHOT\n• Active products: ${products.length}\n`;
    if (lowStock.length > 0) digest += `• ⚠️ Low stock: ${lowStock.map((p) => p.name).join(", ")}\n`;
    const quota = await getCrescentQuotaStatus(userId);
    digest += `\n🤖 CRESCENT AI\n• Quota: ${quota.unlimited ? "Unlimited" : formatCrescentQuota(quota)}\n`;
    digest += `\nHave a productive day! /crescent · /briefing · /imagine`;
    await bot.api.sendMessage(userId, digest);
  } catch (err) {
    logger.error({ err }, "sendDailyDigest error");
  }
}

export async function logGroupMessage(ctx: BotContext): Promise<void> {
  try {
    if (!ctx.chat || ctx.chat.type === "private" || !ctx.from || !ctx.message?.text) return;
    await db.insert(groupMessagesTable).values({
      chatId: ctx.chat.id,
      userId: ctx.from.id,
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
      message: ctx.message.text.slice(0, 500),
    });
  } catch (err) {
    logger.warn({ err }, "logGroupMessage failed");
  }
}

export function registerHexagonHandlers(bot: MyBot): void {
  bot.command("crescent", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    const input = (ctx as any).match?.trim?.() ?? "";
    if (!input) {
      enableCrescentChat(ctx);
      await ctx.reply(await crescentIntroText(ctx.from.id), {
        reply_markup: crescentMenuKeyboard(),
      });
      return;
    }
    await handleHexagonMessage(ctx, input);
  });

  bot.command("ai", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    const input = (ctx as any).match?.trim?.() ?? "";
    if (!input) {
      enableCrescentChat(ctx);
      await ctx.reply("Usage: /ai [question]\nOr send a photo with a caption.");
      return;
    }
    await handleHexagonMessage(ctx, input);
  });

  bot.command("briefing", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    await runSecretaryBriefing(ctx);
  });

  bot.command("imagine", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    const prompt = (ctx as any).match?.trim?.() ?? "";
    await runImagine(ctx, prompt);
  });

  bot.command("exit", async (ctx) => {
    disableCrescentChat(ctx);
    await ctx.reply("Left Crescent chat mode.");
  });
}

export function registerHexagonCallbacks(bot: MyBot): void {
  bot.callbackQuery("hexagon:chat", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    enableCrescentChat(ctx);
    await ctx.answerCallbackQuery();
    await ctx.reply("💬 Crescent chat is on. Send a message or photo.\n/exit to leave.");
  });

  bot.callbackQuery("hexagon:shop", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    enableCrescentChat(ctx);
    await ctx.answerCallbackQuery();
    await handleHexagonMessage(ctx, "Summarise the current shop: products, prices, and stock.");
  });

  bot.callbackQuery("hexagon:briefing", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    await ctx.answerCallbackQuery();
    await runSecretaryBriefing(ctx);
  });

  bot.callbackQuery("hexagon:imagine", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    ctx.session.pendingAction = "hexagon:imagine";
    await ctx.answerCallbackQuery();
    await ctx.reply("🎨 Send an image prompt now, or use /imagine your prompt");
  });

  bot.callbackQuery("hexagon:clear", async (ctx) => {
    if (!ctx.from) return;
    await clearMemory(ctx.from.id).catch(() => {});
    await ctx.answerCallbackQuery("Memory cleared");
    await ctx.reply("🧹 Crescent memory cleared for you.");
  });

  bot.on("message:photo", async (ctx, next) => {
    if (ctx.chat?.type !== "private") return next();
    if (!ctx.from) return next();
    const inCrescent =
      ctx.session.crescentMode ||
      ctx.session.pendingAction === "hexagon:input" ||
      ctx.session.pendingAction === "hexagon:imagine";
    if (!inCrescent) return next();
    try {
      const photos = ctx.message.photo;
      const best = photos[photos.length - 1];
      if (!best) return next();
      const dataUrl = await telegramPhotoDataUrl(bot, best.file_id);
      const caption = ctx.message.caption?.trim() || "";
      await handleHexagonMessage(ctx, caption, dataUrl);
    } catch (err) {
      logger.error({ err }, "photo crescent failed");
      await ctx.reply(`❌ Could not read photo: ${err instanceof Error ? err.message : "error"}`);
    }
  });
}
