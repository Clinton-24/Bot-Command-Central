import { InlineKeyboard } from "grammy";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  productsTable,
  ordersTable,
  paymentSettingsTable,
  paymentRequestsTable,
  bankLogsTable,
} from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { logger } from "../../lib/logger";
import { getProductPriceLimit, subscriptionPlansKeyboard } from "./access";
import { ensureAutoFreeAccess } from "./growth";
import { createCryptoBotInvoice, CRYPTOBOT_ASSETS, type CryptoBotAsset } from "./cryptobot";

const CATEGORY_EMOJIS: Record<string, string> = {
  streaming: "📺",
  gaming: "🎮",
  vpn: "🛡️",
  giftcard: "🎁",
  social: "📱",
  cards: "💳",
  general: "📦",
};

function catEmoji(cat?: string | null): string {
  const c = String(cat || "").trim().toLowerCase();
  return CATEGORY_EMOJIS[c] ?? "📦";
}

function getOwnerId(): number {
  return Number(process.env.BOT_OWNER_ID ?? "0");
}

const COIN_INFO: Record<string, { emoji: string }> = {
  USDT: { emoji: "💵" },
  BTC: { emoji: "₿" },
  ETH: { emoji: "Ξ" },
  BNB: { emoji: "🟡" },
  TRX: { emoji: "🔴" },
};

const TOR_LINK_PRICE = "10.00";

const TOR_LINKS: { id: string; name: string; about: string; finds: string; onion: string }[] = [
  { id: "ddg", name: "DuckDuckGo Search (Onion)", about: "Official privacy search on Tor.", finds: "Web search over the onion network.", onion: "https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion" },
  { id: "torproject", name: "Tor Project Official", about: "Official Tor Project site on onion.", finds: "Docs, Tor Browser downloads, support.", onion: "http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion" },
  { id: "protonmail", name: "Proton Mail (Onion)", about: "Encrypted email over Tor.", finds: "Secure inbox without clearnet IP exposure.", onion: "https://protonmailrmez3lotccipshtkleegetolb73fuirgj7r4o4vfu7ozyd.onion" },
  { id: "nytimes", name: "The New York Times (Onion)", about: "NYT official onion mirror.", finds: "Full NYT journalism over Tor.", onion: "https://www.nytimes3xbfgragh.onion" },
  { id: "bbc", name: "BBC News (Onion)", about: "BBC official onion for censored regions.", finds: "BBC news coverage over Tor.", onion: "https://www.bbcnewsd73hkzno2ini43a6qrcunjqz37yvnpkb6qazsykquxpd5tlq.onion" },
  { id: "facebook", name: "Facebook / Meta (Onion)", about: "Meta official Facebook onion.", finds: "Facebook login over Tor.", onion: "https://www.facebookwkhpilnemxj7asaniu7vnjjbiltxjqhye3mhbshg7kx5tfayd.onion" },
  { id: "propublica", name: "ProPublica (Onion)", about: "Investigative journalism onion mirror.", finds: "Investigations and news over Tor.", onion: "https://www.propub3r6espa33w.onion" },
  { id: "cia", name: "CIA.gov (Onion)", about: "CIA public site on Tor.", finds: "Public CIA.gov content over Tor.", onion: "http://ciadotgov4sjwlzihbbgxnqg3xiyrg7so2r2o3lt5ceclq3qzt6gdaqd.onion" },
  { id: "riseup", name: "Riseup (Onion)", about: "Activist email/lists/VPN provider.", finds: "Riseup services over Tor.", onion: "http://vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd.onion" },
  { id: "debian", name: "Debian (Onion)", about: "Debian Project onion services.", finds: "Docs and package info over Tor.", onion: "http://5emwn4bxbrgkh6wqbthnkkmvsm5v256wtzlxupreztudshqu67ixn4qd.onion" },
  { id: "keybase", name: "Keybase (Onion)", about: "Identity and encrypted chat.", finds: "Keybase over Tor.", onion: "http://keybase5wmilwokqirssclfnsqrjdsi7jdir5wy7y7iu3tanwdbfzoid.onion" },
  { id: "cryptostorm", name: "Cryptostorm VPN (Onion)", about: "Privacy VPN provider onion site.", finds: "VPN account and config docs.", onion: "http://stormwayszuh4jrt745bbigxiqvdpzllj7f3dxkjc3ew3mgmtedvmgsd.onion" },
  { id: "dw", name: "Deutsche Welle (Onion)", about: "DW international news onion.", finds: "World news in multiple languages.", onion: "https://www.dwnewsgngmhlplxy6o2twt2ktxwjt7dyt4w4r7jmwj5xjnq.onion" },
  { id: "securedrop_guardian", name: "Guardian SecureDrop", about: "Guardian whistleblower drop.", finds: "Anonymous tips to journalists.", onion: "http://theguardian2d2mn.onion" },
  { id: "qubes", name: "Qubes OS (Onion)", about: "Qubes OS project site.", finds: "Downloads and docs for Qubes.", onion: "http://qubesosfasa4zl54gj5gf5fjh3h5t6f2j4yq.onion" },
  { id: "archive_today", name: "Archive.today (Onion)", about: "Page archive service.", finds: "Save and view web snapshots.", onion: "http://archiveiya74codqgiixo33q62qlrqtkgmcitqx5u2oeqnmn5bpcbiyd.onion" },
];

async function getAvailableCoins(): Promise<string[]> {
  const ownerId = getOwnerId();
  if (!ownerId) return [];
  const [s] = await db.select().from(paymentSettingsTable).where(eq(paymentSettingsTable.ownerId, ownerId));
  if (!s) return [];
  const coins: string[] = [];
  if (s.trc20Address) coins.push("USDT");
  if (s.btcAddress) coins.push("BTC");
  if (s.bnbAddress) coins.push("BNB");
  if (s.ethAddress) coins.push("ETH");
  return coins;
}

function cardShopKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🏦 Bank Logs", "cardshop:banklogs")
    .row()
    .text("🧅 Tor Links", "cardshop:torlinks")
    .row()
    .text("📺 Streaming", "cardshop:cat:streaming")
    .text("🎮 Gaming", "cardshop:cat:gaming")
    .row()
    .text("🛡️ VPN", "cardshop:cat:vpn")
    .text("🎁 Gift Cards", "cardshop:cat:giftcard")
    .row()
    .text("💳 Cards", "cardshop:cat:cards")
    .text("📱 Social", "cardshop:cat:social")
    .row()
    .text("📋 My Orders", "cardshop:myorders")
    .text("🔙 Main Menu", "menu:main");
}

export function registerCardShopHandlers(bot: MyBot): void {
  bot.command("shop", async (ctx) => {
    if (ctx.from) {
      await ensureAutoFreeAccess({
        id: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
      }).catch(() => {});
    }
    await ctx.reply(
      `🛍️ *SHOP*\n━━━━━━━━━━━━━━━━━━\n\nBrowse and buy digital products. Payments via crypto.\nFree tier: items up to $20.`,
      { parse_mode: "Markdown", reply_markup: cardShopKeyboard() },
    );
  });
  bot.command("buy", async (ctx) => {
    if (ctx.from) {
      await ensureAutoFreeAccess({
        id: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
      }).catch(() => {});
    }
    await ctx.reply(`🛍️ *SHOP*`, { parse_mode: "Markdown", reply_markup: cardShopKeyboard() });
  });
}

export function registerCardShopCallbacks(bot: MyBot): void {
  bot.callbackQuery("cardshop:main", async (ctx) => {
    if (ctx.from) {
      await ensureAutoFreeAccess({
        id: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
      }).catch(() => {});
    }
    await ctx
      .editMessageText(
        `🛍️ *SHOP*\n━━━━━━━━━━━━━━━━━━\n\nBrowse and buy digital products.\nFree tier: items up to $20 · Bank logs · Tor links (if in limit).`,
        { parse_mode: "Markdown", reply_markup: cardShopKeyboard() },
      )
      .catch(async () => {
        await ctx.reply(`🛍️ SHOP\n\nBrowse and buy digital products.`, {
          reply_markup: cardShopKeyboard(),
        });
      });
    await ctx.answerCallbackQuery();
  });

  async function showProductList(ctx: BotContext, category?: string) {
    if (ctx.from) {
      await ensureAutoFreeAccess({
        id: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
      }).catch(() => {});
    }
    const products = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.isActive, true))
      .orderBy(desc(productsTable.updatedAt));
    const catNorm = category?.trim().toLowerCase();
    const scoped = catNorm
      ? products.filter((p) => {
          const c = String(p.category || "").trim().toLowerCase();
          if (c === catNorm) return true;
          if (
            catNorm === "streaming" &&
            (c === "" || c === "general" || c === "other" || c === "uncategorized")
          ) {
            return true;
          }
          return false;
        })
      : products;
    const priceLimit = ctx.from ? await getProductPriceLimit(ctx.from.id) : null;
    const visibleProducts = scoped.filter(
      (product) => priceLimit !== null && parseFloat(String(product.price)) <= priceLimit,
    );
    if (visibleProducts.length === 0) {
      await ctx.editMessageText(
        priceLimit === null
          ? "🔐 *Access required*\n\nTap /start once to unlock free access, or choose a paid plan."
          : `No products in this category at your tier limit (Free ≤ $20).\nTry Bank Logs or another category.`,
        { parse_mode: "Markdown", reply_markup: subscriptionPlansKeyboard() },
      );
      return;
    }
    const catLabel = category ? `${catEmoji(category)} ${category.toUpperCase()}` : "PRODUCTS";
    const kb = new InlineKeyboard();
    for (const p of visibleProducts) {
      kb.text(
        `${catEmoji(p.category)} ${p.name} — $${parseFloat(String(p.price)).toFixed(2)}`,
        `cardshop:product:${p.id}`,
      ).row();
    }
    kb.text("🔙 Shop", "cardshop:main");
    await ctx
      .editMessageText(
        `🛍️ *${catLabel}*\n━━━━━━━━━━━━━━━━━━\n\n${visibleProducts.length} product(s):`,
        { parse_mode: "Markdown", reply_markup: kb },
      )
      .catch(() => {});
  }

  bot.callbackQuery(/^cardshop:cat:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showProductList(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^cardshop:product:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.from) {
      await ensureAutoFreeAccess({
        id: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
      }).catch(() => {});
    }
    const id = parseInt(ctx.match[1]!);
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, id));
    if (!p || !p.isActive) {
      await ctx.editMessageText("❌ Unavailable.", {
        reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main"),
      });
      return;
    }
    const priceLimit = ctx.from ? await getProductPriceLimit(ctx.from.id) : null;
    if (priceLimit === null || parseFloat(String(p.price)) > priceLimit) {
      await ctx.editMessageText("🔐 Higher tier required or above free $20 limit.", {
        parse_mode: "Markdown",
        reply_markup: subscriptionPlansKeyboard(),
      });
      return;
    }
    await ctx
      .editMessageText(
        `${catEmoji(p.category)} ${p.name}\n━━━━━━━━━━━━━━━━━━\n\n` +
          `💰 $${parseFloat(String(p.price)).toFixed(2)}\n` +
          (p.description ? `📝 ${p.description}` : ""),
        {
          reply_markup: new InlineKeyboard()
            .text("🛒 Buy Now", `cardshop:buy:${p.id}`)
            .row()
            .text("🔙 Back", p.category ? `cardshop:cat:${p.category}` : "cardshop:main"),
        },
      )
      .catch(() => {});
  });

  bot.callbackQuery(/^cardshop:buy:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.from) {
      await ensureAutoFreeAccess({
        id: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
      }).catch(() => {});
    }
    const productId = parseInt(ctx.match[1]!);
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!p || !p.isActive) {
      await ctx.editMessageText("❌ Product unavailable.", {
        reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main"),
      });
      return;
    }
    const priceLimit = ctx.from ? await getProductPriceLimit(ctx.from.id) : null;
    if (priceLimit === null || parseFloat(String(p.price)) > priceLimit) {
      await ctx.editMessageText(
        priceLimit === null
          ? "🔐 Access required. Tap /start to unlock free tier, then try again."
          : `🔐 This product is above your tier limit (Free ≤ $20). Upgrade for full catalog.`,
        { reply_markup: subscriptionPlansKeyboard() },
      );
      return;
    }
    const cryptoBotEnabled = !!process.env.CRYPTOBOT_API_TOKEN;
    const coins = await getAvailableCoins();
    const kb = new InlineKeyboard();
    if (cryptoBotEnabled) {
      for (const asset of ["USDT", "TON", "BTC", "ETH"] as CryptoBotAsset[]) {
        kb.text(`⚡ ${asset} CryptoBot`, `cardshop:cbpay:${productId}:${asset}`).row();
      }
    }
    for (const coin of coins) {
      const info = COIN_INFO[coin];
      if (info) kb.text(`${info.emoji} ${coin}`, `cardshop:coinsel:${productId}:${coin}`).row();
    }
    kb.text("❌ Cancel", "cardshop:main");
    await ctx.editMessageText(
      `🛒 CHECKOUT\n\n📦 ${p.name}\n💰 $${parseFloat(String(p.price)).toFixed(2)}\n\nSelect payment:`,
      { reply_markup: kb },
    );
  });

  bot.callbackQuery(/^cardshop:cbpay:(\d+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const productId = parseInt(ctx.match[1]!);
    const asset = ctx.match[2]! as CryptoBotAsset;
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!p || !ctx.from) return;
    try {
      const invoice = await createCryptoBotInvoice({
        amount: parseFloat(String(p.price)),
        asset,
        description: `Order: ${p.name}`,
        payload: `product:${productId}:user:${ctx.from.id}`,
      });
      const [order] = await db
        .insert(ordersTable)
        .values({
          userId: ctx.from.id,
          productId,
          quantity: 1,
          status: "pending",
          details: `CRYPTOBOT:${asset}:${invoice.invoice_id}`,
        })
        .returning();
      await ctx.editMessageText(
        `⚡ CryptoBot invoice\n\n${p.name}\n$${p.price} ${asset}\n\nPay here:\n${invoice.pay_url}`,
        {
          reply_markup: new InlineKeyboard().text(
            "Check payment",
            `cardshop:cbcheck:${order!.id}:${invoice.invoice_id}`,
          ),
        },
      );
    } catch (err) {
      logger.error({ err }, "cbpay failed");
      await ctx.reply("❌ Could not create invoice.");
    }
  });

  bot.callbackQuery(/^cardshop:coinsel:(\d+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const productId = parseInt(ctx.match[1]!);
    const coin = ctx.match[2]!;
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!p || !ctx.from) return;
    const ownerId = getOwnerId();
    const [settings] = await db
      .select()
      .from(paymentSettingsTable)
      .where(eq(paymentSettingsTable.ownerId, ownerId));
    const addr =
      coin === "USDT"
        ? settings?.trc20Address
        : coin === "BTC"
          ? settings?.btcAddress
          : coin === "BNB"
            ? settings?.bnbAddress
            : settings?.ethAddress;
    if (!addr) {
      await ctx.editMessageText("Payment address not configured.", {
        reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main"),
      });
      return;
    }
    const [order] = await db
      .insert(ordersTable)
      .values({
        userId: ctx.from.id,
        productId,
        quantity: 1,
        status: "pending",
        details: `MANUAL:${coin}`,
      })
      .returning();
    await db.insert(paymentRequestsTable).values({
      orderId: order!.id,
      coin,
      address: addr,
      amount: String(p.price),
      reference: `ORD-${order!.id}`,
    });
    await ctx.editMessageText(
      `Order #${order!.id}\n${p.name}\nSend $${p.price} in ${coin} to:\n\n${addr}`,
      {
        reply_markup: new InlineKeyboard()
          .text("✅ I've Paid", `cardshop:claimed:${order!.id}`)
          .text("❌", `cardshop:ordcancel:${order!.id}`),
      },
    );
    if (ownerId) {
      await ctx.api
        .sendMessage(ownerId, `ORDER #${order!.id}\n${p.name}\n${p.price} ${coin}\nUser ${ctx.from.id}`, {
          reply_markup: new InlineKeyboard()
            .text("✅ Confirm", `hex:oconfirm:${order!.id}`)
            .text("❌ Decline", `hex:odecline:${order!.id}`),
        })
        .catch(() => {});
    }
  });

  bot.callbackQuery(/^cardshop:claimed:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Owner will verify payment" });
    await ctx.reply("✅ Claim received. Waiting for owner confirmation.");
  });

  bot.callbackQuery(/^cardshop:ordcancel:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = parseInt(ctx.match[1]!);
    await db.update(ordersTable).set({ status: "cancelled" }).where(eq(ordersTable.id, id));
    await ctx.editMessageText("Order cancelled.", {
      reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main"),
    });
  });

  bot.callbackQuery(/^cardshop:cbcheck:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: "Checking…" });
    await ctx.reply("Payment check runs via webhook / owner confirm. If paid, wait a moment.");
  });

  bot.callbackQuery("cardshop:myorders", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    const orders = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.userId, ctx.from.id))
      .orderBy(desc(ordersTable.createdAt))
      .limit(15);
    if (orders.length === 0) {
      await ctx.editMessageText("No orders yet.", {
        reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main"),
      });
      return;
    }
    const lines = orders.map((o) => `#${o.id} · ${o.status} · product ${o.productId}`).join("\n");
    await ctx.editMessageText(`📋 MY ORDERS\n\n${lines}`, {
      reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main"),
    });
  });

  bot.callbackQuery("cardshop:banklogs", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.from) {
      await ensureAutoFreeAccess({
        id: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
      }).catch(() => {});
    }
    const logs = await db
      .select()
      .from(bankLogsTable)
      .where(eq(bankLogsTable.status, "available"))
      .orderBy(desc(bankLogsTable.addedAt))
      .limit(40);
    const priceLimit = ctx.from ? await getProductPriceLimit(ctx.from.id) : null;
    const visible = logs.filter(
      (l) => priceLimit !== null && parseFloat(l.price ?? "0") <= priceLimit,
    );
    const kb = new InlineKeyboard();
    for (const l of visible) {
      kb.text(
        `🏦 ${l.bankName} · ${l.country} — $${parseFloat(l.price ?? "0").toFixed(2)}`,
        `cardshop:blog:${l.id}`,
      ).row();
    }
    kb.text("🔙 Shop", "cardshop:main");
    await ctx
      .editMessageText(`🏦 BANK LOGS\n\n${visible.length} available:`, { reply_markup: kb })
      .catch(() => {});
  });

  bot.callbackQuery(/^cardshop:blog:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.from) {
      await ensureAutoFreeAccess({
        id: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
      }).catch(() => {});
    }
    const id = parseInt(ctx.match[1]!);
    const [l] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, id));
    if (!l || l.status !== "available") {
      await ctx.editMessageText("Unavailable.", {
        reply_markup: new InlineKeyboard().text("🏦 Bank Logs", "cardshop:banklogs"),
      });
      return;
    }
    const priceLimit = ctx.from ? await getProductPriceLimit(ctx.from.id) : null;
    const price = parseFloat(l.price ?? "0");
    if (priceLimit === null || price > priceLimit) {
      await ctx.editMessageText("🔐 Tier limit.", { reply_markup: subscriptionPlansKeyboard() });
      return;
    }
    const kb = new InlineKeyboard();
    if (process.env.CRYPTOBOT_API_TOKEN) kb.text("USDT CryptoBot", `cardshop:bcbpay:${id}:USDT`).row();
    const coins = await getAvailableCoins();
    for (const coin of coins) {
      const info = COIN_INFO[coin];
      if (info) kb.text(`${info.emoji} ${coin}`, `cardshop:bcoinsel:${id}:${coin}`).row();
    }
    kb.text("🔙", "cardshop:banklogs");
    await ctx.editMessageText(
      `🏦 ${l.bankName} · ${l.country}\n${l.accountType}\n💰 $${price.toFixed(2)}`,
      { reply_markup: kb },
    );
  });

  bot.callbackQuery(/^cardshop:bcbpay:(\d+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = parseInt(ctx.match[1]!);
    const asset = ctx.match[2]! as CryptoBotAsset;
    const [l] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, id));
    if (!l || !ctx.from) return;
    try {
      const invoice = await createCryptoBotInvoice({
        amount: parseFloat(l.price ?? "0"),
        asset,
        description: `Bank log ${l.bankName}`,
        payload: `banklog:${id}:user:${ctx.from.id}`,
      });
      const [order] = await db
        .insert(ordersTable)
        .values({
          userId: ctx.from.id,
          productId: 0,
          quantity: 1,
          status: "pending",
          details: `BANKLOG:${id}|CRYPTOBOT:${asset}:${invoice.invoice_id}`,
        })
        .returning();
      await ctx.editMessageText(`Pay ${l.price} ${asset}:\n${invoice.pay_url}`, {
        reply_markup: new InlineKeyboard().text(
          "Check",
          `cardshop:cbcheck:${order!.id}:${invoice.invoice_id}`,
        ),
      });
    } catch (err) {
      logger.error({ err }, "banklog cbpay");
      await ctx.reply("❌ Invoice failed");
    }
  });

  bot.callbackQuery(/^cardshop:bcoinsel:(\d+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = parseInt(ctx.match[1]!);
    const coin = ctx.match[2]!;
    const [l] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, id));
    if (!l || !ctx.from) return;
    const ownerId = getOwnerId();
    const [settings] = await db
      .select()
      .from(paymentSettingsTable)
      .where(eq(paymentSettingsTable.ownerId, ownerId));
    const addr =
      coin === "USDT"
        ? settings?.trc20Address
        : coin === "BTC"
          ? settings?.btcAddress
          : coin === "BNB"
            ? settings?.bnbAddress
            : settings?.ethAddress;
    if (!addr) {
      await ctx.reply("Address not set");
      return;
    }
    const [order] = await db
      .insert(ordersTable)
      .values({
        userId: ctx.from.id,
        productId: 0,
        quantity: 1,
        status: "pending",
        details: `BANKLOG:${id}`,
      })
      .returning();
    await db.insert(paymentRequestsTable).values({
      orderId: order!.id,
      coin,
      address: addr,
      amount: String(l.price),
      reference: `ORD-${order!.id}`,
    });
    await ctx.editMessageText(
      `Order #${order!.id}\n${l.bankName}\nSend ${l.price} ${coin}\n\n${addr}`,
      {
        reply_markup: new InlineKeyboard()
          .text("✅ I've Paid", `cardshop:claimed:${order!.id}`)
          .text("❌", `cardshop:ordcancel:${order!.id}`),
      },
    );
    if (ownerId) {
      await ctx.api
        .sendMessage(ownerId, `BANKLOG ORDER #${order!.id}\n${l.bankName}\n${l.price} ${coin}`, {
          reply_markup: new InlineKeyboard()
            .text("✅ Confirm", `hex:oconfirm:${order!.id}`)
            .text("❌ Decline", `hex:odecline:${order!.id}`),
        })
        .catch(() => {});
    }
  });

  bot.callbackQuery("cardshop:torlinks", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.from) {
      await ensureAutoFreeAccess({
        id: ctx.from.id,
        username: ctx.from.username ?? null,
        firstName: ctx.from.first_name ?? null,
      }).catch(() => {});
    }
    const priceLimit = ctx.from ? await getProductPriceLimit(ctx.from.id) : null;
    const price = parseFloat(TOR_LINK_PRICE);
    if (priceLimit === null || price > priceLimit) {
      await ctx.editMessageText(
        "🔐 Tor Links need access that allows $10+ products.\n\nUpgrade or unlock free access first.",
        { reply_markup: subscriptionPlansKeyboard() },
      );
      return;
    }
    const kb = new InlineKeyboard();
    for (const t of TOR_LINKS) {
      kb.text(`🧅 ${t.name} — $10`, `cardshop:tor:${t.id}`).row();
    }
    kb.text("🔙 Shop", "cardshop:main");
    await ctx.editMessageText(`🧅 TOR LINKS\n\nLegitimate .onion services · $10 each`, {
      reply_markup: kb,
    });
  });

  bot.callbackQuery(/^cardshop:tor:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.match[1]!;
    const t = TOR_LINKS.find((x) => x.id === id);
    if (!t) {
      await ctx.editMessageText("Not found.", {
        reply_markup: new InlineKeyboard().text("🧅 Tor Links", "cardshop:torlinks"),
      });
      return;
    }
    const kb = new InlineKeyboard();
    if (process.env.CRYPTOBOT_API_TOKEN) kb.text("⚡ USDT CryptoBot", `cardshop:tcbpay:${id}:USDT`).row();
    const coins = await getAvailableCoins();
    for (const coin of coins) {
      const info = COIN_INFO[coin];
      if (info) kb.text(`${info.emoji} ${coin}`, `cardshop:tcoinsel:${id}:${coin}`).row();
    }
    kb.text("🔙 Tor Links", "cardshop:torlinks");
    await ctx.editMessageText(
      `🧅 ${t.name}\n━━━━━━━━━━━━━━━━━━\n\n${t.about}\n\nWhat you find: ${t.finds}\n\n💰 $10`,
      { reply_markup: kb },
    );
  });

  bot.callbackQuery(/^cardshop:tcbpay:(.+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.match[1]!;
    const asset = ctx.match[2]! as CryptoBotAsset;
    const t = TOR_LINKS.find((x) => x.id === id);
    if (!t || !ctx.from) return;
    try {
      const invoice = await createCryptoBotInvoice({
        amount: 10,
        asset,
        description: `Tor: ${t.name}`,
        payload: `tor:${id}:user:${ctx.from.id}`,
      });
      const [order] = await db
        .insert(ordersTable)
        .values({
          userId: ctx.from.id,
          productId: 0,
          quantity: 1,
          status: "pending",
          details: `TORLINK:${id}|CRYPTOBOT:${asset}:${invoice.invoice_id}`,
        })
        .returning();
      await ctx.editMessageText(`Pay $10 ${asset}:\n${invoice.pay_url}`, {
        reply_markup: new InlineKeyboard().text(
          "Check",
          `cardshop:cbcheck:${order!.id}:${invoice.invoice_id}`,
        ),
      });
    } catch (err) {
      logger.error({ err }, "tor cbpay");
      await ctx.reply("❌ Invoice failed");
    }
  });

  bot.callbackQuery(/^cardshop:tcoinsel:(.+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.match[1]!;
    const coin = ctx.match[2]!;
    const t = TOR_LINKS.find((x) => x.id === id);
    if (!t || !ctx.from) return;
    const ownerId = getOwnerId();
    const [settings] = await db
      .select()
      .from(paymentSettingsTable)
      .where(eq(paymentSettingsTable.ownerId, ownerId));
    const addr =
      coin === "USDT"
        ? settings?.trc20Address
        : coin === "BTC"
          ? settings?.btcAddress
          : coin === "BNB"
            ? settings?.bnbAddress
            : settings?.ethAddress;
    if (!addr) {
      await ctx.reply("Address not set");
      return;
    }
    const [order] = await db
      .insert(ordersTable)
      .values({
        userId: ctx.from.id,
        productId: 0,
        quantity: 1,
        status: "pending",
        details: `TORLINK:${id}`,
      })
      .returning();
    await db.insert(paymentRequestsTable).values({
      orderId: order!.id,
      coin,
      address: addr,
      amount: TOR_LINK_PRICE,
      reference: `ORD-${order!.id}`,
    });
    await ctx.editMessageText(
      `🧅 ${t.name}\nOrder #${order!.id}\nSend ${TOR_LINK_PRICE} ${coin}\n\n${addr}`,
      {
        reply_markup: new InlineKeyboard()
          .text("✅ I've Paid", `cardshop:claimed:${order!.id}`)
          .text("❌", `cardshop:ordcancel:${order!.id}`),
      },
    );
    if (ownerId) {
      await ctx.api
        .sendMessage(ownerId, `TOR LINK ORDER #${order!.id}\n${t.name}\n${TOR_LINK_PRICE} ${coin}`, {
          reply_markup: new InlineKeyboard()
            .text("✅ Confirm", `hex:oconfirm:${order!.id}`)
            .text("❌ Decline", `hex:odecline:${order!.id}`),
        })
        .catch(() => {});
    }
  });
}
