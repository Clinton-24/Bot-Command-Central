import { InlineKeyboard } from "grammy";
import { eq, desc } from "drizzle-orm";
import {
  db,
  productsTable,
  ordersTable,
  paymentSettingsTable,
  paymentRequestsTable,
  accessTable,
} from "@workspace/db";
import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

const CATEGORIES: { id: string; label: string }[] = [
  { id: "general", label: "📦 General" },
  { id: "streaming", label: "📺 Streaming" },
  { id: "gaming", label: "🎮 Gaming" },
  { id: "vpn", label: "🛡️ VPN" },
  { id: "giftcard", label: "🎁 Gift Cards" },
  { id: "social", label: "📱 Social" },
  { id: "cards", label: "💳 Cards" },
  { id: "other", label: "🌐 Other" },
];

const CATEGORY_EMOJIS: Record<string, string> = {
  general: "📦",
  streaming: "📺",
  gaming: "🎮",
  vpn: "🛡️",
  giftcard: "🎁",
  social: "📱",
  cards: "💳",
  other: "🌐",
};

function catEmoji(cat: string): string {
  return CATEGORY_EMOJIS[cat] ?? "📦";
}

function hexPanelKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📦 Products", "hex:products")
    .text("📋 Orders", "hex:orders")
    .row()
    .text("💰 Payments", "hex:payments")
    .text("📊 Stats", "hex:stats")
    .row()
    .text("🔑 Access", "hex:access")
    .text("🏠 Main Menu", "menu:main");
}

function categoryKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < CATEGORIES.length; i += 2) {
    const a = CATEGORIES[i]!;
    const b = CATEGORIES[i + 1];
    if (b) kb.text(a.label, `hex:setcat:${a.id}`).text(b.label, `hex:setcat:${b.id}`).row();
    else kb.text(a.label, `hex:setcat:${a.id}`).row();
  }
  return kb;
}

function deliveryTypeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✋ Manual (I'll deliver)", "hex:setdelivery:manual")
    .row()
    .text("⚡ Auto (bot sends on confirm)", "hex:setdelivery:auto")
    .row()
    .text("❌ Cancel", "hex:products");
}

async function getOrCreatePaymentSettings(ownerId: number) {
  const rows = await db.select().from(paymentSettingsTable).where(eq(paymentSettingsTable.ownerId, ownerId));
  if (rows[0]) return rows[0];
  const [created] = await db.insert(paymentSettingsTable).values({ ownerId }).returning();
  return created!;
}

async function saveNewProduct(ctx: BotContext): Promise<void> {
  const draft = ctx.session.hexDraft;
  if (!draft?.name || !draft.price) return;

  const [product] = await db
    .insert(productsTable)
    .values({
      name: draft.name,
      price: draft.price,
      description: draft.description ?? null,
      category: (draft.category ?? "general").trim().toLowerCase(),
      deliveryType: draft.deliveryType ?? "manual",
      deliveryContent: draft.deliveryContent ?? null,
      isActive: true,
      stock: "9999",
    })
    .returning();

  ctx.session.hexDraft = {};
  ctx.session.pendingAction = undefined;

  const emoji = catEmoji(draft.category ?? "general");
  await ctx.reply(
    `✅ *Product Added!*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `${emoji} ${draft.name}\n` +
      `💰 $${parseFloat(String(draft.price)).toFixed(2)}\n` +
      `📁 ${draft.category ?? "general"}\n` +
      `🚚 ${draft.deliveryType === "auto" ? "⚡ Auto-delivery" : "✋ Manual"}\n\n` +
      `Product ID: ${product?.id}\n\n` +
      `_It appears under All Products and its category in CardShop._`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("📦 All Products", "hex:products")
        .text("➕ Add Another", "hex:product_add"),
    },
  );
}

export async function processHexInput(ctx: BotContext, action: string, text: string): Promise<void> {
  if (!ctx.from || !isOwner(ctx.from.id)) return;

  switch (action) {
    case "hex:product_name":
      if (!text.trim()) {
        ctx.session.pendingAction = "hex:product_name";
        await ctx.reply("❌ Name cannot be empty. Try again:");
        return;
      }
      ctx.session.hexDraft = { ...ctx.session.hexDraft, name: text.trim() };
      ctx.session.pendingAction = "hex:product_price";
      await ctx.reply("💰 *Price?* (e.g. `15.00` USD):", { parse_mode: "Markdown" });
      break;

    case "hex:product_price": {
      const price = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(price) || price <= 0) {
        ctx.session.pendingAction = "hex:product_price";
        await ctx.reply("❌ Invalid price. Enter a number like `9.99`:");
        return;
      }
      ctx.session.hexDraft = { ...ctx.session.hexDraft, price: price.toFixed(2) };
      ctx.session.pendingAction = "hex:product_desc";
      await ctx.reply("📝 *Description?* (type `/skip` to leave blank):", { parse_mode: "Markdown" });
      break;
    }

    case "hex:product_desc":
      ctx.session.hexDraft = {
        ...ctx.session.hexDraft,
        description: text === "/skip" || text.toLowerCase() === "skip" ? undefined : text.trim(),
      };
      ctx.session.pendingAction = undefined;
      await ctx.reply("📁 *Choose category:*", {
        parse_mode: "Markdown",
        reply_markup: categoryKeyboard(),
      });
      break;

    case "hex:product_delivery_content":
      ctx.session.hexDraft = {
        ...ctx.session.hexDraft,
        deliveryContent: text.trim(),
        deliveryType: "auto",
      };
      ctx.session.pendingAction = undefined;
      await saveNewProduct(ctx);
      break;

    case "hex:edit_name": {
      const id = ctx.session.hexEditId;
      if (!id) return;
      await db.update(productsTable).set({ name: text.trim(), updatedAt: new Date() }).where(eq(productsTable.id, id));
      ctx.session.pendingAction = undefined;
      ctx.session.hexEditId = undefined;
      await ctx.reply("✅ Name updated.", {
        reply_markup: new InlineKeyboard().text("🔙 View", `hex:pview:${id}`).text("📦 Products", "hex:products"),
      });
      break;
    }

    case "hex:edit_price": {
      const id = ctx.session.hexEditId;
      if (!id) return;
      const price = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(price) || price <= 0) {
        ctx.session.pendingAction = "hex:edit_price";
        await ctx.reply("❌ Invalid price.");
        return;
      }
      await db.update(productsTable).set({ price: price.toFixed(2), updatedAt: new Date() }).where(eq(productsTable.id, id));
      ctx.session.pendingAction = undefined;
      ctx.session.hexEditId = undefined;
      await ctx.reply("✅ Price updated.", {
        reply_markup: new InlineKeyboard().text("🔙 View", `hex:pview:${id}`).text("📦 Products", "hex:products"),
      });
      break;
    }

    case "hex:edit_desc": {
      const id = ctx.session.hexEditId;
      if (!id) return;
      await db
        .update(productsTable)
        .set({
          description: text === "/skip" || text.toLowerCase() === "skip" ? null : text.trim(),
          updatedAt: new Date(),
        })
        .where(eq(productsTable.id, id));
      ctx.session.pendingAction = undefined;
      ctx.session.hexEditId = undefined;
      await ctx.reply("✅ Description updated.", {
        reply_markup: new InlineKeyboard().text("🔙 View", `hex:pview:${id}`).text("📦 Products", "hex:products"),
      });
      break;
    }

    default:
      break;
  }
}

export function registerHexHandlers(bot: Bot<BotContext>): void {
  bot.command("hex", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner only.");
      return;
    }
    await ctx.reply(`🔮 *HEX CONTROL PANEL*\n━━━━━━━━━━━━━━━━━━\n\nFull control over your CardShop.`, {
      parse_mode: "Markdown",
      reply_markup: hexPanelKeyboard(),
    });
  });
}

export function registerHexCallbacks(bot: Bot<BotContext>): void {
  bot.callbackQuery("hex:main", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(`🔮 *HEX CONTROL PANEL*\n━━━━━━━━━━━━━━━━━━\n\nFull control over your CardShop.`, {
      parse_mode: "Markdown",
      reply_markup: hexPanelKeyboard(),
    });
  });

  bot.callbackQuery("hex:products", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const products = await db.select().from(productsTable).orderBy(desc(productsTable.createdAt)).limit(30);
    const kb = new InlineKeyboard();
    for (const p of products) {
      const flag = p.isActive ? "✅" : "⏸";
      kb.text(`${flag} ${p.name} — $${parseFloat(String(p.price)).toFixed(2)}`, `hex:pview:${p.id}`).row();
    }
    kb.text("➕ Add Product", "hex:product_add").row().text("🔙 Hex", "hex:main");
    await ctx.editMessageText(
      `📦 *PRODUCTS*\n━━━━━━━━━━━━━━━━━━\n\n` +
        (products.length === 0 ? "No products yet. Add one!" : "Click a product to manage it."),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  bot.callbackQuery("hex:product_add", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    ctx.session.hexDraft = {};
    ctx.session.pendingAction = "hex:product_name";
    await ctx.answerCallbackQuery();
    await ctx.reply(`➕ *ADD PRODUCT*\n━━━━━━━━━━━━━━━━━━\n\nStep 1/4: *Product name?*`, {
      parse_mode: "Markdown",
    });
  });

  bot.callbackQuery(/^hex:setcat:(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const cat = ctx.match[1]!;
    ctx.session.hexDraft = { ...ctx.session.hexDraft, category: cat };
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("🚚 *Delivery type?*", {
      parse_mode: "Markdown",
      reply_markup: deliveryTypeKeyboard(),
    });
  });

  bot.callbackQuery(/^hex:setdelivery:(manual|auto)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const dtype = ctx.match[1]! as "manual" | "auto";
    ctx.session.hexDraft = { ...ctx.session.hexDraft, deliveryType: dtype };
    await ctx.answerCallbackQuery();
    if (dtype === "auto") {
      ctx.session.pendingAction = "hex:product_delivery_content";
      await ctx.editMessageText(
        `⚡ *Auto-delivery content*\n\nPaste the text/codes the buyer receives after payment:`,
        { parse_mode: "Markdown" },
      );
    } else {
      await saveNewProduct(ctx);
    }
  });

  bot.callbackQuery(/^hex:pview:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const id = parseInt(ctx.match[1]!);
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, id));
    if (!p) {
      await ctx.editMessageText("Product not found.");
      return;
    }
    const kb = new InlineKeyboard()
      .text("✏️ Name", `hex:peditname:${id}`)
      .text("💰 Price", `hex:peditprice:${id}`)
      .row()
      .text("📝 Desc", `hex:peditdesc:${id}`)
      .text(p.isActive ? "⏸ Disable" : "▶️ Enable", `hex:ptoggle:${id}`)
      .row()
      .text("🗑 Delete", `hex:pdelete:${id}`)
      .row()
      .text("🔙 Products", "hex:products");
    await ctx.editMessageText(
      `📦 *${p.name}*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `💰 $${parseFloat(String(p.price)).toFixed(2)}\n` +
        `📁 ${p.category}\n` +
        `📊 ${p.isActive ? "Active" : "Disabled"}\n` +
        `🚚 ${p.deliveryType}\n` +
        (p.description ? `\n${p.description}` : ""),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^hex:ptoggle:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!);
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, id));
    if (!p) return;
    await db.update(productsTable).set({ isActive: !p.isActive, updatedAt: new Date() }).where(eq(productsTable.id, id));
    await ctx.answerCallbackQuery(p.isActive ? "Disabled" : "Enabled");
    await ctx.editMessageText(`Product ${p.isActive ? "disabled" : "enabled"}.`, {
      reply_markup: new InlineKeyboard().text("🔙 View", `hex:pview:${id}`).text("📦 Products", "hex:products"),
    });
  });

  bot.callbackQuery(/^hex:pdelete:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!);
    await db.update(productsTable).set({ isActive: false, updatedAt: new Date() }).where(eq(productsTable.id, id));
    await ctx.answerCallbackQuery("Disabled (soft delete)");
    await ctx.editMessageText("Product disabled.", {
      reply_markup: new InlineKeyboard().text("📦 Products", "hex:products"),
    });
  });

  bot.callbackQuery(/^hex:peditname:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    ctx.session.hexEditId = parseInt(ctx.match[1]!);
    ctx.session.pendingAction = "hex:edit_name";
    await ctx.answerCallbackQuery();
    await ctx.reply("✏️ New product name?");
  });

  bot.callbackQuery(/^hex:peditprice:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    ctx.session.hexEditId = parseInt(ctx.match[1]!);
    ctx.session.pendingAction = "hex:edit_price";
    await ctx.answerCallbackQuery();
    await ctx.reply("💰 New price? (e.g. 12.50)");
  });

  bot.callbackQuery(/^hex:peditdesc:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    ctx.session.hexEditId = parseInt(ctx.match[1]!);
    ctx.session.pendingAction = "hex:edit_desc";
    await ctx.answerCallbackQuery();
    await ctx.reply("📝 New description? (/skip to clear)");
  });

  bot.callbackQuery("hex:orders", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const orders = await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(20);
    if (orders.length === 0) {
      await ctx.editMessageText("📋 No orders yet.", {
        reply_markup: new InlineKeyboard().text("🔙 Hex", "hex:main"),
      });
      return;
    }
    const kb = new InlineKeyboard();
    for (const o of orders) {
      kb.text(`#${o.id} ${o.status}`, `hex:oview:${o.id}`).row();
    }
    kb.text("🔙 Hex", "hex:main");
    await ctx.editMessageText(`📋 *ORDERS* (${orders.length})`, {
      parse_mode: "Markdown",
      reply_markup: kb,
    });
  });

  bot.callbackQuery(/^hex:oview:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const id = parseInt(ctx.match[1]!);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
    if (!order) {
      await ctx.editMessageText("Order not found.");
      return;
    }
    const [product] = await db.select().from(productsTable).where(eq(productsTable.id, order.productId));
    const [pr] = await db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.orderId, id));
    const kb = new InlineKeyboard();
    if (order.status === "pending" || order.status === "claimed") {
      kb.text("✅ Confirm", `hex:oconfirm:${id}`).text("❌ Cancel", `hex:ocancel:${id}`).row();
    }
    kb.text("🔙 Orders", "hex:orders");
    await ctx.editMessageText(
      `📋 *ORDER #${id}*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `👤 ${order.userId}\n` +
        `📦 ${product?.name ?? "?"}\n` +
        `📊 ${order.status}\n` +
        (pr ? `💰 ${pr.amount} ${pr.coin}\n` : ""),
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^hex:oconfirm:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
    if (!order) return;
    await db.update(ordersTable).set({ status: "confirmed", updatedAt: new Date() }).where(eq(ordersTable.id, id));
    await db
      .update(paymentRequestsTable)
      .set({ status: "confirmed", confirmedAt: new Date() })
      .where(eq(paymentRequestsTable.orderId, id))
      .catch(() => {});
    const [product] = await db.select().from(productsTable).where(eq(productsTable.id, order.productId));
    let buyerMsg = `✅ *Order #${id} confirmed*\n\n📦 ${product?.name ?? "Your order"}`;
    if (product?.deliveryType === "auto" && product.deliveryContent) {
      buyerMsg += `\n\n🎁 Delivery:\n${product.deliveryContent}`;
    } else {
      buyerMsg += `\n\nSeller will deliver shortly.`;
    }
    await ctx.api.sendMessage(order.userId, buyerMsg, { parse_mode: "Markdown" }).catch(() => {});
    await ctx.answerCallbackQuery("Confirmed");
    await ctx.editMessageText(`✅ Order #${id} confirmed.`, {
      reply_markup: new InlineKeyboard().text("📋 Orders", "hex:orders"),
    });
  });

  bot.callbackQuery(/^hex:ocancel:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!);
    await db.update(ordersTable).set({ status: "cancelled", updatedAt: new Date() }).where(eq(ordersTable.id, id));
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText(`❌ Order #${id} cancelled.`, {
      reply_markup: new InlineKeyboard().text("📋 Orders", "hex:orders"),
    });
  });

  bot.callbackQuery("hex:payments", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `💰 *PAYMENT SETTINGS*\n━━━━━━━━━━━━━━━━━━\n\nConfigure wallets in env or here (manual crypto).\nCryptoBot uses CRYPTOBOT_API_TOKEN on Render.`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🔙 Hex", "hex:main"),
      },
    );
  });

  bot.callbackQuery("hex:stats", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const products = await db.select().from(productsTable);
    const orders = await db.select().from(ordersTable);
    const active = products.filter((p) => p.isActive).length;
    const confirmed = orders.filter((o) => o.status === "confirmed").length;
    await ctx.editMessageText(
      `📊 *STATS*\n━━━━━━━━━━━━━━━━━━\n\n📦 Products: ${products.length} (${active} active)\n📋 Orders: ${orders.length} (${confirmed} confirmed)`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🔙 Hex", "hex:main"),
      },
    );
  });

  bot.callbackQuery("hex:access", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `🔑 *ACCESS*\n━━━━━━━━━━━━━━━━━━\n\nUse /access for the full access panel (users, invites, tiers).`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🔙 Hex", "hex:main"),
      },
    );
  });
}
