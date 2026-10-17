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
  { id: "streaming", label: "📺 Streaming" },
  { id: "gaming", label: "🎮 Gaming" },
  { id: "vpn", label: "🛡️ VPN" },
  { id: "giftcard", label: "🎁 Gift Cards" },
  { id: "social", label: "📱 Social" },
  { id: "cards", label: "💳 Cards" },
];

const CATEGORY_EMOJIS: Record<string, string> = {
  streaming: "📺",
  gaming: "🎮",
  vpn: "🛡️",
  giftcard: "🎁",
  social: "📱",
  cards: "💳",
};

const TOR_DELIVERY: Record<string, { name: string; about: string; finds: string; onion: string }> = {
  ddg: { name: "DuckDuckGo Search (Onion)", about: "Official privacy search on Tor.", finds: "Web search over the onion network.", onion: "https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion" },
  torproject: { name: "Tor Project Official", about: "Official Tor Project site on onion.", finds: "Docs, Tor Browser downloads, support.", onion: "http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion" },
  protonmail: { name: "Proton Mail (Onion)", about: "Encrypted email over Tor.", finds: "Secure inbox without clearnet IP exposure.", onion: "https://protonmailrmez3lotccipshtkleegetolb73fuirgj7r4o4vfu7ozyd.onion" },
  nytimes: { name: "The New York Times (Onion)", about: "NYT official onion mirror.", finds: "Full NYT journalism over Tor.", onion: "https://www.nytimes3xbfgragh.onion" },
  bbc: { name: "BBC News (Onion)", about: "BBC official onion for censored regions.", finds: "BBC news coverage over Tor.", onion: "https://www.bbcnewsd73hkzno2ini43a6qrcunjqz37yvnpkb6qazsykquxpd5tlq.onion" },
  facebook: { name: "Facebook / Meta (Onion)", about: "Meta official Facebook onion.", finds: "Facebook login over Tor.", onion: "https://www.facebookwkhpilnemxj7asaniu7vnjjbiltxjqhye3mhbshg7kx5tfayd.onion" },
  propublica: { name: "ProPublica (Onion)", about: "Investigative journalism onion mirror.", finds: "Investigations and news over Tor.", onion: "https://www.propub3r6espa33w.onion" },
  cia: { name: "CIA.gov (Onion)", about: "CIA public site on Tor.", finds: "Public CIA.gov content over Tor.", onion: "http://ciadotgov4sjwlzihbbgxnqg3xiyrg7so2r2o3lt5ceclq3qzt6gdaqd.onion" },
  riseup: { name: "Riseup (Onion)", about: "Activist email/lists/VPN provider.", finds: "Riseup services over Tor.", onion: "http://vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd.onion" },
  debian: { name: "Debian (Onion)", about: "Debian Project onion services.", finds: "Docs and package info over Tor.", onion: "http://5emwn4bxbrgkh6wqbthnkkmvsm5v256wtzlxupreztudshqu67ixn4qd.onion" },
  keybase: { name: "Keybase (Onion)", about: "Identity and encrypted chat.", finds: "Keybase over Tor.", onion: "http://keybase5wmilwokqirssclfnsqrjdsi7jdir5wy7y7iu3tanwdbfzoid.onion" },
  cryptostorm: { name: "Cryptostorm VPN (Onion)", about: "Privacy VPN provider onion site.", finds: "VPN account and config docs.", onion: "http://stormwayszuh4jrt745bbigxiqvdpzllj7f3dxkjc3ew3mgmtedvmgsd.onion" },
  dw: { name: "Deutsche Welle (Onion)", about: "DW international news onion.", finds: "World news in multiple languages.", onion: "https://www.dwnewsgngmhlplxy6o2twt2ktxwjt7dyt4w4r7jmwj5xjnq.onion" },
  securesdrop_guardian: { name: "Guardian SecureDrop", about: "Guardian whistleblower drop.", finds: "Anonymous tips to journalists.", onion: "http://theguardian2d2mn.onion" },
  qubes: { name: "Qubes OS (Onion)", about: "Qubes OS project site.", finds: "Downloads and docs for Qubes.", onion: "http://qubesosfasa4zl54gj5gf5fjh3h5t6f2j4yq.onion" },
  archive_today: { name: "Archive.today (Onion)", about: "Page archive service.", finds: "Save and view web snapshots.", onion: "http://archiveiya74codqgiixo33q62qlrqtkgmcitqx5u2oeqnmn5bpcbiyd.onion" },
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
      kb.text(a.label, `hex:applycat:${productId}:${a.id}`).text(b.label, `hex:applycat:${productId}:${b.id}`).row();
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
    await ctx.reply("Product not found.", { reply_markup: new InlineKeyboard().text("📦 Products", "hex:products") });
    return;
  }
  const text =
    `📦 PRODUCT #${p.id}\n━━━━━━━━━━━━━━━━━━\n\n` +
    `Name: ${p.name}\nPrice: $${parseFloat(String(p.price)).toFixed(2)}\n` +
    `Category: ${p.category || "—"}\nStatus: ${p.isActive ? "Active" : "Disabled"}\n` +
    `Delivery: ${p.deliveryType || "manual"}\nStock: ${stockLabel(p.stock, p.isActive)}\n` +
    (p.description ? `\nDescription:\n${p.description}\n` : "\nNo description.\n") +
    `\nTap a button below to manage this product.`;
  const kb = productManageKeyboard(id, p.isActive);
  try { await ctx.editMessageText(text, { reply_markup: kb }); } catch { await ctx.reply(text, { reply_markup: kb }); }
}

async function saveNewProduct(ctx: BotContext): Promise<void> {
  const draft = ctx.session.hexDraft;
  if (!draft?.name || !draft.price) return;
  const [product] = await db.insert(productsTable).values({
    name: draft.name, price: draft.price, description: draft.description ?? null,
    category: (draft.category ?? "streaming").trim().toLowerCase(),
    deliveryType: draft.deliveryType ?? "manual", deliveryContent: draft.deliveryContent ?? null,
    isActive: true, stock: "0",
  }).returning();
  ctx.session.hexDraft = {};
  ctx.session.pendingAction = undefined;
  const pid = product?.id;
  await ctx.reply(
    `✅ Product added\n\n${draft.name}\n$${parseFloat(String(draft.price)).toFixed(2)}\nID: ${pid}`,
    { reply_markup: new InlineKeyboard().text("⚙️ Manage", `hex:pview:${pid}`).text("📦 Products", "hex:products") },
  );
}

async function applyOrderDecline(ctx: BotContext, orderId: number, reason: string): Promise<void> {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
  if (!order) { await ctx.answerCallbackQuery({ text: "Order not found", show_alert: true }).catch(() => {}); return; }
  if (order.status === "confirmed") { await ctx.answerCallbackQuery({ text: "Already confirmed", show_alert: true }).catch(() => {}); return; }
  await db.update(ordersTable).set({ status: "declined", updatedAt: new Date() }).where(eq(ordersTable.id, orderId));
  await db.update(paymentRequestsTable).set({ status: "declined" }).where(eq(paymentRequestsTable.orderId, orderId)).catch(() => {});
  await ctx.api.sendMessage(order.userId, `❌ PAYMENT DECLINED — ORDER #${orderId}\n\n${reason}`).catch(() => {});
  await ctx.answerCallbackQuery({ text: "Declined" }).catch(() => {});
  await ctx.editMessageText(`❌ Order #${orderId} declined.\n${reason}`, {
    reply_markup: new InlineKeyboard().text("📋 Orders", "hex:orders"),
  }).catch(() => {});
}

export async function processHexInput(ctx: BotContext, action: string, text: string): Promise<void> {
  if (!ctx.from || !isOwner(ctx.from.id)) return;
  switch (action) {
    case "hex:product_name":
      if (!text.trim()) { ctx.session.pendingAction = "hex:product_name"; await ctx.reply("Name required:"); return; }
      ctx.session.hexDraft = { ...ctx.session.hexDraft, name: text.trim() };
      ctx.session.pendingAction = "hex:product_price";
      await ctx.reply("💰 Price? (e.g. 15.00):");
      break;
    case "hex:product_price": {
      const price = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(price) || price <= 0) { ctx.session.pendingAction = "hex:product_price"; await ctx.reply("Invalid price:"); return; }
      ctx.session.hexDraft = { ...ctx.session.hexDraft, price: price.toFixed(2) };
      ctx.session.pendingAction = "hex:product_desc";
      await ctx.reply("📝 Description? (/skip to skip):");
      break;
    }
    case "hex:product_desc":
      ctx.session.hexDraft = { ...ctx.session.hexDraft, description: text === "/skip" || text.toLowerCase() === "skip" ? undefined : text.trim() };
      ctx.session.pendingAction = undefined;
      await ctx.reply("📁 Choose category:", { reply_markup: categoryKeyboard() });
      break;
    case "hex:product_delivery_content":
      ctx.session.hexDraft = { ...ctx.session.hexDraft, deliveryContent: text.trim(), deliveryType: "auto" };
      ctx.session.pendingAction = undefined;
      await saveNewProduct(ctx);
      break;
    case "hex:edit_name": {
      const id = ctx.session.hexDraft?.editId ?? ctx.session.hexEditId;
      if (!id) return;
      await db.update(productsTable).set({ name: text.trim(), updatedAt: new Date() }).where(eq(productsTable.id, id));
      ctx.session.pendingAction = undefined;
      await ctx.reply("✅ Name updated.", { reply_markup: new InlineKeyboard().text("🔙 View", `hex:pview:${id}`) });
      break;
    }
    case "hex:edit_price": {
      const id = ctx.session.hexDraft?.editId ?? ctx.session.hexEditId;
      if (!id) return;
      const price = parseFloat(text.replace(/[^0-9.]/g, ""));
      if (!Number.isFinite(price) || price <= 0) { ctx.session.pendingAction = "hex:edit_price"; await ctx.reply("Invalid price:"); return; }
      await db.update(productsTable).set({ price: price.toFixed(2), updatedAt: new Date() }).where(eq(productsTable.id, id));
      ctx.session.pendingAction = undefined;
      await ctx.reply("✅ Price updated.", { reply_markup: new InlineKeyboard().text("🔙 View", `hex:pview:${id}`) });
      break;
    }
    case "hex:edit_desc": {
      const id = ctx.session.hexDraft?.editId ?? ctx.session.hexEditId;
      if (!id) return;
      await db.update(productsTable).set({ description: text === "/skip" ? null : text.trim(), updatedAt: new Date() }).where(eq(productsTable.id, id));
      ctx.session.pendingAction = undefined;
      await ctx.reply("✅ Description updated.", { reply_markup: new InlineKeyboard().text("🔙 View", `hex:pview:${id}`) });
      break;
    }
    case "hex:edit_stock": {
      const id = ctx.session.hexDraft?.editId ?? ctx.session.hexEditId;
      if (!id) return;
      const raw = text.trim().toLowerCase();
      let stockVal = (raw === "unlimited" || raw === "0" || raw === "inf") ? "0" : String(parseInt(raw.replace(/[^0-9]/g, ""), 10));
      if (stockVal === "NaN") { ctx.session.pendingAction = "hex:edit_stock"; await ctx.reply('Number or "unlimited":'); return; }
      await db.update(productsTable).set({ stock: stockVal, isActive: stockVal === "0" || Number(stockVal) > 0, updatedAt: new Date() }).where(eq(productsTable.id, id));
      ctx.session.pendingAction = undefined;
      await ctx.reply(`✅ Stock: ${stockVal === "0" ? "Unlimited" : stockVal}`, { reply_markup: new InlineKeyboard().text("🔙 View", `hex:pview:${id}`) });
      break;
    }
    case "hex:decline_reason": {
      const id = ctx.session.hexDraft?.editId ?? ctx.session.hexEditId;
      if (!id) return;
      ctx.session.pendingAction = undefined;
      await applyOrderDecline(ctx, id, text.trim() || "Payment was declined.");
      break;
    }
    default: break;
  }
}

export function registerHexHandlers(bot: Bot<BotContext>): void {
  bot.command("hex", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.reply("⛔ Owner only."); return; }
    await ctx.reply(`🔮 HEX CONTROL PANEL\n━━━━━━━━━━━━━━━━━━\n\nFull control over your CardShop.`, { reply_markup: hexPanelKeyboard() });
  });
}

export function registerHexCallbacks(bot: Bot<BotContext>): void {
  bot.callbackQuery("hex:main", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    await ctx.answerCallbackQuery();
    try { await ctx.editMessageText(`🔮 HEX CONTROL PANEL\n━━━━━━━━━━━━━━━━━━\n\nFull control over your CardShop.`, { reply_markup: hexPanelKeyboard() }); }
    catch { await ctx.reply(`🔮 HEX CONTROL PANEL\n━━━━━━━━━━━━━━━━━━\n\nFull control over your CardShop.`, { reply_markup: hexPanelKeyboard() }); }
  });

  bot.callbackQuery("hex:products", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    await ctx.answerCallbackQuery();
    const products = await db.select().from(productsTable).orderBy(desc(productsTable.createdAt)).limit(40);
    const kb = new InlineKeyboard();
    for (const p of products) {
      kb.text(`${p.isActive ? "✅" : "⏸"} #${p.id} ${p.name} — $${parseFloat(String(p.price)).toFixed(2)}`, `hex:pview:${p.id}`).row();
    }
    kb.text("➕ Add Product", "hex:product_add").row().text("🔙 Hex", "hex:main");
    const listText = `📦 PRODUCTS\n━━━━━━━━━━━━━━━━━━\n\n` + (products.length === 0 ? "No products yet." : "Tap a product to manage.");
    try { await ctx.editMessageText(listText, { reply_markup: kb }); } catch { await ctx.reply(listText, { reply_markup: kb }); }
  });

  bot.callbackQuery("hex:product_add", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    ctx.session.hexDraft = {};
    ctx.session.pendingAction = "hex:product_name";
    await ctx.answerCallbackQuery();
    await ctx.reply(`➕ ADD PRODUCT\n\nStep 1: Product name?`);
  });

  bot.callbackQuery(/^hex:setcat:(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    ctx.session.hexDraft = { ...ctx.session.hexDraft, category: ctx.match[1]! };
    await ctx.answerCallbackQuery();
    try { await ctx.editMessageText("🚚 Delivery type?", { reply_markup: deliveryTypeKeyboard() }); }
    catch { await ctx.reply("🚚 Delivery type?", { reply_markup: deliveryTypeKeyboard() }); }
  });

  bot.callbackQuery(/^hex:setdelivery:(manual|auto)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    const dtype = ctx.match[1]! as "manual" | "auto";
    ctx.session.hexDraft = { ...ctx.session.hexDraft, deliveryType: dtype };
    await ctx.answerCallbackQuery();
    if (dtype === "auto") {
      ctx.session.pendingAction = "hex:product_delivery_content";
      await ctx.reply(`⚡ Paste auto-delivery content:`);
    } else await saveNewProduct(ctx);
  });

  bot.callbackQuery(/^hex:pview:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    await ctx.answerCallbackQuery();
    await showProductManage(ctx, parseInt(ctx.match[1]!, 10));
  });

  bot.callbackQuery(/^hex:ptoggle:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    const id = parseInt(ctx.match[1]!, 10);
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, id));
    if (!p) return;
    await db.update(productsTable).set({ isActive: !p.isActive, updatedAt: new Date() }).where(eq(productsTable.id, id));
    await ctx.answerCallbackQuery(p.isActive ? "Disabled" : "Enabled");
    await showProductManage(ctx, id);
  });

  bot.callbackQuery(/^hex:pdelete:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    const id = parseInt(ctx.match[1]!, 10);
    await db.update(productsTable).set({ isActive: false, updatedAt: new Date() }).where(eq(productsTable.id, id));
    await ctx.answerCallbackQuery("Disabled");
    await ctx.editMessageText("Product disabled.", { reply_markup: new InlineKeyboard().text("📦 Products", "hex:products") }).catch(() => {});
  });

  bot.callbackQuery(/^hex:peditname:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    const id = parseInt(ctx.match[1]!, 10);
    ctx.session.hexDraft = { ...ctx.session.hexDraft, editId: id };
    ctx.session.pendingAction = "hex:edit_name";
    await ctx.answerCallbackQuery();
    await ctx.reply("New name?");
  });

  bot.callbackQuery(/^hex:peditprice:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    const id = parseInt(ctx.match[1]!, 10);
    ctx.session.hexDraft = { ...ctx.session.hexDraft, editId: id };
    ctx.session.pendingAction = "hex:edit_price";
    await ctx.answerCallbackQuery();
    await ctx.reply("New price?");
  });

  bot.callbackQuery(/^hex:peditdesc:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    const id = parseInt(ctx.match[1]!, 10);
    ctx.session.hexDraft = { ...ctx.session.hexDraft, editId: id };
    ctx.session.pendingAction = "hex:edit_desc";
    await ctx.answerCallbackQuery();
    await ctx.reply("New description? (/skip to clear)");
  });

  bot.callbackQuery(/^hex:peditstock:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    const id = parseInt(ctx.match[1]!, 10);
    ctx.session.hexDraft = { ...ctx.session.hexDraft, editId: id };
    ctx.session.pendingAction = "hex:edit_stock";
    await ctx.answerCallbackQuery();
    await ctx.reply('Stock number or "unlimited":');
  });

  bot.callbackQuery(/^hex:peditcat:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    const id = parseInt(ctx.match[1]!, 10);
    await ctx.answerCallbackQuery();
    await ctx.reply("Pick category:", { reply_markup: categoryKeyboardForEdit(id) });
  });

  bot.callbackQuery(/^hex:applycat:(\d+):(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    const id = parseInt(ctx.match[1]!, 10);
    const cat = ctx.match[2]!;
    await db.update(productsTable).set({ category: cat, updatedAt: new Date() }).where(eq(productsTable.id, id));
    await ctx.answerCallbackQuery("Category set");
    await showProductManage(ctx, id);
  });

  bot.callbackQuery("hex:orders", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    await ctx.answerCallbackQuery();
    const orders = await db.select().from(ordersTable).orderBy(desc(ordersTable.createdAt)).limit(20);
    const kb = new InlineKeyboard();
    for (const o of orders) {
      kb.text(`#${o.id} ${o.status}`, `hex:oview:${o.id}`).row();
    }
    kb.text("🔙 Hex", "hex:main");
    await ctx.editMessageText(`📋 ORDERS\n\n${orders.length} recent`, { reply_markup: kb }).catch(() => {});
  });

  bot.callbackQuery(/^hex:oview:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    const id = parseInt(ctx.match[1]!, 10);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
    if (!order) return;
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard();
    if (order.status === "pending") {
      kb.text("✅ Confirm payment", `hex:oconfirm:${id}`).row();
      kb.text("❌ Decline", `hex:odecline:${id}`).row();
    }
    kb.text("🔙 Orders", "hex:orders");
    await ctx.editMessageText(
      `Order #${id}\nUser: ${order.userId}\nStatus: ${order.status}\nDetails: ${order.details ?? "—"}`,
      { reply_markup: kb },
    ).catch(() => {});
  });

  bot.callbackQuery(/^hex:oconfirm:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    const id = parseInt(ctx.match[1]!, 10);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, id));
    if (!order) return;
    if (order.status === "confirmed") { await ctx.answerCallbackQuery({ text: "Already confirmed", show_alert: true }); return; }
    await db.update(ordersTable).set({ status: "confirmed", updatedAt: new Date() }).where(eq(ordersTable.id, id));
    await db.update(paymentRequestsTable).set({ status: "confirmed", confirmedAt: new Date() }).where(eq(paymentRequestsTable.orderId, id)).catch(() => {});
    const bankMatch = order.details?.match(/^BANKLOG:(\d+)$/);
    const torMatch = order.details?.match(/^TORLINK:(.+)$/);
    if (!bankMatch && !torMatch && order.productId > 0) {
      await deductProductStock(order.productId, order.quantity ?? 1);
    }
    let buyerMsg = `✅ Order #${id} confirmed`;
    if (bankMatch) {
      const logId = parseInt(bankMatch[1]!, 10);
      const [log] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, logId));
      if (log) {
        await db.update(bankLogsTable).set({ status: "sold", isSold: true, soldAt: new Date() }).where(eq(bankLogsTable.id, logId));
        buyerMsg += `\n\n🏦 ${log.bankName} · ${log.country}\n\n🎁 Delivery:\n` +
          (log.loginUrl ? `URL: ${log.loginUrl}\n` : "") +
          (log.username ? `User: ${log.username}\n` : "") +
          (log.password ? `Pass: ${log.password}\n` : "");
      } else buyerMsg += `\n\nBank log — contact support if details missing.`;
    } else if (torMatch) {
      const t = TOR_DELIVERY[torMatch[1]!.trim()];
      if (t) {
        buyerMsg += `\n\n🧅 ${t.name}\n\nAbout: ${t.about}\n\nWhat you can find: ${t.finds}\n\nOnion URL:\n${t.onion}\n\nOpen with Tor Browser only.`;
      } else buyerMsg += `\n\nTor link — contact support if URL missing.`;
    } else {
      const [product] = await db.select().from(productsTable).where(eq(productsTable.id, order.productId));
      buyerMsg += `\n\n📦 ${product?.name ?? "Your order"}`;
      if (product?.deliveryType === "auto" && product.deliveryContent) buyerMsg += `\n\n🎁 Delivery:\n${product.deliveryContent}`;
      else buyerMsg += `\n\nSeller will deliver shortly.`;
    }
    await ctx.api.sendMessage(order.userId, buyerMsg).catch(() => {});
    await ctx.answerCallbackQuery("Confirmed");
    await ctx.editMessageText(`✅ Order #${id} confirmed.`, {
      reply_markup: new InlineKeyboard().text("📋 Orders", "hex:orders"),
    }).catch(() => {});
  });

  bot.callbackQuery(/^hex:odecline:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    const id = parseInt(ctx.match[1]!, 10);
    await ctx.answerCallbackQuery();
    await ctx.reply("Decline reason? (or pick below)", {
      reply_markup: new InlineKeyboard()
        .text("Not paid", `hex:odecline_preset:${id}:not_paid`)
        .row()
        .text("Wrong amount", `hex:odecline_preset:${id}:wrong_amount`)
        .row()
        .text("Custom reason", `hex:odecline_custom:${id}`),
    });
  });

  bot.callbackQuery(/^hex:odecline_preset:(\d+):(.+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    const id = parseInt(ctx.match[1]!, 10);
    const key = ctx.match[2]!;
    const reasons: Record<string, string> = {
      not_paid: "We could not verify payment. Please pay the exact amount and try again.",
      wrong_amount: "Payment amount did not match the order. Contact support with your tx id.",
    };
    await applyOrderDecline(ctx, id, reasons[key] ?? "Payment was declined.");
  });

  bot.callbackQuery(/^hex:odecline_custom:(\d+)$/, async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    const id = parseInt(ctx.match[1]!, 10);
    ctx.session.hexDraft = { ...ctx.session.hexDraft, editId: id };
    ctx.session.pendingAction = "hex:decline_reason";
    await ctx.answerCallbackQuery();
    await ctx.reply("Type the decline reason to send the buyer:");
  });

  bot.callbackQuery("hex:payments", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("💰 Payments — manage via Orders (confirm/decline).", {
      reply_markup: new InlineKeyboard().text("📋 Orders", "hex:orders").text("🔙 Hex", "hex:main"),
    }).catch(() => {});
  });

  bot.callbackQuery("hex:stats", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    await ctx.answerCallbackQuery();
    const revenue = await getConfirmedRevenue();
    const products = await db.select().from(productsTable);
    const orders = await db.select().from(ordersTable);
    const confirmed = orders.filter((o) => o.status === "confirmed").length;
    await ctx.editMessageText(
      `📊 STATS\n━━━━━━━━━━━━━━━━━━\n\nProducts: ${products.length}\nOrders: ${orders.length}\nConfirmed: ${confirmed}\nRevenue: $${revenue.toFixed(2)}`,
      { reply_markup: new InlineKeyboard().text("🔙 Hex", "hex:main") },
    ).catch(() => {});
  });

  bot.callbackQuery("hex:access", async (ctx) => {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Owner only", show_alert: true }); return; }
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("🔑 Access — use /access for the full panel.", {
      reply_markup: new InlineKeyboard().text("🔙 Hex", "hex:main"),
    }).catch(() => {});
  });
}
