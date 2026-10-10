/**
 * CRESCENT — AI Agent for Bot-Command-Central
 * Shop-aware · Vision (base64 photos) · /imagine · /briefing · quota · memory
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

async function buildShopContext(): Promise<string> {
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
    return `LIVE SHOP DATA:\n${productLines}\n\nRECENT ORDERS:\n${orderLines}`;
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
    return `You are CRESCENT acting as an elite executive secretary for Bot-Command-Central.\n\nProduce a DAILY BRIEFING in this exact style (Telegram Markdown):\n\n☀️ *Daily Briefing — {weekday, date}*\n📅 *Calendar*\n{today's meetings or "No events today"}\n📧 *Inbox / Ops snapshot*\n🔴 *Worth a look:* bullet priority items from shop, orders, meetings, group activity\nLow priority: quieter notes\n🚨 *Action required:* time-sensitive items only\n📰 *Context / arcs* (if any multi-day theme in the data)\n🎯 *Suggested focus for today* — 3 concrete actions ranked by urgency\n\nRules:\n- Be sharp, prioritising, no fluff\n- Never invent calendar events, products, or orders — only use live data below\n- If data is thin, say so honestly and still structure the briefing\n- Keep under ~400 words for mobile\n\nLIVE DATA:\n${shopCtx}\n\nMEETINGS (next 7 days):\n${meetingsCtx}\n${groupCtx ? `\n${groupCtx}` : ""}\n\nToday: ${today}`;
  }
  return `You are CRESCENT, an elite AI agent in Bot-Command-Central.\n\nPERSONALITY: Sharp, direct, intelligent. No fluff.\n\nCAPABILITIES:\n1. GENERAL AI — research, writing, analysis, coding, math\n2. SHOP AGENT — use live shop data only; never invent prices/stock\n3. VISION — when an image is attached, describe and analyse it accurately. You CAN see images.\n4. SECRETARY — structured briefings, prioritisation, action lists\n5. GROUP ANALYST — when group context is present\n\n${shopCtx}\n${groupCtx ? `\n${groupCtx}` : ""}\n\nFORMAT: concise Telegram Markdown (*bold*, _italic_). Max ~300 words unless asked.\nToday: ${today}`;
}

/** Download Telegram photo and embed as base64 data URL (OpenRouter cannot fetch bot file URLs). */
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
    `🤖 *CRESCENT AI AGENT*\n━━━━━━━━━━━━━━━━━━\n\n` +
    `_Shop-aware · Vision · Secretary · Image gen_\n\n` +
    `📊 Quota: *${quotaText}*\n\n` +
    `• Send a *photo* to analyse it\n` +
    `• /imagine a cyberpunk market stall\n` +
    `• /briefing — daily secretary briefing\n` +
    `• Or just type a question`
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
      "You CAN and MUST see it. Never say you cannot read screenshots, images, or photos. " +
      "Describe what is visible, extract any text (OCR), and answer based on the image. " +
      "If it is a screenshot of UI/chat/email, transcribe key text and summarise."
    )
    : baseSystem;
  let userContent: string | ContentPart[] = userMessage;
  if (imageUrl) {
    userContent = [
      {
        type: "text",
        text:
          userMessage ||
          "Describe and analyse this image thoroughly. Extract all readable text. Summarise what it shows.",
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

export async function handleHexagonMessage(
  ctx: BotContext,
  input: string,
  imageUrl?: string,
): Promise<void> {
  const userId = ctx.from!.id;
  if (!(await checkCrescentAccess(ctx))) return;
  ctx.session.pendingAction = "hexagon:input";
  const thinking = await ctx.reply(
    imageUrl ? `👁️ _Reading image..._` : `🧠 _Crescent thinking..._`,
    { parse_mode: "Markdown" },
  );
  try {
    const consumed = await consumeCrescentQuota(userId);
    if (!consumed.allowed) {
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
      await ctx.reply(
        `⚠️ *Quota exceeded*\n\n${formatCrescentQuota(consumed)}\n\nResets at midnight Nairobi time.`,
        { parse_mode: "Markdown" },
      );
      return;
    }
    const task: TaskType = imageUrl ? "vision" : "chat";
    const { reply } = await askHexagon(userId, input, ctx, task, imageUrl);
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(`🤖 *CRESCENT*\n━━━━━━━━━━━━━━━━━━\n\n${reply}`, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error({ err, userId }, "handleHexagonMessage failed");
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(
      `❌ *Crescent error*\n\n${err instanceof Error ? err.message : "Unknown error"}`,
      { parse_mode: "Markdown" },
    );
  }
}

async function runSecretaryBriefing(ctx: BotContext): Promise<void> {
  const userId = ctx.from!.id;
  if (!(await checkCrescentAccess(ctx))) return;
  const thinking = await ctx.reply(`☀️ _Preparing daily briefing..._`, { parse_mode: "Markdown" });
  try {
    const consumed = await consumeCrescentQuota(userId);
    if (!consumed.allowed) {
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
      await ctx.reply(`⚠️ Quota exceeded. ${formatCrescentQuota(consumed)}`, { parse_mode: "Markdown" });
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
    await ctx.reply(response.reply, { parse_mode: "Markdown" });
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
  const thinking = await ctx.reply(`🎨 _Generating image..._`, { parse_mode: "Markdown" });
  try {
    const consumed = await consumeCrescentQuota(userId);
    if (!consumed.allowed) {
      await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
      await ctx.reply(`⚠️ Quota exceeded. ${formatCrescentQuota(consumed)}`, { parse_mode: "Markdown" });
      return;
    }
    const image = await generateImage(prompt.trim());
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    if (image.url) {
      await ctx.replyWithPhoto(image.url, {
        caption: `🎨 *${prompt.slice(0, 200)}*\n_${image.model}_`,
        parse_mode: "Markdown",
      });
    } else if (image.b64) {
      const buffer = Buffer.from(image.b64, "base64");
      await ctx.replyWithPhoto(new InputFile(buffer, "crescent.png"), {
        caption: `🎨 *${prompt.slice(0, 200)}*\n_${image.model}_`,
        parse_mode: "Markdown",
      });
    } else {
      await ctx.reply("❌ Image generation returned no data.");
    }
  } catch (err) {
    logger.error({ err }, "imagine failed");
    await ctx.api.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});
    await ctx.reply(
      `❌ Image generation failed:\n${err instanceof Error ? err.message : "Unknown"}\n\n_Add OpenRouter credits or set OPENAI_API_KEY._`,
    );
  }
}

export async function sendDailyDigest(userId: number, bot: MyBot): Promise<void> {
  try {
    const products = await db.select().from(productsTable).where(eq(productsTable.isActive, true));
    const lowStock = products.filter((p) => Number(p.stock) <= 5 && Number(p.stock) > 0);
    const now = new Date();
    let digest = `🌅 *GOOD MORNING — DAILY DIGEST*\n━━━━━━━━━━━━━━━━━━━━\n`;
    digest += `📅 ${now.toLocaleDateString("en-KE", { timeZone: "Africa/Nairobi", weekday: "long", month: "long", day: "numeric" })}\n\n`;
    digest += `🛍️ *SHOP SNAPSHOT*\n• Active products: ${products.length}\n`;
    if (lowStock.length > 0) digest += `• ⚠️ Low stock: ${lowStock.map((p) => p.name).join(", ")}\n`;
    const quota = await getCrescentQuotaStatus(userId);
    digest += `\n🤖 *CRESCENT AI*\n• Quota: ${quota.unlimited ? "Unlimited" : formatCrescentQuota(quota)}\n`;
    digest += `\n_Have a productive day! /crescent · /briefing · /imagine_`;
    await bot.api.sendMessage(userId, digest, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error({ err }, "sendDailyDigest error");
  }
}

export function registerHexagonHandlers(bot: MyBot): void {
  bot.command("crescent", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    const input = ctx.match?.trim();
    if (!input) {
      ctx.session.pendingAction = "hexagon:input";
      await ctx.reply(await crescentIntroText(ctx.from.id), {
        parse_mode: "Markdown",
        reply_markup: crescentMenuKeyboard(),
      });
      return;
    }
    await handleHexagonMessage(ctx, input);
  });

  bot.command("ai", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    const input = ctx.match?.trim();
    if (!input) {
      ctx.session.pendingAction = "hexagon:input";
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
    await runImagine(ctx, ctx.match?.trim() ?? "");
  });

  bot.command("clearai", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) return;
    await clearMemory(ctx.from.id);
    await ctx.reply("🧹 Crescent memory cleared.");
  });

  bot.on("message:photo", async (ctx, next) => {
    if (!ctx.from || ctx.chat?.type !== "private") return next();
    if (!(await checkCrescentAccess(ctx))) return next();
    try {
      const photos = ctx.message.photo;
      const best = photos[photos.length - 1];
      if (!best) return next();
      const dataUrl = await telegramPhotoDataUrl(bot, best.file_id);
      const caption = ctx.message.caption?.trim() ?? "";
      await handleHexagonMessage(
        ctx,
        caption || "Describe and analyse this image thoroughly. Extract all readable text.",
        dataUrl,
      );
    } catch (err) {
      logger.error({ err }, "photo analyse failed");
      await ctx.reply(`❌ Could not read photo: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  });
}

export function registerHexagonCallbacks(bot: MyBot): void {
  bot.callbackQuery("menu:hexagon", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "hexagon:input";
    await ctx.editMessageText(await crescentIntroText(ctx.from.id), {
      parse_mode: "Markdown",
      reply_markup: crescentMenuKeyboard(),
    });
  });

  bot.callbackQuery("hexagon:chat", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "hexagon:input";
    await ctx.reply("💬 *Chat with Crescent*\n\nType a message or send a photo.", { parse_mode: "Markdown" });
  });

  bot.callbackQuery("hexagon:shop", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "hexagon:input";
    await ctx.reply(`🛍️ *Shop Q&A*\n\nAsk about products, orders, pricing, or stock.`, { parse_mode: "Markdown" });
  });

  bot.callbackQuery("hexagon:briefing", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    await ctx.answerCallbackQuery();
    await runSecretaryBriefing(ctx);
  });

  bot.callbackQuery("hexagon:imagine", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) {
      await ctx.answerCallbackQuery("⛔");
      return;
    }
    await ctx.answerCallbackQuery();
    ctx.session.pendingAction = "hexagon:imagine";
    await ctx.reply(
      `🎨 *Image generation*\n\nSend: /imagine your prompt here\n\n_Example: /imagine a futuristic Nairobi skyline at sunset_`,
      { parse_mode: "Markdown" },
    );
  });

  bot.callbackQuery("hexagon:clear", async (ctx) => {
    if (!ctx.from || !(await checkCrescentAccess(ctx))) {
      await ctx.answerCallbackQuery();
      return;
    }
    await clearMemory(ctx.from.id);
    await ctx.answerCallbackQuery("🧹 Cleared");
    ctx.session.pendingAction = "hexagon:input";
    await ctx.editMessageText(
      `🤖 *CRESCENT*\n━━━━━━━━━━━━━━━━━━\n\n🧹 Memory cleared.\n\nType a message or send a photo.`,
      { parse_mode: "Markdown", reply_markup: crescentMenuKeyboard() },
    );
  });
}

export async function logGroupMessage(ctx: BotContext): Promise<void> {
  const message = ctx.message;
  if (!message || !ctx.from || ctx.chat?.type === "private") return;
  const text =
    "text" in message ? message.text : "caption" in message ? message.caption : undefined;
  if (!text?.trim()) return;
  try {
    await db.insert(groupMessagesTable).values({
      chatId: ctx.chat!.id,
      userId: ctx.from.id,
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
      message: text.slice(0, 2000),
    });
  } catch (err) {
    logger.warn({ err }, "logGroupMessage failed");
  }
}

export async function sendDailyGroupDigest(bot: MyBot, chatId: number, ownerId: number): Promise<void> {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const messages = await db
      .select()
      .from(groupMessagesTable)
      .where(and(eq(groupMessagesTable.chatId, chatId), gte(groupMessagesTable.createdAt, since)))
      .limit(300);
    if (messages.length < 3) return;
    const byUser = new Map<number, { name: string; count: number }>();
    for (const m of messages) {
      const e = byUser.get(m.userId) ?? {
        name: m.firstName ?? m.username ?? String(m.userId),
        count: 0,
      };
      e.count++;
      byUser.set(m.userId, e);
    }
    const top = Array.from(byUser.entries()).sort((a, b) => b[1].count - a[1].count).slice(0, 5);
    const digest =
      `📊 *DAILY GROUP DIGEST*\n━━━━━━━━━━━━━━━━━━\n_${new Date().toDateString()}_\n\n` +
      `📨 Total messages: *${messages.length}*\n` +
      `👥 Active users: *${byUser.size}*\n\n` +
      `🏆 *Top Contributors*\n` +
      top.map(([, v], i) => `${i + 1}. ${v.name} — ${v.count} msgs`).join("\n");
    await bot.api.sendMessage(ownerId, digest, { parse_mode: "Markdown" });
  } catch (err) {
    logger.error({ err }, "sendDailyGroupDigest failed");
  }
}

export function scheduleReminder(bot: MyBot, userId: number, label: string, fireAt: Date): string {
  const id = `${userId}-${Date.now()}`;
  const delay = fireAt.getTime() - Date.now();
  if (delay <= 0) return "";
  setTimeout(async () => {
    await bot.api.sendMessage(userId, `⏰ *REMINDER*\n\n${label}`, { parse_mode: "Markdown" }).catch(() => {});
  }, delay);
  return id;
}

export function clearAllReminders(_userId: number): number {
  return 0;
}
