import { InlineKeyboard } from "grammy";
import { eq, desc } from "drizzle-orm";
import {
  db,
  productsTable,
  ordersTable,
  paymentSettingsTable,
  paymentRequestsTable,
  bankLogsTable,
} from "@workspace/db";
import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { deductProductStock, getConfirmedRevenue, stockLabel as stockLabelShared, isUnlimitedStock } from "../../lib/order-fulfill";

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

function stockLabel(stock: string | number | null | undefined, isActive = true): string {
  return stockLabelShared(stock, isActive);
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

function categoryKeyboardForEdit(productId: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < CATEGORIES.length; i += 2) {
    const a = CATEGORIES[i]!;
    const b = CATEGORIES[i + 1];
    if (b) {
      kb.text(a.label, `hex:applycat:${productId}:${a.id}`)
        .text(b.label, `hex:applycat:${productId}:${b.id}`)
        .row();
    } else {
      kb.text(a.label, `hex:applycat:${productId}:${a.id}`).row();
    }
  }
  kb.text("🔙 Cancel", `hex:pview:${productId}`);
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

function productManageKeyboard(id: number, isActive: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text("✏️ Name", `hex:peditname:${id}`)
    .text("💰 Price", `hex:peditprice:${id}`)
    .row()
    .text("📝 Desc", `hex:peditdesc:${id}`)
    .text("📁 Category", `hex:peditcat:${id}`)
    .row()
    .text("📦 Stock", `hex:peditstock:${id}`)
    .text(isActive ? "⏸ Disable" : "▶️ Enable", `hex:ptoggle:${id}`)
    .row()
    .text("🗑 Delete", `hex:pdelete:${id}`)
    .text("🔙 Products", "hex:products");
}

async function showProductManage(ctx: BotContext, id: number): Promise<void> {
  const [p] = await db.select().from(productsTable).where(eq(productsTable.id, id));
  if (!p) {
    await ctx.reply("Product not found.", {
      reply_markup: new InlineKeyboard().text("📦 Products", "hex:products"),
    });
    return;
  }
  const text =
    `📦 PRODUCT #${p.id}\n━━━━━━━━━━━━━━━━━━\n\n` +
    `Name: ${p.name}\n` +
    `Price: $${parseFloat(String(p.price)).toFixed(2)}\n` +
    `Category: ${p.category || "general"}\n` +
    `Status: ${p.isActive ? "Active" : "Disabled"}\n` +
    `Delivery: ${p.deliveryType || "manual"}\n` +
    `Stock: ${stockLabel(p.stock, p.isActive)}\n` +
    (p.description ? `\nDescription:\n${p.description}\n` : "\nNo description.\n") +
    `\nTap a button below to manage this product.`;
  const kb = productManageKeyboard(id, p.isActive);
  try {
    await ctx.editMessageText(text, { reply_markup: kb });
  } catch {
    await ctx.reply(text, { reply_markup: kb });
  }
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
      stock: "0",
    })
    .returning();
  ctx.session.hexDraft = {};
  ctx.session.pendingAction = undefined;
  const emoji = catEmoji(draft.category ?? "general");
  const pid = product?.id;
  await ctx.reply(
    `✅ Product added\n━━━━━━━━━━━━━━━━━━\n\n` +
      `${emoji} ${draft.name}\n` +
      `💰 $${parseFloat(String(draft.price)).toFixed(2)}\n` +
      `📁 ${draft.category ?? "general"}\n` +
      `Stock: Unlimited\n` +
      `ID: ${pid}\n\n` +
      `Tap Manage to edit stock or other fields.`,
    {
      reply_markup: new InlineKeyboard()
        .text("⚙️ Manage", `hex:pview:${pid}`)
        .text("📦 All Products", "hex:products")
        .row()
        .text("➕ Add Another", "hex:product_add"),
    },
  );
}

async function applyOrderDecline(ctx: BotContext, orderId: number, reason: string): Promise<void> {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
  if (!order) {
    await ctx.answerCallbackQuery({ text: "Order not found", show_alert: true }).catch(() => {});
    return;
  }
  if (order.status === "confirmed") {
    await ctx.answerCallbackQuery({ text: "Already confirmed", show_alert: true }).catch(() => {});
    return;
  }
  await db.update(ordersTable).set({ status: "declined", updatedAt: new Date() }).where(eq(ordersTable.id, orderId));
  await db
    .update(paymentRequestsTable)
    .set({ status: "declined" })
    .where(eq(paymentRequestsTable.orderId, orderId))
    .catch(() => {});
  const buyerMsg =
    `❌ PAYMENT DECLINED — ORDER #${orderId}\n━━━━━━━━━━━━━━━━━━\n\n` +
    `${reason}\n\n` +
    `If this is a mistake, contact support or place a new order after paying.`;
  await ctx.api.sendMessage(order.userId, buyerMsg).catch(() => {});
  await ctx.answerCallbackQuery({ text: "Declined" }).catch(() => {});
  await ctx
    .editMessageText(
      `❌ Order #${orderId} declined.\n\nReason sent to customer:\n${reason}`,
      { reply_markup: new InlineKeyboard().text("📋 Orders", "hex:orders") },
    )
    .catch(() =>
      ctx.reply(`❌ Order #${orderId} declined.\nReason: ${reason}`, {
        reply_markup: new InlineKeyboard().text("📋 Orders", "hex:orders"),
      }),
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
      await ctx.reply("💰 Price? (e.g. 15.00 USD):");
      break;
    case "hex:product_price": {
      const price = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(price) || price <= 0) {
        ctx.session.pendingAction = "hex:product_price";
        await ctx.reply("❌ Invalid price. Enter a number like 9.99:");
        return;
      }
      ctx.session.hexDraft = { ...ctx.session.hexDraft, price: price.toFixed(2) };
      ctx.session.pendingAction = "hex:product_desc";
      await ctx.reply("📝 Description? (type /skip to leave blank):");
      break;
    }
    case "hex:product_desc":
      ctx.session.hexDraft = {
        ...ctx.session.hexDraft,
        description: text === "/skip" || text.toLowerCase() === "skip" ? undefined : text.trim(),
      };
      ctx.session.pendingAction = undefined;
      await ctx.reply("📁 Choose category:", { reply_markup: categoryKeyboard() });
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
      const id = ctx.session.hexDraft?.editId ?? ctx.session.hexEditId;
      if (!id) return;
      await db.update(productsTable).set({ name: text.trim(), updatedAt: new Date() }).where(eq(productsTable.id, id));
      ctx.session.pendingAction = undefined;
      ctx.session.hexEditId = undefined;
      if (ctx.session.hexDraft) ctx.session.hexDraft.editId = undefined;
      await ctx.reply("✅ Name updated.", {
        reply_markup: new InlineKeyboard().text("🔙 View", `hex:pview:${id}`).text("📦 Products", "hex:products"),
      });
      break;
    }
    case "hex:edit_price": {
      const id = ctx.session.hexDraft?.editId ?? ctx.session.hexEditId;
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
      if (ctx.session.hexDraft) ctx.session.hexDraft.editId = undefined;
      await ctx.reply("✅ Price updated.", {
        reply_markup: new InlineKeyboard().text("🔙 View", `hex:pview:${id}`).text("📦 Products", "hex:products"),
      });
      break;
    }
    case "hex:edit_desc": {
      const id = ctx.session.hexDraft?.editId ?? ctx.session.hexEditId;
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
      if (ctx.session.hexDraft) ctx.session.hexDraft.editId = undefined;
      await ctx.reply("✅ Description updated.", {
        reply_markup: new InlineKeyboard().text("🔙 View", `hex:pview:${id}`).text("📦 Products", "hex:products"),
      });
      break;
    }
    case "hex:edit_stock": {
      const id = ctx.session.hexDraft?.editId ?? ctx.session.hexEditId;
      if (!id) return;
      const raw = text.trim().toLowerCase();
      let stockVal: string;
      if (raw === "unlimited" || raw === "0" || raw === "inf") {
        stockVal = "0";
      } else {
        const n = parseInt(raw.replace(/[^0-9]/g, ""), 10);
        if (!Number.isFinite(n) || n < 0) {
          ctx.session.pendingAction = "hex:edit_stock";
          await ctx.reply('❌ Enter a number (e.g. 10) or "unlimited":');
          return;
        }
        stockVal = String(n);
      }
      await db
        .update(productsTable)
        .set({
          stock: stockVal,
          isActive: stockVal === "0" || Number(stockVal) > 0,
          updatedAt: new Date(),
        })
        .where(eq(productsTable.id, id));
      ctx.session.pendingAction = undefined;
      ctx.session.hexEditId = undefined;
      if (ctx.session.hexDraft) ctx.session.hexDraft.editId = undefined;
      const label = stockVal === "0" ? "Unlimited" : stockVal;
      await ctx.reply(`✅ Stock set to ${label}.`, {
        reply_markup: new InlineKeyboard().text("🔙 View", `hex:pview:${id}`).text("📦 Products", "hex:products"),
      });
      break;
    }
    case "hex:decline_reason": {
      const id = ctx.session.hexDraft?.editId ?? ctx.session.hexEditId;
      if (!id) {
        await ctx.reply("No order selected.");
        return;
      }
      const reason = text.trim() || "Payment was declined.";
      ctx.session.pendingAction = undefined;
      ctx.session.hexEditId = undefined;
      if (ctx.session.hexDraft) ctx.session.hexDraft.editId = undefined;
      await applyOrderDecline(ctx, id, reason);
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
    await ctx.reply(`🔮 HEX CONTROL PANEL\n━━━━━━━━━━━━━━━━━━\n\nFull control over your CardShop.`, {
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
    try {
      await ctx.editMessageText(`🔮 HEX CONTROL PANEL\n━━━━━━━━━━━━━━━━━━\n\nFull control over your CardShop.`, {
        reply_markup: hexPanelKeyboard(),
      });
    } catch {
      await ctx.reply(`🔮 HEX CONTROL PANEL\n━━━━━━━━━━━━━━━━━━\n\nFull control over your CardShop.`, {
        reply_markup: hexPanelKeyboard(),
      });
    }
  });

  bot.callbackQuery("hex:products", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const products = await db.select().from(productsTable).orderBy(desc(productsTable.createdAt)).limit(40);
    const kb = new InlineKeyboard();
    for (const p of products) {
      const flag = p.isActive ? "✅" : "⏸";
      kb.text(`${flag} #${p.id} ${p.name} — $${parseFloat(String(p.price)).toFixed(2)}`, `hex:pview:${p.id}`).row();
    }
    kb.text("➕ Add Product", "hex:product_add").row().text("🔙 Hex", "hex:main");
    const listText =
      `📦 PRODUCTS\n━━━━━━━━━━━━━━━━━━\n\n` +
      (products.length === 0 ? "No products yet. Add one!" : "Tap a product to edit, set stock, disable, or delete.");
    try {
      await ctx.editMessageText(listText, { reply_markup: kb });
    } catch {
      await ctx.reply(listText, { reply_markup: kb });
    }
  });

  bot.callbackQuery("hex:product_add", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    ctx.session.hexDraft = {};
    ctx.session.pendingAction = "hex:product_name";
    await ctx.answerCallbackQuery();
    await ctx.reply(`➕ ADD PRODUCT\n━━━━━━━━━━━━━━━━━━\n\nStep 1/4: Product name?`);
  });

  bot.callbackQuery(/^hex:setcat:(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const cat = ctx.match[1]!;
    ctx.session.hexDraft = { ...ctx.session.hexDraft, category: cat };
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText("🚚 Delivery type?", { reply_markup: deliveryTypeKeyboard() });
    } catch {
      await ctx.reply("🚚 Delivery type?", { reply_markup: deliveryTypeKeyboard() });
    }
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
      try {
        await ctx.editMessageText(`⚡ Auto-delivery content\n\nPaste the text/codes the buyer receives after payment:`);
      } catch {
        await ctx.reply(`⚡ Auto-delivery content\n\nPaste the text/codes the buyer receives after payment:`);
      }
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
    await showProductManage(ctx, parseInt(ctx.match[1]!, 10));
  });

  bot.callbackQuery(/^hex:ptoggle:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!, 10);
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, id));
    if (!p) return;
    await db.update(productsTable).set({ isActive: !p.isActive, updatedAt: new Date() }).where(eq(productsTable.id, id));
    await ctx.answerCallbackQuery(p.isActive ? "Disabled" : "Enabled");
    await showProductManage(ctx, id);
  });

  bot.callbackQuery(/^hex:pdelete:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!, 10);
    await db.update(productsTable).set({ isActive: false, updatedAt: new Date() }).where(eq(productsTable.id, id));
    await ctx.answerCallbackQuery("Disabled (soft delete)");
    try {
      await ctx.editMessageText("Product disabled (hidden from shop).", {
        reply_markup: new InlineKeyboard().text("📦 Products", "hex:products"),
      });
    } catch {
      await ctx.reply("Product disabled (hidden from shop).", {
        reply_markup: new InlineKeyboard().text("📦 Products", "hex:products"),
      });
    }
  });

  bot.callbackQuery(/^hex:peditname:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!, 10);
    ctx.session.hexEditId = id;
    ctx.session.hexDraft = { ...(ctx.session.hexDraft || {}), editId: id };
    ctx.session.pendingAction = "hex:edit_name";
    await ctx.answerCallbackQuery();
    await ctx.reply("✏️ New product name?");
  });

  bot.callbackQuery(/^hex:peditprice:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!, 10);
    ctx.session.hexEditId = id;
    ctx.session.hexDraft = { ...(ctx.session.hexDraft || {}), editId: id };
    ctx.session.pendingAction = "hex:edit_price";
    await ctx.answerCallbackQuery();
    await ctx.reply("💰 New price? (e.g. 12.50)");
  });

  bot.callbackQuery(/^hex:peditdesc:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!, 10);
    ctx.session.hexEditId = id;
    ctx.session.hexDraft = { ...(ctx.session.hexDraft || {}), editId: id };
    ctx.session.pendingAction = "hex:edit_desc";
    await ctx.answerCallbackQuery();
    await ctx.reply("📝 New description? (/skip to clear)");
  });

  bot.callbackQuery(/^hex:peditstock:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!, 10);
    ctx.session.hexEditId = id;
    ctx.session.hexDraft = { ...(ctx.session.hexDraft || {}), editId: id };
    ctx.session.pendingAction = "hex:edit_stock";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      "📦 Stock quantity?\n\n• Number e.g. 5 = five units (deducts on each sale)\n• 0 or unlimited = never runs out",
    );
  });

  bot.callbackQuery(/^hex:peditcat:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!, 10);
    await ctx.answerCallbackQuery();
    await ctx.reply("📁 Choose new category:", { reply_markup: categoryKeyboardForEdit(id) });
  });

  bot.callbackQuery(/^hex:applycat:(\d+):(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!, 10);
    const cat = ctx.match[2]!;
    await db.update(productsTable).set({ category: cat, updatedAt: new Date() }).where(eq(productsTable.id, id));
    await ctx.answerCallbackQuery(`Category → ${cat}`);
    await showProductManage(ctx, id);
  });

  bot.callbackQuery("hex:orders", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const orders = await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(20);
    if (orders.length === 0) {
      await ctx
        .editMessageText("📋 No orders yet.", { reply_markup: new InlineKeyboard().text("🔙 Hex", "hex:main") })
        .catch(() => ctx.reply("📋 No orders yet.", { reply_markup: new InlineKeyboard().text("🔙 Hex", "hex:main") }));
      return;
    }
    const kb = new InlineKeyboard();
    for (const o of orders) {
      kb.text(`#${o.id} ${o.status}`, `hex:oview:${o.id}`).row();
    }
    kb.text("🔙 Hex", "hex:main");
    await ctx.editMessageText(`📋 ORDERS (${orders.length})`, { reply_markup: kb }).catch(() =>
      ctx.reply(`📋 ORDERS (${orders.length})`, { reply_markup: kb }),
    );
  });

  bot.callbackQuery(/^hex:oview:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const id = parseInt(ctx.match[1]!, 10);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
    if (!order) {
      await ctx.reply("Order not found.");
      return;
    }
    const bankMatch = order.details?.match(/^BANKLOG:(\d+)$/);
    let productLabel = "?";
    if (bankMatch) {
      const [log] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, parseInt(bankMatch[1]!, 10)));
      productLabel = log ? `Bank Log #${log.id} ${log.bankName}` : `Bank Log ${bankMatch[1]}`;
    } else {
      const [product] = await db.select().from(productsTable).where(eq(productsTable.id, order.productId));
      productLabel = product?.name ?? "?";
    }
    const [pr] = await db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.orderId, id));
    const kb = new InlineKeyboard();
    if (order.status === "pending" || order.status === "claimed") {
      kb.text("✅ Confirm payment", `hex:oconfirm:${id}`).row();
      kb.text("❌ Decline payment", `hex:odecline:${id}`).row();
    }
    kb.text("🔙 Orders", "hex:orders");
    const text =
      `📋 ORDER #${id}\n━━━━━━━━━━━━━━━━━━\n\n` +
      `User: ${order.userId}\n` +
      `Product: ${productLabel}\n` +
      `Status: ${order.status}\n` +
      (pr ? `Pay: ${pr.amount} ${pr.coin}\n` : "");
    try {
      await ctx.editMessageText(text, { reply_markup: kb });
    } catch {
      await ctx.reply(text, { reply_markup: kb });
    }
  });

  bot.callbackQuery(/^hex:oconfirm:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!, 10);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
    if (!order) return;
    if (order.status === "confirmed") {
      await ctx.answerCallbackQuery({ text: "Already confirmed", show_alert: true });
      return;
    }
    await db.update(ordersTable).set({ status: "confirmed", updatedAt: new Date() }).where(eq(ordersTable.id, id));
    await db
      .update(paymentRequestsTable)
      .set({ status: "confirmed", confirmedAt: new Date() })
      .where(eq(paymentRequestsTable.orderId, id))
      .catch(() => {});
    const bankMatch = order.details?.match(/^BANKLOG:(\d+)$/);
    if (!bankMatch && order.productId > 0) {
      await deductProductStock(order.productId, order.quantity ?? 1);
    }
    let buyerMsg = `✅ Order #${id} confirmed`;
    if (bankMatch) {
      const logId = parseInt(bankMatch[1]!, 10);
      const [log] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, logId));
      if (log) {
        await db
          .update(bankLogsTable)
          .set({ status: "sold", isSold: true, soldAt: new Date() })
          .where(eq(bankLogsTable.id, logId));
        buyerMsg +=
          `\n\n🏦 ${log.bankName} · ${log.country}\n\n🎁 Delivery:\n` +
          (log.loginUrl ? `URL: ${log.loginUrl}\n` : "") +
          (log.username ? `User: ${log.username}\n` : "") +
          (log.password ? `Pass: ${log.password}\n` : "") +
          (log.extras ? `Extras: ${log.extras}\n` : "") +
          (log.notes ? `Notes: ${log.notes}\n` : "");
      } else {
        buyerMsg += `\n\nBank log delivery — contact support if details missing.`;
      }
    } else {
      const [product] = await db.select().from(productsTable).where(eq(productsTable.id, order.productId));
      buyerMsg += `\n\n📦 ${product?.name ?? "Your order"}`;
      if (product?.deliveryType === "auto" && product.deliveryContent) {
        buyerMsg += `\n\n🎁 Delivery:\n${product.deliveryContent}`;
      } else {
        buyerMsg += `\n\nSeller will deliver shortly.`;
      }
    }
    await ctx.api.sendMessage(order.userId, buyerMsg).catch(() => {});
    await ctx.answerCallbackQuery("Confirmed");
    await ctx
      .editMessageText(`✅ Order #${id} confirmed. Stock updated if applicable.`, {
        reply_markup: new InlineKeyboard().text("📋 Orders", "hex:orders"),
      })
      .catch(() => {});
  });

  bot.callbackQuery(/^hex:ocancel:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!, 10);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
    await db.update(ordersTable).set({ status: "cancelled", updatedAt: new Date() }).where(eq(ordersTable.id, id));
    await db
      .update(paymentRequestsTable)
      .set({ status: "cancelled" })
      .where(eq(paymentRequestsTable.orderId, id))
      .catch(() => {});
    if (order) {
      await ctx.api
        .sendMessage(
          order.userId,
          `❌ Order #${id} was cancelled.\n\nIf you already paid, contact the seller with your transaction proof.`,
        )
        .catch(() => {});
    }
    await ctx.answerCallbackQuery("Cancelled");
    await ctx
      .editMessageText(`❌ Order #${id} cancelled.`, {
        reply_markup: new InlineKeyboard().text("📋 Orders", "hex:orders"),
      })
      .catch(() => {});
  });

  bot.callbackQuery(/^hex:odecline:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!, 10);
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text("You have not paid", `hex:odecline_reason:${id}:not_paid`)
      .row()
      .text("Wrong amount", `hex:odecline_reason:${id}:wrong_amount`)
      .row()
      .text("Invalid / fake proof", `hex:odecline_reason:${id}:invalid_proof`)
      .row()
      .text("✏️ Custom reason", `hex:odecline_custom:${id}`)
      .row()
      .text("🔙 Back", `hex:oview:${id}`);
    await ctx
      .editMessageText(
        `❌ DECLINE ORDER #${id}\n━━━━━━━━━━━━━━━━━━\n\nChoose a reason to send the customer:`,
        { reply_markup: kb },
      )
      .catch(() => ctx.reply(`❌ Decline order #${id} — choose a reason:`, { reply_markup: kb }));
  });

  bot.callbackQuery(/^hex:odecline_reason:(\d+):(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!, 10);
    const code = ctx.match[2]!;
    const reasons: Record<string, string> = {
      not_paid: "You have not paid. No payment was received for this order.",
      wrong_amount: "Payment amount does not match the order total. Please pay the exact amount.",
      invalid_proof: "Payment proof is invalid or could not be verified.",
    };
    await applyOrderDecline(ctx, id, reasons[code] ?? "Payment was declined.");
  });

  bot.callbackQuery(/^hex:odecline_custom:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    const id = parseInt(ctx.match[1]!, 10);
    ctx.session.hexDraft = { ...(ctx.session.hexDraft || {}), editId: id };
    ctx.session.pendingAction = "hex:decline_reason";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `✏️ Custom decline reason for order #${id}\n\nType the message the customer will see (e.g. "You have not paid"):`,
    );
  });

  bot.callbackQuery("hex:payments", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx
      .editMessageText(
        `💰 PAYMENT SETTINGS\n━━━━━━━━━━━━━━━━━━\n\nCryptoBot: set CRYPTOBOT_API_TOKEN on Render.\nManual wallets: configure in env / payments panel.`,
        { reply_markup: new InlineKeyboard().text("🔙 Hex", "hex:main") },
      )
      .catch(() => {});
  });

  bot.callbackQuery("hex:stats", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const products = await db.select().from(productsTable);
    const active = products.filter((p) => p.isActive).length;
    const finite = products.filter((p) => p.isActive && !isUnlimitedStock(p.stock));
    const { revenue, confirmedOrders, pendingOrders } = await getConfirmedRevenue();
    const stockLines = finite
      .slice(0, 8)
      .map((p) => `  · ${p.name}: ${stockLabel(p.stock, p.isActive)} left`)
      .join("\n");
    await ctx
      .editMessageText(
        `📊 STATS\n━━━━━━━━━━━━━━━━━━\n\n` +
          `📦 Products: ${products.length} (${active} active)\n` +
          `📋 Orders: ${confirmedOrders} confirmed · ${pendingOrders} pending\n` +
          `💰 Revenue (confirmed): $${revenue.toFixed(2)}\n` +
          (stockLines ? `\n📉 Finite stock:\n${stockLines}` : "\n📉 Finite stock: none (all unlimited)"),
        { reply_markup: new InlineKeyboard().text("🔙 Hex", "hex:main") },
      )
      .catch(() => {});
  });

  bot.callbackQuery("hex:access", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx
      .editMessageText(
        `🔑 ACCESS\n━━━━━━━━━━━━━━━━━━\n\nUse /access for the full access panel (users, invites, tiers).`,
        { reply_markup: new InlineKeyboard().text("🔙 Hex", "hex:main") },
      )
      .catch(() => {});
  });
}
