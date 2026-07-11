import { InlineKeyboard } from "grammy";
import { eq, desc, and, count, sum } from "drizzle-orm";
import { db, productsTable, ordersTable, paymentSettingsTable, paymentRequestsTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

// ── Category helpers ─────────────────────────────────────────────────────────
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

// ── Keyboards ────────────────────────────────────────────────────────────────
function hexPanelKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📦 Products", "hex:products")
    .text("📋 Orders", "hex:orders")
    .row()
    .text("💰 Payments", "hex:payments")
    .text("📊 Stats", "hex:stats")
    .row()
    .text("🩺 Harmony DB", "extdblogs:main")
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

// ── Helpers ──────────────────────────────────────────────────────────────────
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

// ── Text input processor ─────────────────────────────────────────────────────
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

// ── Register handlers ────────────────────────────────────────────────────────
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
  // ── Main panel ─────────────────────────────────────────────────────────────
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

  // ── Products list ──────────────────────────────────────────────────────────
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

  // ── Add product (multi-step) ───────────────────────────────────────────────
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

  // ── Set category (from add-product flow) ──────────────────────────────────
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

  // ── Set delivery type ──────────────────────────────────────────────────────
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
        `⚡ *Auto-Delivery*\n━━━━━━━━━━━━━━━━━━\n\nType the content to send customers when their payment is confirmed:\n\n_(e.g., account credentials, download link, voucher code)_`,
        { parse_mode: "Markdown" }
      );
    } else {
      await ctx.editMessageText(`✋ *Manual delivery selected.*\n━━━━━━━━━━━━━━━━━━\n\nConfirm product details?`, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✅ Save Product", "hex:product_save")
          .text("❌ Cancel", "hex:products"),
      });
    }
  });

  // ── Save product (manual delivery confirm) ─────────────────────────────────
  bot.callbackQuery("hex:product_save", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    await ctx.answerCallbackQuery();
    await saveNewProduct(ctx);
  });

  // ── View product ───────────────────────────────────────────────────────────
  bot.callbackQuery(/^hex:pview:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    const id = parseInt(ctx.match[1]!);
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, id));
    if (!p) {
      await ctx.answerCallbackQuery("Product not found.");
      return;
    }
    await ctx.answerCallbackQuery();

    const statusLine = p.isActive ? "✅ Active" : "❌ Inactive";
    const deliveryLine = p.deliveryType === "auto" ? "⚡ Auto" : "✋ Manual";
    const hasContent = p.deliveryContent ? "✅ Set" : "❌ Not set";

    const text =
      `${catEmoji(p.category)} *${p.name}*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `💰 Price: *$${parseFloat(p.price).toFixed(2)}*\n` +
      `📁 Category: ${p.category}\n` +
      `🚚 Delivery: ${deliveryLine}${p.deliveryType === "auto" ? ` (${hasContent})` : ""}\n` +
      `📦 Stock: ${parseFloat(p.stock) === 0 ? "Unlimited" : p.stock}\n` +
      `⚡ Status: ${statusLine}\n\n` +
      (p.description ? `📝 _${p.description}_` : "_No description_");

    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text(p.isActive ? "🔴 Deactivate" : "🟢 Activate", `hex:ptoggle:${id}`)
        .text("🗑️ Delete", `hex:pdel:${id}`)
        .row()
        .text("✏️ Name", `hex:peditname:${id}`)
        .text("✏️ Price", `hex:peditprice:${id}`)
        .text("✏️ Desc", `hex:peditdesc:${id}`)
        .row()
        .text("🔙 Products", "hex:products"),
    });
  });

  // ── Toggle product active ──────────────────────────────────────────────────
  bot.callbackQuery(/^hex:ptoggle:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    const id = parseInt(ctx.match[1]!);
    const [p] = await db.select({ isActive: productsTable.isActive }).from(productsTable).where(eq(productsTable.id, id));
    if (!p) { await ctx.answerCallbackQuery("Not found."); return; }
    await db.update(productsTable).set({ isActive: !p.isActive, updatedAt: new Date() }).where(eq(productsTable.id, id));
    await ctx.answerCallbackQuery(p.isActive ? "🔴 Deactivated" : "🟢 Activated");
    // refresh view
    const [updated] = await db.select().from(productsTable).where(eq(productsTable.id, id));
    if (!updated) return;
    const statusLine = updated.isActive ? "✅ Active" : "❌ Inactive";
    await ctx.editMessageText(
      `${catEmoji(updated.category)} *${updated.name}*\n━━━━━━━━━━━━━━━━━━\n\n💰 $${parseFloat(updated.price).toFixed(2)} | ${statusLine}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text(updated.isActive ? "🔴 Deactivate" : "🟢 Activate", `hex:ptoggle:${id}`)
          .text("🗑️ Delete", `hex:pdel:${id}`)
          .row()
          .text("✏️ Name", `hex:peditname:${id}`)
          .text("✏️ Price", `hex:peditprice:${id}`)
          .text("✏️ Desc", `hex:peditdesc:${id}`)
          .row()
          .text("🔙 Products", "hex:products"),
      }
    );
  });

  // ── Delete product ─────────────────────────────────────────────────────────
  bot.callbackQuery(/^hex:pdel:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("⛔ Owner only.");
      return;
    }
    const id = parseInt(ctx.match[1]!);
    await db.delete(productsTable).where(eq(productsTable.id, id));
    await ctx.answerCallbackQuery("🗑️ Deleted");
    await ctx.editMessageText(
      `🗑️ Product deleted.`,
      { reply_markup: new InlineKeyboard().text("📦 Products", "hex:products") }
    );
  });

  // ── Edit product fields ────────────────────────────────────────────────────
  bot.callbackQuery(/^hex:peditname:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    const id = parseInt(ctx.match[1]!);
    ctx.session.hexDraft = { editId: id };
    ctx.session.pendingAction = "hex:edit_name";
    await ctx.answerCallbackQuery();
    await ctx.reply("✏️ Enter new product name:");
  });

  bot.callbackQuery(/^hex:peditprice:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    const id = parseInt(ctx.match[1]!);
    ctx.session.hexDraft = { editId: id };
    ctx.session.pendingAction = "hex:edit_price";
    await ctx.answerCallbackQuery();
    await ctx.reply("✏️ Enter new price (e.g. `12.00`):", { parse_mode: "Markdown" });
  });

  bot.callbackQuery(/^hex:peditdesc:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    const id = parseInt(ctx.match[1]!);
    ctx.session.hexDraft = { editId: id };
    ctx.session.pendingAction = "hex:edit_desc";
    await ctx.answerCallbackQuery();
    await ctx.reply("✏️ Enter new description:");
  });

  // ── Orders ─────────────────────────────────────────────────────────────────
  bot.callbackQuery("hex:orders", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery();
    const [pending, confirmed, cancelled] = await Promise.all([
      db.select({ count: count() }).from(ordersTable).where(eq(ordersTable.status, "pending")),
      db.select({ count: count() }).from(ordersTable).where(eq(ordersTable.status, "confirmed")),
      db.select({ count: count() }).from(ordersTable).where(eq(ordersTable.status, "cancelled")),
    ]);
    const claimed = await db.select({ count: count() }).from(ordersTable).where(eq(ordersTable.status, "claimed"));
    await ctx.editMessageText(
      `📋 *ORDERS*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `⏳ Pending: ${pending[0]?.count ?? 0}\n` +
        `🔔 Claimed: ${claimed[0]?.count ?? 0} _(needs action)_\n` +
        `✅ Confirmed: ${confirmed[0]?.count ?? 0}\n` +
        `❌ Cancelled: ${cancelled[0]?.count ?? 0}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text(`⏳ Pending`, "hex:opending")
          .text(`🔔 Claimed`, "hex:oclaimed")
          .row()
          .text("✅ Confirmed", "hex:oconfirmed")
          .text("❌ Cancelled", "hex:ocancelled")
          .row()
          .text("🔙 Hex Panel", "hex:main"),
      }
    );
  });

  async function showOrderList(ctx: BotContext, status: string, title: string) {
    const orders = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.status, status))
      .orderBy(desc(ordersTable.createdAt))
      .limit(15);

    const kb = new InlineKeyboard();
    for (const o of orders) {
      const [pr] = await db.select({ amount: paymentRequestsTable.amount, coin: paymentRequestsTable.coin })
        .from(paymentRequestsTable).where(eq(paymentRequestsTable.orderId, o.id));
      const prStr = pr ? ` — ${pr.amount} ${pr.coin}` : "";
      kb.text(`#${o.id}${prStr} — UID:${o.userId}`, `hex:oview:${o.id}`).row();
    }
    kb.text("🔙 Orders", "hex:orders");

    await ctx.editMessageText(
      `${title}\n━━━━━━━━━━━━━━━━━━\n\n${orders.length === 0 ? "None yet." : `${orders.length} order(s):`}`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
  }

  bot.callbackQuery("hex:opending", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery();
    await showOrderList(ctx, "pending", "⏳ *PENDING ORDERS*");
  });

  bot.callbackQuery("hex:oclaimed", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery();
    await showOrderList(ctx, "claimed", "🔔 *CLAIMED ORDERS* — needs action");
  });

  bot.callbackQuery("hex:oconfirmed", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery();
    await showOrderList(ctx, "confirmed", "✅ *CONFIRMED ORDERS*");
  });

  bot.callbackQuery("hex:ocancelled", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery();
    await showOrderList(ctx, "cancelled", "❌ *CANCELLED ORDERS*");
  });

  // ── View single order ──────────────────────────────────────────────────────
  bot.callbackQuery(/^hex:oview:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    const orderId = parseInt(ctx.match[1]!);
    await ctx.answerCallbackQuery();

    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    if (!order) { await ctx.editMessageText("Order not found."); return; }

    const [product] = await db.select().from(productsTable).where(eq(productsTable.id, order.productId));
    const [pr] = await db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.orderId, orderId));

    const statusEmoji: Record<string, string> = {
      pending: "⏳", claimed: "🔔", confirmed: "✅", cancelled: "❌",
    };

    const text =
      `📋 *ORDER #${orderId}*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `👤 Customer ID: \`${order.userId}\`\n` +
      `📦 Product: ${product?.name ?? "Unknown"}\n` +
      `📁 Qty: ${order.quantity}\n` +
      `${statusEmoji[order.status] ?? "❓"} Status: *${order.status.toUpperCase()}*\n` +
      (pr
        ? `\n💰 Amount: \`${pr.amount} ${pr.coin}\`\n` +
          `🏦 Address: \`${pr.address}\`\n` +
          `📌 Ref: ${pr.reference}\n` +
          `📊 Pay Status: *${pr.status}*`
        : "\n_No payment request yet._") +
      `\n\n🕐 ${order.createdAt.toLocaleString()}`;

    const kb = new InlineKeyboard();
    if (order.status === "claimed") {
      kb.text("✅ Confirm & Deliver", `hex:oconfirm:${orderId}`)
        .text("❌ Cancel", `hex:ocancel:${orderId}`)
        .row();
    } else if (order.status === "pending") {
      kb.text("❌ Cancel Order", `hex:ocancel:${orderId}`).row();
    }
    kb.text("🔙 Orders", "hex:orders");

    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
  });

  // ── Confirm order ──────────────────────────────────────────────────────────
  bot.callbackQuery(/^hex:oconfirm:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    const orderId = parseInt(ctx.match[1]!);

    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    if (!order) { await ctx.answerCallbackQuery("Order not found."); return; }

    const [product] = await db.select().from(productsTable).where(eq(productsTable.id, order.productId));

    await db.update(ordersTable).set({ status: "confirmed", updatedAt: new Date() }).where(eq(ordersTable.id, orderId));
    await db.update(paymentRequestsTable)
      .set({ status: "confirmed", confirmedAt: new Date() })
      .where(eq(paymentRequestsTable.orderId, orderId));

    await ctx.answerCallbackQuery("✅ Confirmed!");

    // Deliver to customer
    let deliveryMsg =
      `✅ *ORDER CONFIRMED — #${orderId}*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `📦 ${product?.name ?? "Your order"}\n\nThank you! `;

    if (product?.deliveryType === "auto" && product.deliveryContent) {
      deliveryMsg += `Here is your delivery:\n\n${product.deliveryContent}`;
    } else {
      deliveryMsg += `Your order has been confirmed. The seller will deliver shortly.`;
    }

    await ctx.api.sendMessage(order.userId, deliveryMsg, { parse_mode: "Markdown" }).catch(() => {});

    await ctx.editMessageText(
      `✅ *Order #${orderId} confirmed!*\n\nDelivery sent to customer ${order.userId}.`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("📋 Orders", "hex:orders") }
    );
  });

  // ── Cancel order ───────────────────────────────────────────────────────────
  bot.callbackQuery(/^hex:ocancel:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    const orderId = parseInt(ctx.match[1]!);

    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    if (!order) { await ctx.answerCallbackQuery("Not found."); return; }

    await db.update(ordersTable).set({ status: "cancelled", updatedAt: new Date() }).where(eq(ordersTable.id, orderId));
    await db.update(paymentRequestsTable)
      .set({ status: "cancelled" })
      .where(eq(paymentRequestsTable.orderId, orderId));

    await ctx.answerCallbackQuery("❌ Cancelled");

    await ctx.api.sendMessage(
      order.userId,
      `❌ *Order #${orderId} Cancelled*\n━━━━━━━━━━━━━━━━━━\n\nYour order has been cancelled. Contact the seller if this is a mistake.`,
      { parse_mode: "Markdown" }
    ).catch(() => {});

    await ctx.editMessageText(
      `❌ Order #${orderId} cancelled.`,
      { reply_markup: new InlineKeyboard().text("📋 Orders", "hex:orders") }
    );
  });

  // ── Payment settings ───────────────────────────────────────────────────────
  bot.callbackQuery("hex:payments", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery();
    const ownerId = ctx.from.id;
    const s = await getOrCreatePaymentSettings(ownerId);

    function addrLine(label: string, addr: string | null) {
      return addr ? `✅ ${label}: \`${addr.slice(0, 12)}...${addr.slice(-6)}\`` : `❌ ${label}: _Not set_`;
    }

    const text =
      `💰 *PAYMENT SETTINGS*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `${addrLine("BNB / USDT-BEP20", s.bnbAddress)}\n` +
      `${addrLine("USDT-TRC20", s.trc20Address)}\n` +
      `${addrLine("BTC", s.btcAddress)}\n` +
      `${addrLine("ETH", s.ethAddress)}\n` +
      `${s.bnbXpub ? `🔑 xpub: ✅ _Unique addrs enabled_` : `🔑 xpub: ❌ _Not set (static addr)_`}\n\n` +
      `_Customers only see coins you've configured._`;

    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("💛 Set BNB/USDT-BEP20", "hex:set_bnb")
        .row()
        .text("🟢 Set USDT-TRC20", "hex:set_trc20")
        .row()
        .text("🟠 Set BTC", "hex:set_btc")
        .text("⬜ Set ETH", "hex:set_eth")
        .row()
        .text("🔑 Set xpub (unique addrs)", "hex:set_xpub")
        .row()
        .text("🔙 Hex Panel", "hex:main"),
    });
  });

  // Payment field inputs
  const payInputs: Array<[string, string]> = [
    ["hex:set_bnb", "💛 BNB / USDT-BEP20 address:\n\nPaste your BSC wallet address (starts with 0x):"],
    ["hex:set_trc20", "🟢 USDT-TRC20 address:\n\nPaste your Tron wallet address (starts with T):"],
    ["hex:set_btc", "🟠 BTC address:\n\nPaste your Bitcoin wallet address:"],
    ["hex:set_eth", "⬜ ETH address:\n\nPaste your Ethereum wallet address (starts with 0x):"],
    ["hex:set_xpub", "🔑 xpub for BNB/BSC:\n\nPaste your extended public key (xpub/zpub from MetaMask → Account Details → Export xpub).\n\n⚠️ This generates unique addresses. Each order gets its own address."],
  ];

  for (const [cb, prompt] of payInputs) {
    bot.callbackQuery(cb, async (ctx) => {
      if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
      ctx.session.pendingAction = cb;
      await ctx.answerCallbackQuery();
      await ctx.reply(prompt, {
        reply_markup: new InlineKeyboard().text("❌ Cancel", "hex:payments"),
      });
    });
  }

  // ── Stats ──────────────────────────────────────────────────────────────────
  bot.callbackQuery("hex:stats", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("⛔ Owner only."); return; }
    await ctx.answerCallbackQuery();

    const [totalProducts] = await db.select({ count: count() }).from(productsTable);
    const [activeProducts] = await db.select({ count: count() }).from(productsTable).where(eq(productsTable.isActive, true));
    const [totalOrders] = await db.select({ count: count() }).from(ordersTable);
    const [pendingOrders] = await db.select({ count: count() }).from(ordersTable).where(eq(ordersTable.status, "pending"));
    const [claimedOrders] = await db.select({ count: count() }).from(ordersTable).where(eq(ordersTable.status, "claimed"));
    const [confirmedOrders] = await db.select({ count: count() }).from(ordersTable).where(eq(ordersTable.status, "confirmed"));

    const confirmedPayments = await db
      .select({ amount: paymentRequestsTable.amount, coin: paymentRequestsTable.coin })
      .from(paymentRequestsTable)
      .where(eq(paymentRequestsTable.status, "confirmed"));

    const revenueByCoins: Record<string, number> = {};
    for (const p of confirmedPayments) {
      revenueByCoins[p.coin] = (revenueByCoins[p.coin] ?? 0) + parseFloat(p.amount);
    }

    const revenueLines = Object.entries(revenueByCoins)
      .map(([coin, amt]) => `   • ${coin}: ${amt.toFixed(2)}`)
      .join("\n") || "   _No revenue yet_";

    await ctx.editMessageText(
      `📊 *STATS*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `📦 Products: ${totalProducts?.count ?? 0} total, ${activeProducts?.count ?? 0} active\n\n` +
        `📋 Orders:\n` +
        `   ⏳ Pending: ${pendingOrders?.count ?? 0}\n` +
        `   🔔 Claimed: ${claimedOrders?.count ?? 0}\n` +
        `   ✅ Confirmed: ${confirmedOrders?.count ?? 0}\n` +
        `   📊 Total: ${totalOrders?.count ?? 0}\n\n` +
        `💰 Revenue (confirmed):\n${revenueLines}`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Hex Panel", "hex:main") }
    );
  });
}
