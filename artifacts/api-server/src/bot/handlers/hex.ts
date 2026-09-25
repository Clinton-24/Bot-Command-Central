import { InlineKeyboard } from "grammy";
import { eq, desc, and, count, sum } from "drizzle-orm";
import { db, productsTable, ordersTable, paymentSettingsTable, paymentRequestsTable } from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { isOwner } from "../helpers";
import { logger } from "../../lib/logger";

// â”€â”€ Category helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const CATEGORY_EMOJIS: Record<string, string> = {
  general: "ðŸ“¦",
  streaming: "ðŸ“º",
  gaming: "ðŸŽ®",
  vpn: "ðŸ›¡ï¸",
  giftcard: "ðŸŽ",
  social: "ðŸ“±",
  cards: "ðŸ’³",
  other: "ðŸŒ",
};

const CATEGORIES: { id: string; label: string }[] = [
  { id: "general", label: "ðŸ“¦ General" },
  { id: "streaming", label: "ðŸ“º Streaming" },
  { id: "gaming", label: "ðŸŽ® Gaming" },
  { id: "vpn", label: "ðŸ›¡ï¸ VPN" },
  { id: "giftcard", label: "ðŸŽ Gift Cards" },
  { id: "social", label: "ðŸ“± Social" },
  { id: "cards", label: "ðŸ’³ Cards" },
  { id: "other", label: "ðŸŒ Other" },
];

function catEmoji(cat: string): string {
  return CATEGORY_EMOJIS[cat] ?? "ðŸ“¦";
}

// â”€â”€ Keyboards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function hexPanelKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("ðŸ“¦ Products", "hex:products")
    .text("ðŸ“‹ Orders", "hex:orders")
    .row()
    .text("ðŸ’° Payments", "hex:payments")
    .text("ðŸ“Š Stats", "hex:stats")
    .row()
    .text("ðŸ” Access Control", "hex:access")
    .row()
    .text("ðŸ  Main Menu", "menu:main");
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
    .text("âœ‹ Manual (I'll deliver)", "hex:setdelivery:manual")
    .row()
    .text("âš¡ Auto (bot sends on confirm)", "hex:setdelivery:auto")
    .row()
    .text("âŒ Cancel", "hex:products");
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    `âœ… *Product Added!*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\n` +
      `${emoji} ${draft.name}\n` +
      `ðŸ’° $${parseFloat(draft.price).toFixed(2)}\n` +
      `ðŸ“ ${draft.category ?? "general"}\n` +
      `ðŸšš ${draft.deliveryType === "auto" ? "âš¡ Auto-delivery" : "âœ‹ Manual"}\n\n` +
      `Product ID: #${product?.id ?? "?"}`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("ðŸ“¦ All Products", "hex:products")
        .text("âž• Add Another", "hex:product_add"),
    }
  );
}

// â”€â”€ Text input processor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export async function processHexInput(ctx: BotContext, action: string, text: string): Promise<void> {
  const ownerId = ctx.from!.id;

  switch (action) {
    case "hex:product_name":
      if (!text.trim()) {
        ctx.session.pendingAction = "hex:product_name";
        await ctx.reply("âŒ Name cannot be empty. Try again:");
        return;
      }
      ctx.session.hexDraft = { ...ctx.session.hexDraft, name: text.trim() };
      ctx.session.pendingAction = "hex:product_price";
      await ctx.reply("ðŸ’° *Price?* (e.g. `15.00` USD):", { parse_mode: "Markdown" });
      break;

    case "hex:product_price": {
      const price = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (isNaN(price) || price <= 0) {
        ctx.session.pendingAction = "hex:product_price";
        await ctx.reply("âŒ Invalid price. Enter a number like `15.00`:", { parse_mode: "Markdown" });
        return;
      }
      ctx.session.hexDraft = { ...ctx.session.hexDraft, price: price.toFixed(2) };
      ctx.session.pendingAction = "hex:product_desc";
      await ctx.reply("ðŸ“ *Description?* (type `/skip` to leave blank):", { parse_mode: "Markdown" });
      break;
    }

    case "hex:product_desc":
      ctx.session.hexDraft = {
        ...ctx.session.hexDraft,
        description: text === "/skip" || text.toLowerCase() === "skip" ? undefined : text.trim(),
      };
      await ctx.reply("ðŸ“ *Choose category:*", {
        parse_mode: "Markdown",
        reply_markup: categoryKeyboard(),
      });
      break;

    case "hex:product_delivery_content":
      if (!text.trim()) {
        ctx.session.pendingAction = "hex:product_delivery_content";
        await ctx.reply("âŒ Delivery content cannot be empty. Enter what to send customers:");
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
      await ctx.reply(`âœ… Name updated to "${text.trim()}".`, {
        reply_markup: new InlineKeyboard().text("ðŸ“¦ Back", `hex:pview:${editId}`),
      });
      break;
    }

    case "hex:edit_price": {
      const { editId } = ctx.session.hexDraft ?? {};
      if (!editId) return;
      const p = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (isNaN(p) || p <= 0) {
        ctx.session.pendingAction = "hex:edit_price";
        await ctx.reply("âŒ Invalid price. Try again:");
        return;
      }
      await db.update(productsTable).set({ price: p.toFixed(2), updatedAt: new Date() }).where(eq(productsTable.id, editId));
      ctx.session.hexDraft = {};
      await ctx.reply(`âœ… Price updated to $${p.toFixed(2)}.`, {
        reply_markup: new InlineKeyboard().text("ðŸ“¦ Back", `hex:pview:${editId}`),
      });
      break;
    }

    case "hex:edit_desc": {
      const { editId } = ctx.session.hexDraft ?? {};
      if (!editId) return;
      await db.update(productsTable).set({ description: text.trim(), updatedAt: new Date() }).where(eq(productsTable.id, editId));
      ctx.session.hexDraft = {};
      await ctx.reply(`âœ… Description updated.`, {
        reply_markup: new InlineKeyboard().text("ðŸ“¦ Back", `hex:pview:${editId}`),
      });
      break;
    }

    case "hex:set_bnb":
      await setPaymentField(ownerId, "bnbAddress", text.trim());
      await ctx.reply("âœ… BNB / USDT-BEP20 address saved.", {
        reply_markup: new InlineKeyboard().text("ðŸ’° Payment Settings", "hex:payments"),
      });
      break;

    case "hex:set_trc20":
      await setPaymentField(ownerId, "trc20Address", text.trim());
      await ctx.reply("âœ… USDT-TRC20 address saved.", {
        reply_markup: new InlineKeyboard().text("ðŸ’° Payment Settings", "hex:payments"),
      });
      break;

    case "hex:set_btc":
      await setPaymentField(ownerId, "btcAddress", text.trim());
      await ctx.reply("âœ… BTC address saved.", {
        reply_markup: new InlineKeyboard().text("ðŸ’° Payment Settings", "hex:payments"),
      });
      break;

    case "hex:set_eth":
      await setPaymentField(ownerId, "ethAddress", text.trim());
      await ctx.reply("âœ… ETH address saved.", {
        reply_markup: new InlineKeyboard().text("ðŸ’° Payment Settings", "hex:payments"),
      });
      break;

    case "hex:set_xpub":
      await setPaymentField(ownerId, "bnbXpub", text.trim());
      await ctx.reply(
        "âœ… *xpub saved!* Unique BNB/USDT-BEP20 addresses will now be generated per order.",
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("ðŸ’° Payment Settings", "hex:payments"),
        }
      );
      break;

    default:
      break;
  }
}

// â”€â”€ Register handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export function registerHexHandlers(bot: MyBot): void {
  bot.command("hex", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.reply("â›” Owner-only command.");
      return;
    }
    await ctx.reply(
      `ðŸ”® *HEX CONTROL PANEL*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\nFull control over your CardShop.`,
      { parse_mode: "Markdown", reply_markup: hexPanelKeyboard() }
    );
  });
}

export function registerHexCallbacks(bot: MyBot): void {
  // â”€â”€ Main panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.callbackQuery("hex:main", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("â›” Owner only.");
      return;
    }
    await ctx.editMessageText(
      `ðŸ”® *HEX CONTROL PANEL*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\nFull control over your CardShop.`,
      { parse_mode: "Markdown", reply_markup: hexPanelKeyboard() }
    );
    await ctx.answerCallbackQuery();
  });

  // â”€â”€ Products list â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.callbackQuery("hex:products", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("â›” Owner only.");
      return;
    }
    await ctx.answerCallbackQuery();
    const products = await db.select().from(productsTable).orderBy(desc(productsTable.createdAt));

    const kb = new InlineKeyboard().text("âž• Add Product", "hex:product_add").row();
    for (const p of products) {
      const status = p.isActive ? "âœ…" : "âŒ";
      kb.text(`${status} ${catEmoji(p.category)} ${p.name} â€” $${parseFloat(p.price).toFixed(2)}`, `hex:pview:${p.id}`).row();
    }
    kb.text("ðŸ”™ Hex Panel", "hex:main");

    await ctx.editMessageText(
      `ðŸ“¦ *PRODUCTS* (${products.length})\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\n` +
        (products.length === 0 ? "No products yet. Add one!" : "Click a product to manage it."),
      { parse_mode: "Markdown", reply_markup: kb }
    );
  });

  // â”€â”€ Add product (multi-step) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.callbackQuery("hex:product_add", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("â›” Owner only.");
      return;
    }
    ctx.session.hexDraft = {};
    ctx.session.pendingAction = "hex:product_name";
    await ctx.answerCallbackQuery();
    await ctx.reply(
      `âž• *ADD PRODUCT*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\nStep 1/4: *Product name?*`,
      { parse_mode: "Markdown" }
    );
  });

  // â”€â”€ Set category (from add-product flow) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.callbackQuery(/^hex:setcat:(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("â›” Owner only.");
      return;
    }
    const cat = ctx.match[1] ?? "general";
    ctx.session.hexDraft = { ...ctx.session.hexDraft, category: cat };
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `ðŸ“ Category: *${cat}*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\nStep 4/4: *Delivery type?*`,
      { parse_mode: "Markdown", reply_markup: deliveryTypeKeyboard() }
    );
  });

  // â”€â”€ Set delivery type â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.callbackQuery(/^hex:setdelivery:(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("â›” Owner only.");
      return;
    }
    const dtype = ctx.match[1] as "manual" | "auto";
    ctx.session.hexDraft = { ...ctx.session.hexDraft, deliveryType: dtype };
    await ctx.answerCallbackQuery();

    if (dtype === "auto") {
      ctx.session.pendingAction = "hex:product_delivery_content";
      await ctx.editMessageText(
        `âš¡ *Auto-Delivery*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\nType the content to send customers when their payment is confirmed:\n\n_(e.g., account credentials, download link, voucher code)_`,
        { parse_mode: "Markdown" }
      );
    } else {
      await ctx.editMessageText(`âœ‹ *Manual delivery selected.*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\nConfirm product details?`, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("âœ… Save Product", "hex:product_save")
          .text("âŒ Cancel", "hex:products"),
      });
    }
  });

  // â”€â”€ Save product (manual delivery confirm) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.callbackQuery("hex:product_save", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("â›” Owner only.");
      return;
    }
    await ctx.answerCallbackQuery();
    await saveNewProduct(ctx);
  });

  // â”€â”€ View product â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.callbackQuery(/^hex:pview:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("â›” Owner only.");
      return;
    }
    const id = parseInt(ctx.match[1]!);
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, id));
    if (!p) {
      await ctx.answerCallbackQuery("Product not found.");
      return;
    }
    await ctx.answerCallbackQuery();

    const statusLine = p.isActive ? "âœ… Active" : "âŒ Inactive";
    const deliveryLine = p.deliveryType === "auto" ? "âš¡ Auto" : "âœ‹ Manual";
    const hasContent = p.deliveryContent ? "âœ… Set" : "âŒ Not set";

    const text =
      `${catEmoji(p.category)} *${p.name}*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\n` +
      `ðŸ’° Price: *$${parseFloat(p.price).toFixed(2)}*\n` +
      `ðŸ“ Category: ${p.category}\n` +
      `ðŸšš Delivery: ${deliveryLine}${p.deliveryType === "auto" ? ` (${hasContent})` : ""}\n` +
      `ðŸ“¦ Stock: ${parseFloat(p.stock) === 0 ? "Unlimited" : p.stock}\n` +
      `âš¡ Status: ${statusLine}\n\n` +
      (p.description ? `ðŸ“ _${p.description}_` : "_No description_");

    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text(p.isActive ? "ðŸ”´ Deactivate" : "ðŸŸ¢ Activate", `hex:ptoggle:${id}`)
        .text("ðŸ—‘ï¸ Delete", `hex:pdel:${id}`)
        .row()
        .text("âœï¸ Name", `hex:peditname:${id}`)
        .text("âœï¸ Price", `hex:peditprice:${id}`)
        .text("âœï¸ Desc", `hex:peditdesc:${id}`)
        .row()
        .text("ðŸ”™ Products", "hex:products"),
    });
  });

  // â”€â”€ Toggle product active â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.callbackQuery(/^hex:ptoggle:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("â›” Owner only.");
      return;
    }
    const id = parseInt(ctx.match[1]!);
    const [p] = await db.select({ isActive: productsTable.isActive }).from(productsTable).where(eq(productsTable.id, id));
    if (!p) { await ctx.answerCallbackQuery("Not found."); return; }
    await db.update(productsTable).set({ isActive: !p.isActive, updatedAt: new Date() }).where(eq(productsTable.id, id));
    await ctx.answerCallbackQuery(p.isActive ? "ðŸ”´ Deactivated" : "ðŸŸ¢ Activated");
    // refresh view
    const [updated] = await db.select().from(productsTable).where(eq(productsTable.id, id));
    if (!updated) return;
    const statusLine = updated.isActive ? "âœ… Active" : "âŒ Inactive";
    await ctx.editMessageText(
      `${catEmoji(updated.category)} *${updated.name}*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\nðŸ’° $${parseFloat(updated.price).toFixed(2)} | ${statusLine}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text(updated.isActive ? "ðŸ”´ Deactivate" : "ðŸŸ¢ Activate", `hex:ptoggle:${id}`)
          .text("ðŸ—‘ï¸ Delete", `hex:pdel:${id}`)
          .row()
          .text("âœï¸ Name", `hex:peditname:${id}`)
          .text("âœï¸ Price", `hex:peditprice:${id}`)
          .text("âœï¸ Desc", `hex:peditdesc:${id}`)
          .row()
          .text("ðŸ”™ Products", "hex:products"),
      }
    );
  });

  // â”€â”€ Delete product â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.callbackQuery(/^hex:pdel:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery("â›” Owner only.");
      return;
    }
    const id = parseInt(ctx.match[1]!);
    await db.delete(productsTable).where(eq(productsTable.id, id));
    await ctx.answerCallbackQuery("ðŸ—‘ï¸ Deleted");
    await ctx.editMessageText(
      `ðŸ—‘ï¸ Product deleted.`,
      { reply_markup: new InlineKeyboard().text("ðŸ“¦ Products", "hex:products") }
    );
  });

  // â”€â”€ Edit product fields â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.callbackQuery(/^hex:peditname:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("â›” Owner only."); return; }
    const id = parseInt(ctx.match[1]!);
    ctx.session.hexDraft = { editId: id };
    ctx.session.pendingAction = "hex:edit_name";
    await ctx.answerCallbackQuery();
    await ctx.reply("âœï¸ Enter new product name:");
  });

  bot.callbackQuery(/^hex:peditprice:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("â›” Owner only."); return; }
    const id = parseInt(ctx.match[1]!);
    ctx.session.hexDraft = { editId: id };
    ctx.session.pendingAction = "hex:edit_price";
    await ctx.answerCallbackQuery();
    await ctx.reply("âœï¸ Enter new price (e.g. `12.00`):", { parse_mode: "Markdown" });
  });

  bot.callbackQuery(/^hex:peditdesc:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("â›” Owner only."); return; }
    const id = parseInt(ctx.match[1]!);
    ctx.session.hexDraft = { editId: id };
    ctx.session.pendingAction = "hex:edit_desc";
    await ctx.answerCallbackQuery();
    await ctx.reply("âœï¸ Enter new description:");
  });

  // â”€â”€ Orders â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.callbackQuery("hex:orders", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("â›” Owner only."); return; }
    await ctx.answerCallbackQuery();
    const [pending, confirmed, cancelled] = await Promise.all([
      db.select({ count: count() }).from(ordersTable).where(eq(ordersTable.status, "pending")),
      db.select({ count: count() }).from(ordersTable).where(eq(ordersTable.status, "confirmed")),
      db.select({ count: count() }).from(ordersTable).where(eq(ordersTable.status, "cancelled")),
    ]);
    const claimed = await db.select({ count: count() }).from(ordersTable).where(eq(ordersTable.status, "claimed"));
    await ctx.editMessageText(
      `ðŸ“‹ *ORDERS*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\n` +
        `â³ Pending: ${pending[0]?.count ?? 0}\n` +
        `ðŸ”” Claimed: ${claimed[0]?.count ?? 0} _(needs action)_\n` +
        `âœ… Confirmed: ${confirmed[0]?.count ?? 0}\n` +
        `âŒ Cancelled: ${cancelled[0]?.count ?? 0}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text(`â³ Pending`, "hex:opending")
          .text(`ðŸ”” Claimed`, "hex:oclaimed")
          .row()
          .text("âœ… Confirmed", "hex:oconfirmed")
          .text("âŒ Cancelled", "hex:ocancelled")
          .row()
          .text("ðŸ”™ Hex Panel", "hex:main"),
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
      const prStr = pr ? ` â€” ${pr.amount} ${pr.coin}` : "";
      kb.text(`#${o.id}${prStr} â€” UID:${o.userId}`, `hex:oview:${o.id}`).row();
    }
    kb.text("ðŸ”™ Orders", "hex:orders");

    await ctx.editMessageText(
      `${title}\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\n${orders.length === 0 ? "None yet." : `${orders.length} order(s):`}`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
  }

  bot.callbackQuery("hex:opending", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("â›” Owner only."); return; }
    await ctx.answerCallbackQuery();
    await showOrderList(ctx, "pending", "â³ *PENDING ORDERS*");
  });

  bot.callbackQuery("hex:oclaimed", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("â›” Owner only."); return; }
    await ctx.answerCallbackQuery();
    await showOrderList(ctx, "claimed", "ðŸ”” *CLAIMED ORDERS* â€” needs action");
  });

  bot.callbackQuery("hex:oconfirmed", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("â›” Owner only."); return; }
    await ctx.answerCallbackQuery();
    await showOrderList(ctx, "confirmed", "âœ… *CONFIRMED ORDERS*");
  });

  bot.callbackQuery("hex:ocancelled", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("â›” Owner only."); return; }
    await ctx.answerCallbackQuery();
    await showOrderList(ctx, "cancelled", "âŒ *CANCELLED ORDERS*");
  });

  // â”€â”€ View single order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.callbackQuery(/^hex:oview:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("â›” Owner only."); return; }
    const orderId = parseInt(ctx.match[1]!);
    await ctx.answerCallbackQuery();

    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    if (!order) { await ctx.editMessageText("Order not found."); return; }

    const [product] = await db.select().from(productsTable).where(eq(productsTable.id, order.productId));
    const [pr] = await db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.orderId, orderId));

    const statusEmoji: Record<string, string> = {
      pending: "â³", claimed: "ðŸ””", confirmed: "âœ…", cancelled: "âŒ",
    };

    const text =
      `ðŸ“‹ *ORDER #${orderId}*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\n` +
      `ðŸ‘¤ Customer ID: \`${order.userId}\`\n` +
      `ðŸ“¦ Product: ${product?.name ?? "Unknown"}\n` +
      `ðŸ“ Qty: ${order.quantity}\n` +
      `${statusEmoji[order.status] ?? "â“"} Status: *${order.status.toUpperCase()}*\n` +
      (pr
        ? `\nðŸ’° Amount: \`${pr.amount} ${pr.coin}\`\n` +
          `ðŸ¦ Address: \`${pr.address}\`\n` +
          `ðŸ“Œ Ref: ${pr.reference}\n` +
          `ðŸ“Š Pay Status: *${pr.status}*`
        : "\n_No payment request yet._") +
      `\n\nðŸ• ${order.createdAt.toLocaleString()}`;

    const kb = new InlineKeyboard();
    if (order.status === "claimed") {
      kb.text("âœ… Confirm & Deliver", `hex:oconfirm:${orderId}`)
        .text("âŒ Cancel", `hex:ocancel:${orderId}`)
        .row();
    } else if (order.status === "pending") {
      kb.text("âŒ Cancel Order", `hex:ocancel:${orderId}`).row();
    }
    kb.text("ðŸ”™ Orders", "hex:orders");

    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
  });

  // â”€â”€ Confirm order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.callbackQuery(/^hex:oconfirm:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("â›” Owner only."); return; }
    const orderId = parseInt(ctx.match[1]!);

    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    if (!order) { await ctx.answerCallbackQuery("Order not found."); return; }

    const [product] = await db.select().from(productsTable).where(eq(productsTable.id, order.productId));

    await db.update(ordersTable).set({ status: "confirmed", updatedAt: new Date() }).where(eq(ordersTable.id, orderId));
    await db.update(paymentRequestsTable)
      .set({ status: "confirmed", confirmedAt: new Date() })
      .where(eq(paymentRequestsTable.orderId, orderId));

    await ctx.answerCallbackQuery("âœ… Confirmed!");

    // Deliver to customer
    let deliveryMsg =
      `âœ… *ORDER CONFIRMED â€” #${orderId}*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\n` +
      `ðŸ“¦ ${product?.name ?? "Your order"}\n\nThank you! `;

    if (product?.deliveryType === "auto" && product.deliveryContent) {
      deliveryMsg += `Here is your delivery:\n\n${product.deliveryContent}`;
    } else {
      deliveryMsg += `Your order has been confirmed. The seller will deliver shortly.`;
    }

    await ctx.api.sendMessage(order.userId, deliveryMsg, { parse_mode: "Markdown" }).catch(() => {});

    await ctx.editMessageText(
      `âœ… *Order #${orderId} confirmed!*\n\nDelivery sent to customer ${order.userId}.`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("ðŸ“‹ Orders", "hex:orders") }
    );
  });

  // â”€â”€ Cancel order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.callbackQuery(/^hex:ocancel:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("â›” Owner only."); return; }
    const orderId = parseInt(ctx.match[1]!);

    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    if (!order) { await ctx.answerCallbackQuery("Not found."); return; }

    await db.update(ordersTable).set({ status: "cancelled", updatedAt: new Date() }).where(eq(ordersTable.id, orderId));
    await db.update(paymentRequestsTable)
      .set({ status: "cancelled" })
      .where(eq(paymentRequestsTable.orderId, orderId));

    await ctx.answerCallbackQuery("âŒ Cancelled");

    await ctx.api.sendMessage(
      order.userId,
      `âŒ *Order #${orderId} Cancelled*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\nYour order has been cancelled. Contact the seller if this is a mistake.`,
      { parse_mode: "Markdown" }
    ).catch(() => {});

    await ctx.editMessageText(
      `âŒ Order #${orderId} cancelled.`,
      { reply_markup: new InlineKeyboard().text("ðŸ“‹ Orders", "hex:orders") }
    );
  });

  // â”€â”€ Payment settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // â”€â”€ CryptoBot setup info â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.callbackQuery("hex:cryptobot_setup", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("â›”"); return; }
    await ctx.answerCallbackQuery();
    const isSet = !!process.env.CRYPTOBOT_API_TOKEN;
    await ctx.editMessageText(
      `ðŸ¤– *CRYPTOBOT SETUP*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\n` +
      `Status: ${isSet ? "âœ… *Configured*" : "âŒ *Not configured*"}\n\n` +
      `*How to set up:*\n` +
      `1. Open @CryptoBot on Telegram\n` +
      `2. Tap /pay â†’ *Create App*\n` +
      `3. Copy your *API Token*\n` +
      `4. Go to Render â†’ Environment â†’ Add:\n` +
      `   \`CRYPTOBOT_API_TOKEN\` = your token\n\n` +
      `*Webhook URL to set in CryptoBot:*\n` +
      `\`${process.env.RENDER_EXTERNAL_URL ?? "https://your-app.onrender.com"}/api/cryptobot/webhook\`\n\n` +
      `_Once set, payments auto-confirm â€” no manual work needed._`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .url("ðŸ¤– Open @CryptoBot", "https://t.me/CryptoBot")
          .row()
          .text("ðŸ”™ Payment Settings", "hex:payments"),
      }
    );
  });

  bot.callbackQuery("hex:payments", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("â›” Owner only."); return; }
    await ctx.answerCallbackQuery();
    const ownerId = ctx.from.id;
    const s = await getOrCreatePaymentSettings(ownerId);

    function addrLine(label: string, addr: string | null) {
      return addr ? `âœ… ${label}: \`${addr.slice(0, 12)}...${addr.slice(-6)}\`` : `âŒ ${label}: _Not set_`;
    }

    const text =
      `ðŸ’° *PAYMENT SETTINGS*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\n` +
      `${addrLine("BNB / USDT-BEP20", s.bnbAddress)}\n` +
      `${addrLine("USDT-TRC20", s.trc20Address)}\n` +
      `${addrLine("BTC", s.btcAddress)}\n` +
      `${addrLine("ETH", s.ethAddress)}\n` +
      `${s.bnbXpub ? `ðŸ”‘ xpub: âœ… _Unique addrs enabled_` : `ðŸ”‘ xpub: âŒ _Not set (static addr)_`}\n\n` +
      `â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n` +
      `ðŸ¤– *CryptoBot (Auto-Pay):* ${process.env.CRYPTOBOT_API_TOKEN ? "âœ… _Configured_" : "âŒ _Not set_"}\n` +
      `_Customers only see coins you've configured._`;

    await ctx.editMessageText(text, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("ðŸ’› Set BNB/USDT-BEP20", "hex:set_bnb")
        .row()
        .text("ðŸŸ¢ Set USDT-TRC20", "hex:set_trc20")
        .row()
        .text("ðŸŸ  Set BTC", "hex:set_btc")
        .text("â¬œ Set ETH", "hex:set_eth")
        .row()
        .text("ðŸ”‘ Set xpub (unique addrs)", "hex:set_xpub")
        .row()
        .text("ðŸ¤– CryptoBot Setup", "hex:cryptobot_setup")
        .row()
        .text("ðŸ”™ Hex Panel", "hex:main"),
    });
  });

  // Payment field inputs
  const payInputs: Array<[string, string]> = [
    ["hex:set_bnb", "ðŸ’› BNB / USDT-BEP20 address:\n\nPaste your BSC wallet address (starts with 0x):"],
    ["hex:set_trc20", "ðŸŸ¢ USDT-TRC20 address:\n\nPaste your Tron wallet address (starts with T):"],
    ["hex:set_btc", "ðŸŸ  BTC address:\n\nPaste your Bitcoin wallet address:"],
    ["hex:set_eth", "â¬œ ETH address:\n\nPaste your Ethereum wallet address (starts with 0x):"],
    ["hex:set_xpub", "ðŸ”‘ xpub for BNB/BSC:\n\nPaste your extended public key (xpub/zpub from MetaMask â†’ Account Details â†’ Export xpub).\n\nâš ï¸ This generates unique addresses. Each order gets its own address."],
  ];

  for (const [cb, prompt] of payInputs) {
    bot.callbackQuery(cb, async (ctx) => {
      if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("â›” Owner only."); return; }
      ctx.session.pendingAction = cb;
      await ctx.answerCallbackQuery();
      await ctx.reply(prompt, {
        reply_markup: new InlineKeyboard().text("âŒ Cancel", "hex:payments"),
      });
    });
  }

  // â”€â”€ Stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  bot.callbackQuery("hex:stats", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery("â›” Owner only."); return; }
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
      .map(([coin, amt]) => `   â€¢ ${coin}: ${amt.toFixed(2)}`)
      .join("\n") || "   _No revenue yet_";

    await ctx.editMessageText(
      `ðŸ“Š *STATS*\nâ”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”â”\n\n` +
        `ðŸ“¦ Products: ${totalProducts?.count ?? 0} total, ${activeProducts?.count ?? 0} active\n\n` +
        `ðŸ“‹ Orders:\n` +
        `   â³ Pending: ${pendingOrders?.count ?? 0}\n` +
        `   ðŸ”” Claimed: ${claimedOrders?.count ?? 0}\n` +
        `   âœ… Confirmed: ${confirmedOrders?.count ?? 0}\n` +
        `   ðŸ“Š Total: ${totalOrders?.count ?? 0}\n\n` +
        `ðŸ’° Revenue (confirmed):\n${revenueLines}`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("ðŸ”™ Hex Panel", "hex:main") }
    );
  });
}
