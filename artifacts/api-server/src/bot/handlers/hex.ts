import { InlineKeyboard } from "grammy";
import { eq, desc } from "drizzle-orm";
import {
  db,
  productsTable,
  ordersTable,
  paymentSettingsTable,
  paymentRequestsTable,
} from "@workspace/db";
import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";

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

function stockLabel(stock: string | number | null | undefined): string {
  const n = Number(stock);
  if (!Number.isFinite(n) || n === 0 || n >= 9999) return "Unlimited";
  if (n < 0) return "Out of stock";
  return String(n);
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
    .text(isActive ? "⏸ Disable" : "▶️ Enable", `hex:ptoggle:${id}`)
    .text("🗑 Delete", `hex:pdelete:${id}`)
    .row()
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
    `Stock: ${stockLabel(p.stock)}\n` +
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
      // 0 = unlimited digital stock (shown as Unlimited everywhere)
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
      `Tap Manage to edit it now.`,
    {
      reply_markup: new InlineKeyboard()
        .text("⚙️ Manage", `hex:pview:${pid}`)
        .text("📦 All Products", "hex:products")
        .row()
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
      (products.length === 0
        ? "No products yet. Add one!"
        : "Tap a product to edit, disable, change category, or delete.");
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
        await ctx.editMessageText(
          `⚡ Auto-delivery content\n\nPaste the text/codes the buyer receives after payment:`,
        );
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
        .editMessageText("📋 No orders yet.", {
          reply_markup: new InlineKeyboard().text("🔙 Hex", "hex:main"),
        })
        .catch(() =>
          ctx.reply("📋 No orders yet.", {
            reply_markup: new InlineKeyboard().text("🔙 Hex", "hex:main"),
          }),
        );
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
    const [product] = await db.select().from(productsTable).where(eq(productsTable.id, order.productId));
    const [pr] = await db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.orderId, id));
    const kb = new InlineKeyboard();
    if (order.status === "pending" || order.status === "claimed") {
      kb.text("✅ Confirm", `hex:oconfirm:${id}`).text("❌ Cancel", `hex:ocancel:${id}`).row();
    }
    kb.text("🔙 Orders", "hex:orders");
    const text =
      `📋 ORDER #${id}\n━━━━━━━━━━━━━━━━━━\n\n` +
      `User: ${order.userId}\n` +
      `Product: ${product?.name ?? "?"}\n` +
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
    await db.update(ordersTable).set({ status: "confirmed", updatedAt: new Date() }).where(eq(ordersTable.id, id));
    await db
      .update(paymentRequestsTable)
      .set({ status: "confirmed", confirmedAt: new Date() })
      .where(eq(paymentRequestsTable.orderId, id))
      .catch(() => {});
    const [product] = await db.select().from(productsTable).where(eq(productsTable.id, order.productId));
    let buyerMsg = `✅ Order #${id} confirmed\n\n📦 ${product?.name ?? "Your order"}`;
    if (product?.deliveryType === "auto" && product.deliveryContent) {
      buyerMsg += `\n\n🎁 Delivery:\n${product.deliveryContent}`;
    } else {
      buyerMsg += `\n\nSeller will deliver shortly.`;
    }
    await ctx.api.sendMessage(order.userId, buyerMsg).catch(() => {});
    await ctx.answerCallbackQuery("Confirmed");
    await ctx
      .editMessageText(`✅ Order #${id} confirmed.`, {
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
    await db.update(ordersTable).set({ status: "cancelled", updatedAt: new Date() }).where(eq(ordersTable.id, id));
    await ctx.answerCallbackQuery("Cancelled");
    await ctx
      .editMessageText(`❌ Order #${id} cancelled.`, {
        reply_markup: new InlineKeyboard().text("📋 Orders", "hex:orders"),
      })
      .catch(() => {});
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
    const orders = await db.select().from(ordersTable);
    const active = products.filter((p) => p.isActive).length;
    const confirmed = orders.filter((o) => o.status === "confirmed").length;
    await ctx
      .editMessageText(
        `📊 STATS\n━━━━━━━━━━━━━━━━━━\n\n📦 Products: ${products.length} (${active} active)\n📋 Orders: ${orders.length} (${confirmed} confirmed)`,
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
