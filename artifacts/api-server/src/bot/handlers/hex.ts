import { InlineKeyboard } from "grammy";
import { eq, desc, and, count, sum } from "drizzle-orm";
import { db, productsTable, ordersTable, paymentSettingsTable, paymentRequestsTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

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
    .text("🔐 Access Control", "hex:access")
    .row()
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
  const rows = await db
    .select()
    .from(paymentSettingsTable)
    .where(eq(paymentSettingsTable.ownerId, ownerId));
  if (rows[0]) return rows[0];
  const [created] = await db
    .insert(paymentSettingsTable)
    .values({ ownerId })
    .returning();
  return created!;
}

async function setPaymentField(
  ownerId: number,
  field: "bnbAddress" | "trc20Address" | "btcAddress" | "ethAddress" | "bnbXpub",
  value: string
) {
  const existing = await db
    .select({ id: paymentSettingsTable.id })
    .from(paymentSettingsTable)
    .where(eq(paymentSettingsTable.ownerId, ownerId));
  if (existing[0]) {
    await db
      .update(paymentSettingsTable)
      .set({ [field]: value, updatedAt: new Date() })
      .where(eq(paymentSettingsTable.ownerId, ownerId));
  } else {
    await db
      .insert(paymentSettingsTable)
      .values({ ownerId, [field]: value });
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
      category: draft.category ?? "general",
      deliveryType: draft.deliveryType ?? "manual",
      deliveryContent: draft.deliveryContent ?? null,
      isActive: true,
      stock: "0",
    })
    .returning();

  ctx.session.hexDraft = {};

  const emoji = catEmoji(draft.category ?? "general");
  await ctx.reply(
    `✅ *Product Added!*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `${emoji} ${draft.name}\n` +
      `💰 $${parseFloat(draft.price).toFixed(2)}\n` +
      `📁 ${draft.category ?? "general"}\n` +
      `🚚 ${draft.deliveryType === "auto" ? "⚡ Auto-delivery" : "✋ Manual"}\n\n` +
      `Product ID: #${product?.id ?? "?"}`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("📦 All Products", "hex:products")
        .text("➕ Add Another", "hex:product_add"),
    }
  );
}

export async function processHexInput(ctx: BotContext, action: string, text: string): Promise<void> {
  const ownerId = ctx.from!.id;

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
      if (isNaN(price) || price <= 0) {
        ctx.session.pendingAction = "hex:product_price";
        await ctx.reply("❌ Invalid price. Enter a number like `15.00`:", { parse_mode: "Markdown" });
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
      await ctx.reply("📁 *Choose category:*", {
        parse_mode: "Markdown",
        reply_markup: categoryKeyboard(),
      });
      break;

    case "hex:product_delivery_content":
      if (!text.trim()) {
        ctx.session.pendingAction = "hex:product_delivery_content";
        await ctx.reply("❌ Delivery content cannot be empty. Enter what to send customers:");
        return;
      }
      ctx.session.hexDraft = { ...ctx.session.hexDraft, deliveryContent: text.trim() };
      await saveNewProduct(ctx);
      break;

    case "hex:edit_name": {
      const { editId } = ctx.session.hexDraft ?? {};
      if (!editId) return;
      await db.update(productsTable).set({ name: text.trim(), updatedAt: new Date() }).where(eq(productsTable.id, editId));
      ctx.session.hexDraft = {};
      await ctx.reply(`✅ Name updated to "${text.trim()}".`, {
        reply_markup: new InlineKeyboard().text("📦 Back", `hex:pview:${editId}`),
      });
      break;
    }

    case "hex:edit_price": {
      const { editId } = ctx.session.hexDraft ?? {};
      if (!editId) return;
      const p = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (isNaN(p) || p <= 0) {
        ctx.session.pendingAction = "hex:edit_price";
        await ctx.reply("❌ Invalid price. Try again:");
        return;
      }
      await db.update(productsTable).set({ price: p.toFixed(2), updatedAt: new Date() }).where(eq(productsTable.id, editId));
      ctx.session.hexDraft = {};
      await ctx.reply(`✅ Price updated to $${p.toFixed(2)}.`, {
        reply_markup: new InlineKeyboard().text("📦 Back", `hex:pview:${editId}`),
      });
      break;
    }

    case "hex:edit_desc": {
      const { editId } = ctx.session.hexDraft ?? {};
      if (!editId) return;
      await db.update(productsTable).set({ description: text.trim(), updatedAt: new Date() }).where(eq(productsTable.id, editId));
      ctx.session.hexDraft = {};
      await ctx.reply(`✅ Description updated.`, {
        reply_markup: new InlineKeyboard().text("📦 Back", `hex:pview:${editId}`),
      });
      break;
    }

    case "hex:set_bnb":
      await setPaymentField(ownerId, "bnbAddress", text.trim());
      await ctx.reply("✅ BNB / USDT-BEP20 address saved.", {
        reply_markup: new InlineKeyboard().text("💰 Payment Settings", "hex:payments"),
      });
      break;

    case "hex:set_trc20":
      await setPaymentField(ownerId, "trc20Address", text.trim());
      await ctx.reply("✅ USDT-TRC20 address saved.", {
        reply_markup: new InlineKeyboard().text("💰 Payment Settings", "hex:payments"),
      });
      break;

    case "hex:set_btc":
      await setPaymentField(ownerId, "btcAddress", text.trim());
      await ctx.reply("✅ BTC address saved.", {
        reply_markup: new InlineKeyboard().text("💰 Payment Settings", "hex:payments"),
      });
      break;

    case "hex:set_eth":
      await setPaymentField(ownerId, "ethAddress", text.trim());
      await ctx.reply("✅ ETH address saved.", {
        reply_markup: new InlineKeyboard().text("💰 Payment Settings", "hex:payments"),
      });
      break;

    case "hex:set_xpub":
      await setPaymentField(ownerId, "bnbXpub", text.trim());
      await ctx.reply(
        "✅ *xpub saved!* Unique BNB/USDT-BEP20 addresses will now be generated per order.",
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("💰 Payment Settings", "hex:payments"),
        }
      );
      break;

    default:
      break;
  }
}

export function registerHexHandlers(bot: MyBot): void {
  bot.command("hex", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("⛔ Owner-only command.");
      return;
    }
    await ctx.reply(
      `🔮 *HEX CONTROL PANEL*\n━━━━━━━━━━━━━━━━━━\n\nFull control over your CardShop.`,
      { parse_mode: "Markdown", reply_markup: hexPanelKeyboard() }
    );
  });
}

export function registerHexCallbacks(bot: MyBot): void {
  bot.callbackQuery("hex:main", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    await ctx.editMessageText(
      `🔮 *HEX CONTROL PANEL*\n━━━━━━━━━━━━━━━━━━\n\nFull control over your CardShop.`,
      { parse_mode: "Markdown", reply_markup: hexPanelKeyboard() }
    );
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("hex:products", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    await ctx.answerCallbackQuery();
    const products = await db.select().from(productsTable).orderBy(desc(productsTable.createdAt));

    const kb = new InlineKeyboard().text("➕ Add Product", "hex:product_add").row();
    for (const p of products) {
      const status = p.isActive ? "✅" : "❌";
      kb.text(`${status} ${catEmoji(p.category)} ${p.name} — $${parseFloat(p.price).toFixed(2)}`, `hex:pview:${p.id}`).row();
    }
    kb.text("🔙 Hex Panel", "hex:main");

    await ctx.editMessageText(
      `📦 *PRODUCTS* (${products.length})\n━━━━━━━━━━━━━━━━━━\n\n` +
        (products.length === 0 ? "No products yet. Add one!" : "Click a product to manage it."),
      { parse_mode: "Markdown", reply_markup: kb }
    );
  });

  bot.callbackQuery("hex:product_add", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    ctx.session.hexDraft = {};
    ctx.session.pendingAction = "hex:product_name";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `➕ *ADD PRODUCT*\n━━━━━━━━━━━━━━━━━━\n\nStep 1/4: *Product name?*`,
      { parse_mode: "Markdown" }
    );
  });

  bot.callbackQuery(/^hex:setcat:(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    const cat = ctx.match[1] ?? "general";
    ctx.session.hexDraft = { ...ctx.session.hexDraft, category: cat };
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `📁 Category: *${cat}*\n━━━━━━━━━━━━━━━━━━\n\nStep 4/4: *Delivery type?*`,
      { parse_mode: "Markdown", reply_markup: deliveryTypeKeyboard() }
    );
  });

  bot.callbackQuery(/^hex:setdelivery:(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    const dtype = ctx.match[1] as "manual" | "auto";
    ctx.session.hexDraft = { ...ctx.session.hexDraft, deliveryType: dtype };
    await ctx.answerCallbackQuery();

    if (dtype === "auto") {
      ctx.session.pendingAction = "hex:product_delivery_content";
      await ctx.editMessageText(
        `⚡ *Auto-delivery selected*\n━━━━━━━━━━━━━━━━━━\n\nPaste the content customers receive after payment:`,
        { parse_mode: "Markdown" }
      );
    } else {
      await saveNewProduct(ctx);
    }
  });

  bot.callbackQuery(/^hex:pview:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    const id = Number(ctx.match[1]);
    await ctx.answerCallbackQuery();
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, id));
    if (!p) {
      await ctx.reply("❌ Product not found.");
      return;
    }
    const kb = new InlineKeyboard()
      .text(p.isActive ? "🔴 Deactivate" : "🟢 Activate", `hex:ptoggle:${id}`)
      .row()
      .text("✏️ Name", `hex:peditname:${id}`)
      .text("💰 Price", `hex:peditprice:${id}`)
      .row()
      .text("📝 Description", `hex:peditdesc:${id}`)
      .row()
      .text("🗑️ Delete", `hex:pdelete:${id}`)
      .row()
      .text("🔙 Products", "hex:products");

    await ctx.editMessageText(
      `📦 *${p.name}*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `💰 Price: $${parseFloat(p.price).toFixed(2)}\n` +
        `📁 Category: ${p.category}\n` +
        `🚚 Delivery: ${p.deliveryType}\n` +
        `Status: ${p.isActive ? "✅ Active" : "❌ Inactive"}\n` +
        (p.description ? `\n${p.description}` : ""),
      { parse_mode: "Markdown", reply_markup: kb }
    );
  });

  bot.callbackQuery(/^hex:ptoggle:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    const id = Number(ctx.match[1]);
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, id));
    if (!p) {
      await ctx.answerCallbackQuery("Not found");
      return;
    }
    await db.update(productsTable).set({ isActive: !p.isActive, updatedAt: new Date() }).where(eq(productsTable.id, id));
    await ctx.answerCallbackQuery(p.isActive ? "Deactivated" : "Activated");
    await ctx.editMessageText(
      `📦 *${p.name}*\n━━━━━━━━━━━━━━━━━━\n\nStatus toggled to *${!p.isActive ? "Active" : "Inactive"}*`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🔙 View", `hex:pview:${id}`).text("📦 Products", "hex:products"),
      }
    );
  });

  bot.callbackQuery(/^hex:peditname:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    const id = Number(ctx.match[1]);
    ctx.session.hexDraft = { editId: id };
    ctx.session.pendingAction = "hex:edit_name";
    await ctx.answerCallbackQuery();
    await ctx.reply("✏️ New product name?");
  });

  bot.callbackQuery(/^hex:peditprice:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    const id = Number(ctx.match[1]);
    ctx.session.hexDraft = { editId: id };
    ctx.session.pendingAction = "hex:edit_price";
    await ctx.answerCallbackQuery();
    await ctx.reply("💰 New price? (e.g. 15.00)");
  });

  bot.callbackQuery(/^hex:peditdesc:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    const id = Number(ctx.match[1]);
    ctx.session.hexDraft = { editId: id };
    ctx.session.pendingAction = "hex:edit_desc";
    await ctx.answerCallbackQuery();
    await ctx.reply("📝 New description?");
  });

  bot.callbackQuery(/^hex:pdelete:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    const id = Number(ctx.match[1]);
    await db.delete(productsTable).where(eq(productsTable.id, id));
    await ctx.answerCallbackQuery("🗑️ Deleted");
    await ctx.editMessageText(`🗑️ Product deleted.`, {
      reply_markup: new InlineKeyboard().text("📦 Products", "hex:products"),
    });
  });

  bot.callbackQuery("hex:orders", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    await ctx.answerCallbackQuery();
    const orders = await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(20);
    const lines =
      orders.length === 0
        ? "No orders yet."
        : orders
            .map(
              (o) =>
                `• #${o.id} | Product ${o.productId} | Qty ${o.quantity} | *${o.status}*`,
            )
            .join("\n");
    await ctx.editMessageText(
      `📋 *ORDERS* (latest 20)\n━━━━━━━━━━━━━━━━━━\n\n${lines}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🔙 Hex Panel", "hex:main"),
      }
    );
  });

  bot.callbackQuery("hex:payments", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    await ctx.answerCallbackQuery();
    const settings = await getOrCreatePaymentSettings(ctx.from.id);
    await ctx.editMessageText(
      `💰 *PAYMENT SETTINGS*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `BNB/USDT-BEP20: ${settings.bnbAddress ? "✅ set" : "❌ not set"}\n` +
        `USDT-TRC20: ${settings.trc20Address ? "✅ set" : "❌ not set"}\n` +
        `BTC: ${settings.btcAddress ? "✅ set" : "❌ not set"}\n` +
        `ETH: ${settings.ethAddress ? "✅ set" : "❌ not set"}\n` +
        `xpub: ${settings.bnbXpub ? "✅ set" : "❌ not set"}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("💛 Set BNB/USDT-BEP20", "hex:pay_bnb")
          .row()
          .text("Set TRC20", "hex:pay_trc20")
          .row()
          .text("🟠 Set BTC", "hex:pay_btc")
          .text("💠 Set ETH", "hex:pay_eth")
          .row()
          .text("🔑 Set xpub", "hex:pay_xpub")
          .row()
          .text("🔙 Hex Panel", "hex:main"),
      }
    );
  });

  bot.callbackQuery("hex:pay_bnb", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return ctx.answerCallbackQuery("⛔");
    ctx.session.pendingAction = "hex:set_bnb";
    await ctx.answerCallbackQuery();
    await ctx.reply("💛 BNB / USDT-BEP20 address:\n\nPaste your wallet address:");
  });
  bot.callbackQuery("hex:pay_trc20", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return ctx.answerCallbackQuery("⛔");
    ctx.session.pendingAction = "hex:set_trc20";
    await ctx.answerCallbackQuery();
    await ctx.reply("USDT-TRC20 address:\n\nPaste your wallet address:");
  });
  bot.callbackQuery("hex:pay_btc", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return ctx.answerCallbackQuery("⛔");
    ctx.session.pendingAction = "hex:set_btc";
    await ctx.answerCallbackQuery();
    await ctx.reply("🟠 BTC address:\n\nPaste your wallet address:");
  });
  bot.callbackQuery("hex:pay_eth", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return ctx.answerCallbackQuery("⛔");
    ctx.session.pendingAction = "hex:set_eth";
    await ctx.answerCallbackQuery();
    await ctx.reply("💠 ETH address:\n\nPaste your wallet address:");
  });
  bot.callbackQuery("hex:pay_xpub", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) return ctx.answerCallbackQuery("⛔");
    ctx.session.pendingAction = "hex:set_xpub";
    await ctx.answerCallbackQuery();
    await ctx.reply("🔑 xpub for BNB/BSC:\n\nPaste your xpub key:");
  });

  bot.callbackQuery("hex:stats", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    await ctx.answerCallbackQuery();
    const [productCount] = await db.select({ count: count() }).from(productsTable);
    const [orderCount] = await db.select({ count: count() }).from(ordersTable);
    await ctx.editMessageText(
      `📊 *SHOP STATS*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `📦 Products: ${productCount?.count ?? 0}\n` +
        `📋 Orders: ${orderCount?.count ?? 0}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🔙 Hex Panel", "hex:main"),
      }
    );
  });

  bot.callbackQuery("hex:access", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `🔐 *ACCESS CONTROL*\n━━━━━━━━━━━━━━━━━━\n\nUse the main Access menu for invites, OTP, and tier management.`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("🔐 Open Access", "menu:access")
          .row()
          .text("🔙 Hex Panel", "hex:main"),
      }
    );
  });
}
