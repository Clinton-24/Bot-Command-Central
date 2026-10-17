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
import { createCryptoBotInvoice, CRYPTOBOT_ASSETS, type CryptoBotAsset } from "./cryptobot";

const CATEGORY_EMOJIS: Record<string, string> = {
  streaming: "📺",
  gaming: "🎮",
  vpn: "🛡️",
  giftcard: "🎁",
  social: "📱",
  cards: "💳",
};

const COIN_INFO: Record<string, { emoji: string; network: string }> = {
  "USDT-BEP20": { emoji: "💛", network: "BEP20 (BSC)" },
  BNB: { emoji: "🟡", network: "BSC" },
  "USDT-TRC20": { emoji: "🟢", network: "TRC20 (Tron)" },
  BTC: { emoji: "🟠", network: "Bitcoin" },
  ETH: { emoji: "⬜", network: "Ethereum" },
};

/** Curated legitimate .onion resources — $10 each. Official/public services only. No markets. */
const TOR_LINK_PRICE = "10.00";
const TOR_LINKS: {
  id: string;
  name: string;
  about: string;
  finds: string;
  onion: string;
}[] = [
  {
    id: "ddg",
    name: "DuckDuckGo Search (Onion)",
    about: "Official privacy search engine on Tor.",
    finds: "Web search without exit-node tracking.",
    onion: "https://duckduckgogg42xjoc72x3sjasowoarfbgcmvfimaftt6twagswzczad.onion",
  },
  {
    id: "torproject",
    name: "Tor Project Official",
    about: "The official Tor Project website on onion.",
    finds: "Tor Browser downloads, documentation, support.",
    onion: "http://2gzyxa5ihm7nsggfxnu52rck2vv4rvmdlkiu3zzui5du4xyclen53wid.onion",
  },
  {
    id: "protonmail",
    name: "Proton Mail (Onion)",
    about: "Proton’s end-to-end encrypted email over Tor.",
    finds: "Secure inbox without exposing your IP to clearnet endpoints.",
    onion: "https://protonmailrmez3lotccipshtkleegetolb73fuirgj7r4o4vfu7ozyd.onion",
  },
  {
    id: "nytimes",
    name: "The New York Times (Onion)",
    about: "NYT’s official onion mirror.",
    finds: "Full NYT journalism over Tor.",
    onion: "https://www.nytimes3xbfgragh.onion",
  },
  {
    id: "bbc",
    name: "BBC News (Onion)",
    about: "BBC’s official onion service.",
    finds: "BBC news coverage over Tor.",
    onion: "https://www.bbcnewsd73hkzno2ini43a6qrcunjqz37yvnpkb6qazsykquxpd5tlq.onion",
  },
  {
    id: "facebook",
    name: "Facebook / Meta (Onion)",
    about: "Meta’s official Facebook onion.",
    finds: "Facebook login over Tor.",
    onion: "https://www.facebookwkhpilnemxj7asaniu7vnjjbiltxjqhye3mhbshg7kx5tfayd.onion",
  },
  {
    id: "propublica",
    name: "ProPublica (Onion)",
    about: "Independent nonprofit investigative journalism. Official onion mirror.",
    finds: "Investigations and news without clearnet censorship friction.",
    onion: "https://www.propub3r6espa33w.onion",
  },
  {
    id: "cia",
    name: "CIA.gov (Onion)",
    about: "U.S. Central Intelligence Agency public website on Tor.",
    finds: "Public CIA.gov content (careers, news, history) over Tor.",
    onion: "http://ciadotgov4sjwlzihbbgxnqg3xiyrg7so2r2o3lt5ceclq3qzt6gdaqd.onion",
  },
  {
    id: "riseup",
    name: "Riseup (Onion)",
    about: "Activist-oriented email, lists, and VPN with strong privacy focus.",
    finds: "Riseup account services and documentation over Tor.",
    onion: "http://vww6ybal4bd7szmgncyruucpgfkqahzddi37ktceo3ah7ngmcopnpyyd.onion",
  },
  {
    id: "debian",
    name: "Debian (Onion)",
    about: "Official Debian Project onion services.",
    finds: "Debian documentation and package info over Tor.",
    onion: "http://5emwn4bxbrgkh6wqbthnkkmvsm5v256wtzlxupreztudshqu67ixn4qd.onion",
  },
  {
    id: "keybase",
    name: "Keybase (Onion)",
    about: "Identity and encrypted chat with an official onion endpoint.",
    finds: "Keybase profiles and secure messaging over Tor.",
    onion: "http://keybase5wmilwokqirssclfnsqrjdsi7jdir5wy7y7iu3tanwdbfzoid.onion",
  },
  {
    id: "cryptostorm",
    name: "Cryptostorm VPN (Onion)",
    about: "Privacy-focused VPN provider’s official onion site.",
    finds: "VPN account info, configs, and support docs over Tor.",
    onion: "http://stormwayszuh4jrt745bbigxiqvdpzllj7f3dxkjc3ew3mgmtedvmgsd.onion",
  },
  {
    id: "dw",
    name: "Deutsche Welle (Onion)",
    about: "German international broadcaster’s onion service.",
    finds: "DW world news in multiple languages over Tor.",
    onion: "https://www.dwnewsgngmhlplxy6o2twt2ktxwjt7dyt4w4r7jmwj5xjnq.onion",
  },
  {
    id: "securesdrop_guardian",
    name: "Guardian SecureDrop",
    about: "The Guardian’s whistleblower submission system (SecureDrop) on Tor.",
    finds: "Anonymous tip submission to Guardian journalists — not a market.",
    onion: "http://theguardian2d2mn.onion",
  },
  {
    id: "qubes",
    name: "Qubes OS (Onion)",
    about: "Official Qubes OS project — security-by-isolation desktop OS.",
    finds: "Downloads, docs, and project news for Qubes over Tor.",
    onion: "http://qubesosfasa4zl54gj5gf5fjh3h5t6f2j4yq.onion",
  },
  {
    id: "archive_today",
    name: "Archive.today (Onion)",
    about: "Webpage snapshot / archive service with Tor access.",
    finds: "Save and view archived snapshots of public web pages.",
    onion: "http://archiveiya74codqgiixo33q62qlrqtkgmcitqx5u2oeqnmn5bpcbiyd.onion",
  },
];

function torLinkById(id: string) {
  return TOR_LINKS.find((t) => t.id === id);
}

function formatTorDelivery(t: (typeof TOR_LINKS)[number]): string {
  return (
    `🧅 ${t.name}\n━━━━━━━━━━━━━━━━━━\n\n` +
    `About: ${t.about}\n\n` +
    `What you get: ${t.finds}\n\n` +
    `Onion URL:\n${t.onion}\n\n` +
    `Open with Tor Browser only.`
  );
}

function catEmoji(cat: string): string {
  return CATEGORY_EMOJIS[cat] ?? "📦";
}

function getOwnerId(): number {
  return parseInt(process.env["BOT_OWNER_ID"] ?? "0", 10);
}

async function generatePaymentDetails(
  coin: string,
  orderId: number,
  price: string
): Promise<{ address: string; amount: string } | null> {
  const ownerId = getOwnerId();
  if (!ownerId) return null;
  const rows = await db
    .select()
    .from(paymentSettingsTable)
    .where(eq(paymentSettingsTable.ownerId, ownerId));
  const s = rows[0];
  if (!s) return null;
  let address = "";
  let isUniqueAddr = false;
  if (coin === "USDT-BEP20" || coin === "BNB") {
    if (s.bnbXpub) {
      try {
        const { HDNodeWallet } = await import("ethers");
        const root = HDNodeWallet.fromExtendedKey(s.bnbXpub);
        const child = root.deriveChild(0).deriveChild(orderId % 0x7fffffff);
        address = child.address;
        isUniqueAddr = true;
      } catch (err) {
        logger.error({ err }, "xpub derivation failed, falling back to static");
        address = s.bnbAddress ?? "";
      }
    } else {
      address = s.bnbAddress ?? "";
    }
  } else if (coin === "USDT-TRC20") {
    address = s.trc20Address ?? "";
  } else if (coin === "BTC") {
    address = s.btcAddress ?? "";
  } else if (coin === "ETH") {
    address = s.ethAddress ?? "";
  }
  if (!address) return null;
  let amount: string;
  if (isUniqueAddr) {
    amount = parseFloat(price).toFixed(2);
  } else {
    const cents = (orderId % 99) + 1;
    amount = (parseFloat(price) + cents / 100).toFixed(2);
  }
  return { address, amount };
}

async function getAvailableCoins(): Promise<string[]> {
  const ownerId = getOwnerId();
  if (!ownerId) return [];
  const rows = await db
    .select()
    .from(paymentSettingsTable)
    .where(eq(paymentSettingsTable.ownerId, ownerId));
  const s = rows[0];
  if (!s) return [];
  const coins: string[] = [];
  if (s.bnbAddress || s.bnbXpub) coins.push("USDT-BEP20", "BNB");
  if (s.trc20Address) coins.push("USDT-TRC20");
  if (s.btcAddress) coins.push("BTC");
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
    await ctx.reply(
      `🛍️ *CARDSHOP*\n━━━━━━━━━━━━━━━━━━\n\nBrowse and buy digital products. Payments via crypto.`,
      { parse_mode: "Markdown", reply_markup: cardShopKeyboard() }
    );
  });
}

export function registerCardShopCallbacks(bot: MyBot): void {
  bot.callbackQuery("cardshop:main", async (ctx) => {
    await ctx.editMessageText(
      `🛍️ *CARDSHOP*\n━━━━━━━━━━━━━━━━━━\n\nBrowse and buy digital products.`,
      { parse_mode: "Markdown", reply_markup: cardShopKeyboard() }
    );
    await ctx.answerCallbackQuery();
  });

  async function showProductList(ctx: BotContext, category?: string) {
    const products = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.isActive, true))
      .orderBy(productsTable.name);
    const catNorm = category?.trim().toLowerCase();
    const scoped = catNorm
      ? products.filter((p) => String(p.category || "").trim().toLowerCase() === catNorm)
      : products;
    const priceLimit = ctx.from ? await getProductPriceLimit(ctx.from.id) : null;
    const visibleProducts = scoped.filter(
      (product) => priceLimit !== null && parseFloat(String(product.price)) <= priceLimit,
    );
    if (visibleProducts.length === 0) {
      await ctx.editMessageText(
        priceLimit === null
          ? "🔐 *Access required*\n\nUse a referral or choose a paid plan."
          : `No products in this category for your tier.`,
        { parse_mode: "Markdown", reply_markup: subscriptionPlansKeyboard() }
      );
      return;
    }
    const catLabel = category ? `${catEmoji(category)} ${category.toUpperCase()}` : "PRODUCTS";
    const kb = new InlineKeyboard();
    for (const p of visibleProducts) {
      kb.text(
        `${catEmoji(p.category)} ${p.name} — $${parseFloat(String(p.price)).toFixed(2)}`,
        `cardshop:product:${p.id}`
      ).row();
    }
    kb.text("🔙 Shop", "cardshop:main");
    await ctx.editMessageText(
      `🛍️ *${catLabel}*\n━━━━━━━━━━━━━━━━━━\n\n${visibleProducts.length} product(s):`,
      { parse_mode: "Markdown", reply_markup: kb }
    ).catch(() => {});
  }

  bot.callbackQuery(/^cardshop:cat:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showProductList(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^cardshop:product:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
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
      await ctx.editMessageText("🔐 Higher tier required.", {
        parse_mode: "Markdown", reply_markup: subscriptionPlansKeyboard()
      });
      return;
    }
    await ctx.editMessageText(
      `${catEmoji(p.category)} ${p.name}\n━━━━━━━━━━━━━━━━━━\n\n` +
        `💰 $${parseFloat(String(p.price)).toFixed(2)}\n` +
        (p.description ? `📝 ${p.description}` : ""),
      {
        reply_markup: new InlineKeyboard()
          .text("🛒 Buy Now", `cardshop:buy:${p.id}`)
          .row()
          .text("🔙 Back", p.category ? `cardshop:cat:${p.category}` : "cardshop:main"),
      },
    ).catch(() => {});
  });

  bot.callbackQuery(/^cardshop:buy:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const productId = parseInt(ctx.match[1]!);
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!p || !p.isActive) {
      await ctx.editMessageText("❌ Product unavailable.", {
        reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main"),
      });
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
    await ctx.answerCallbackQuery("⏳ Invoice...");
    const productId = parseInt(ctx.match[1]!);
    const asset = ctx.match[2] as CryptoBotAsset;
    const userId = ctx.from!.id;
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!p || !p.isActive) return;
    const [order] = await db.insert(ordersTable).values({ userId, productId, quantity: 1, status: "pending" }).returning();
    if (!order) return;
    try {
      const invoice = await createCryptoBotInvoice({
        asset, amount: parseFloat(String(p.price)), orderId: order.id, productName: p.name, userId,
      });
      await db.insert(paymentRequestsTable).values({
        orderId: order.id, coin: asset, address: invoice.invoice_id.toString(), amount: invoice.amount,
        reference: `CB-${invoice.invoice_id}`, status: "pending",
      });
      await ctx.editMessageText(`Pay ${invoice.amount} ${asset}\nOrder #${order.id}`, {
        reply_markup: new InlineKeyboard()
          .url("Pay", invoice.bot_invoice_url)
          .row()
          .text("Check", `cardshop:cbcheck:${order.id}:${invoice.invoice_id}`),
      });
    } catch (err) {
      await db.update(ordersTable).set({ status: "cancelled" }).where(eq(ordersTable.id, order.id));
      await ctx.editMessageText(`❌ ${err instanceof Error ? err.message : "Failed"}`);
    }
  });

  bot.callbackQuery(/^cardshop:cbcheck:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("🔄 Checking...");
    const orderId = parseInt(ctx.match[1]!);
    const invoiceId = parseInt(ctx.match[2]!);
    const { checkCryptoBotInvoice } = await import("./cryptobot");
    const invoice = await checkCryptoBotInvoice(invoiceId);
    if (!invoice) { await ctx.reply("❌ Could not check."); return; }
    if (invoice.status === "paid") {
      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
      if (order && order.status !== "confirmed") {
        await db.update(ordersTable).set({ status: "confirmed", updatedAt: new Date() }).where(eq(ordersTable.id, orderId));
        await db.update(paymentRequestsTable).set({ status: "confirmed", confirmedAt: new Date() }).where(eq(paymentRequestsTable.orderId, orderId)).catch(() => {});
        const bankMatch = order.details?.match(/^BANKLOG:(\d+)$/);
        const torMatch = order.details?.match(/^TORLINK:(.+)$/);
        if (bankMatch) {
          const logId = parseInt(bankMatch[1]!, 10);
          const [log] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, logId));
          if (log) {
            await db.update(bankLogsTable).set({ status: "sold", isSold: true, soldAt: new Date() }).where(eq(bankLogsTable.id, logId));
            const msg = `✅ Paid — Order #${orderId}\n🏦 ${log.bankName}\n` +
              (log.loginUrl ? `URL: ${log.loginUrl}\n` : "") +
              (log.username ? `User: ${log.username}\n` : "") +
              (log.password ? `Pass: ${log.password}\n` : "");
            await ctx.editMessageText(msg).catch(() => ctx.reply(msg));
          }
        } else if (torMatch) {
          const t = torLinkById(torMatch[1]!.trim());
          const msg = t ? `✅ Paid — Order #${orderId}\n\n${formatTorDelivery(t)}` : `✅ Paid — Order #${orderId}`;
          await ctx.editMessageText(msg).catch(() => ctx.reply(msg));
        } else {
          const [product] = await db.select().from(productsTable).where(eq(productsTable.id, order.productId));
          let msg = `✅ Paid — Order #${orderId}\n📦 ${product?.name ?? "Order"}\n`;
          if (product?.deliveryType === "auto" && product.deliveryContent) msg += `\n🎁 ${product.deliveryContent}`;
          else msg += `\n⏳ Seller will deliver shortly.`;
          await ctx.editMessageText(msg).catch(() => ctx.reply(msg));
        }
      } else await ctx.reply("✅ Already confirmed.");
    } else await ctx.reply(`⏳ Status: ${invoice.status}`);
  });

  bot.callbackQuery(/^cardshop:coinsel:(\d+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const productId = parseInt(ctx.match[1]!);
    const coin = ctx.match[2]!;
    const userId = ctx.from!.id;
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!p || !p.isActive) return;
    const [order] = await db.insert(ordersTable).values({ userId, productId, quantity: 1, status: "pending" }).returning();
    if (!order) return;
    const payDetails = await generatePaymentDetails(coin, order.id, String(p.price));
    if (!payDetails) {
      await db.update(ordersTable).set({ status: "cancelled" }).where(eq(ordersTable.id, order.id));
      await ctx.editMessageText("⚠️ Payment address unavailable.");
      return;
    }
    await db.insert(paymentRequestsTable).values({
      orderId: order.id, coin, address: payDetails.address, amount: payDetails.amount, reference: `ORD-${order.id}`,
    });
    await ctx.editMessageText(`Send ${payDetails.amount} ${coin}\n${payDetails.address}\nOrder #${order.id}`, {
      reply_markup: new InlineKeyboard()
        .text("✅ I've Paid", `cardshop:claimed:${order.id}`)
        .text("❌ Cancel", `cardshop:ordcancel:${order.id}`),
    });
    const ownerId = getOwnerId();
    if (ownerId) {
      await ctx.api.sendMessage(ownerId, `🛒 ORDER #${order.id}\n${p.name}\n${payDetails.amount} ${coin}`, {
        reply_markup: new InlineKeyboard()
          .text("✅ Confirm", `hex:oconfirm:${order.id}`)
          .text("❌ Decline", `hex:odecline:${order.id}`),
      }).catch(() => {});
    }
  });

  bot.callbackQuery(/^cardshop:claimed:(\d+)$/, async (ctx) => {
    const orderId = parseInt(ctx.match[1]!);
    const userId = ctx.from!.id;
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    if (!order || order.userId !== userId) {
      await ctx.answerCallbackQuery("❌ Order not found.");
      return;
    }
    if (order.status !== "pending") {
      await ctx.answerCallbackQuery(`Already ${order.status}`);
      return;
    }
    await ctx.answerCallbackQuery("Notified owner");
    await ctx.editMessageText(`⏳ Payment claim sent for order #${orderId}. Wait for owner confirm.`);
    const oid = getOwnerId();
    if (oid) {
      await ctx.api.sendMessage(oid, `💳 Claim order #${orderId} user ${userId}`, {
        reply_markup: new InlineKeyboard()
          .text("✅ Confirm", `hex:oconfirm:${orderId}`)
          .text("❌ Decline", `hex:odecline:${orderId}`),
      }).catch(() => {});
    }
  });

  bot.callbackQuery(/^cardshop:ordcancel:(\d+)$/, async (ctx) => {
    const orderId = parseInt(ctx.match[1]!);
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    if (order && order.userId === ctx.from!.id && order.status === "pending") {
      await db.update(ordersTable).set({ status: "cancelled" }).where(eq(ordersTable.id, orderId));
    }
    await ctx.answerCallbackQuery("Cancelled");
    await ctx.editMessageText("Order cancelled.", {
      reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main"),
    });
  });

  bot.callbackQuery("cardshop:myorders", async (ctx) => {
    await ctx.answerCallbackQuery();
    const orders = await db.select().from(ordersTable).where(eq(ordersTable.userId, ctx.from!.id)).orderBy(desc(ordersTable.createdAt)).limit(15);
    if (orders.length === 0) {
      await ctx.editMessageText("📋 No orders yet.", {
        reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main"),
      });
      return;
    }
    const lines = orders.map((o) => `#${o.id} ${o.status}`).join("\n");
    await ctx.editMessageText(`📋 MY ORDERS\n\n${lines}`, {
      reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main"),
    });
  });

  bot.callbackQuery("cardshop:banklogs", async (ctx) => {
    await ctx.answerCallbackQuery();
    const logs = await db.select().from(bankLogsTable).where(eq(bankLogsTable.status, "available")).orderBy(desc(bankLogsTable.addedAt)).limit(40);
    if (logs.length === 0) {
      await ctx.editMessageText("🏦 BANK LOGS\n\nNo logs available.", {
        reply_markup: new InlineKeyboard().text("🔙 Shop", "cardshop:main"),
      }).catch(() => {});
      return;
    }
    const priceLimit = ctx.from ? await getProductPriceLimit(ctx.from.id) : null;
    const visible = logs.filter((l) => priceLimit !== null && parseFloat(l.price ?? "0") <= priceLimit);
    const kb = new InlineKeyboard();
    for (const l of visible) {
      kb.text(`🏦 ${l.bankName} · ${l.country} — $${parseFloat(l.price ?? "0").toFixed(2)}`, `cardshop:blog:${l.id}`).row();
    }
    kb.text("🔙 Shop", "cardshop:main");
    await ctx.editMessageText(`🏦 BANK LOGS\n\n${visible.length} available:`, { reply_markup: kb }).catch(() => {});
  });

  bot.callbackQuery(/^cardshop:blog:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = parseInt(ctx.match[1]!, 10);
    const [log] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, id));
    if (!log || log.status !== "available") {
      await ctx.editMessageText("❌ Unavailable.", {
        reply_markup: new InlineKeyboard().text("🏦 Bank Logs", "cardshop:banklogs"),
      }).catch(() => {});
      return;
    }
    const price = parseFloat(log.price ?? "0");
    const text = `🏦 ${log.bankName} · ${log.country}\nType: ${log.accountType}\nPrice: $${price.toFixed(2)}\n\nDetails after payment confirmed.`;
    const coins = await getAvailableCoins();
    const kb = new InlineKeyboard();
    if (process.env.CRYPTOBOT_API_TOKEN) kb.text("USDT CryptoBot", `cardshop:bcbpay:${id}:USDT`).row();
    for (const coin of coins) {
      const info = COIN_INFO[coin];
      if (info) kb.text(`${info.emoji} ${coin}`, `cardshop:bcoinsel:${id}:${coin}`).row();
    }
    kb.text("🔙", "cardshop:banklogs");
    await ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
  });

  bot.callbackQuery(/^cardshop:bcbpay:(\d+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("⏳ Invoice...");
    const logId = parseInt(ctx.match[1]!, 10);
    const asset = ctx.match[2]! as CryptoBotAsset;
    const [log] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, logId));
    if (!log || log.status !== "available") return;
    const [order] = await db.insert(ordersTable).values({
      userId: ctx.from!.id, productId: 0, quantity: 1, status: "pending", details: `BANKLOG:${logId}`,
    }).returning();
    if (!order) return;
    try {
      const invoice = await createCryptoBotInvoice({
        asset, amount: parseFloat(log.price ?? "0"), orderId: order.id, productName: log.bankName, userId: ctx.from!.id,
      });
      await db.insert(paymentRequestsTable).values({
        orderId: order.id, coin: asset, address: String(invoice.invoice_id), amount: invoice.amount,
        reference: `CB-${invoice.invoice_id}`, status: "pending",
      });
      await ctx.editMessageText(`Pay ${invoice.amount} ${asset}`, {
        reply_markup: new InlineKeyboard()
          .url("Pay", invoice.bot_invoice_url)
          .row()
          .text("Check", `cardshop:cbcheck:${order.id}:${invoice.invoice_id}`),
      }).catch(() => {});
    } catch (e) {
      await db.update(ordersTable).set({ status: "cancelled" }).where(eq(ordersTable.id, order.id));
      await ctx.editMessageText(`❌ ${e instanceof Error ? e.message : "err"}`).catch(() => {});
    }
  });

  bot.callbackQuery(/^cardshop:bcoinsel:(\d+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const logId = parseInt(ctx.match[1]!, 10);
    const coin = ctx.match[2]!;
    const [log] = await db.select().from(bankLogsTable).where(eq(bankLogsTable.id, logId));
    if (!log || log.status !== "available") return;
    const [order] = await db.insert(ordersTable).values({
      userId: ctx.from!.id, productId: 0, quantity: 1, status: "pending", details: `BANKLOG:${logId}`,
    }).returning();
    if (!order) return;
    const pay = await generatePaymentDetails(coin, order.id, log.price ?? "0");
    if (!pay) {
      await db.update(ordersTable).set({ status: "cancelled" }).where(eq(ordersTable.id, order.id));
      await ctx.editMessageText("⚠️ No address").catch(() => {});
      return;
    }
    await db.insert(paymentRequestsTable).values({
      orderId: order.id, coin, address: pay.address, amount: pay.amount, reference: `ORD-${order.id}`,
    });
    await ctx.editMessageText(`Send ${pay.amount} ${coin}\n${pay.address}`, {
      reply_markup: new InlineKeyboard()
        .text("✅ I've Paid", `cardshop:claimed:${order.id}`)
        .text("❌", `cardshop:ordcancel:${order.id}`),
    }).catch(() => {});
    const oid = getOwnerId();
    if (oid) {
      await ctx.api.sendMessage(oid, `BANK LOG ORDER #${order.id} ${log.bankName} ${pay.amount} ${coin}`, {
        reply_markup: new InlineKeyboard()
          .text("✅ Confirm", `hex:oconfirm:${order.id}`)
          .text("❌ Decline", `hex:odecline:${order.id}`),
      }).catch(() => {});
    }
  });

  bot.callbackQuery("cardshop:torlinks", async (ctx) => {
    await ctx.answerCallbackQuery();
    const priceLimit = ctx.from ? await getProductPriceLimit(ctx.from.id) : null;
    const price = parseFloat(TOR_LINK_PRICE);
    if (priceLimit === null || price > priceLimit) {
      await ctx.editMessageText(
        "🔐 Tor Links need access that allows $10+ products.\n\nUpgrade or unlock free access first.",
        { reply_markup: subscriptionPlansKeyboard() },
      ).catch(() => {});
      return;
    }
    const kb = new InlineKeyboard();
    for (const t of TOR_LINKS) {
      kb.text(`🧅 ${t.name} — $10`, `cardshop:tor:${t.id}`).row();
    }
    kb.text("🔙 Shop", "cardshop:main");
    await ctx.editMessageText(
      `🧅 TOR LINKS\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Legitimate official .onion resources only (no markets).\n` +
        `Each is $10 — you get what the site is, what it opens, and what you can do there.\n\n` +
        `Open delivered URLs only in Tor Browser.`,
      { reply_markup: kb },
    ).catch(() => {});
  });

  bot.callbackQuery(/^cardshop:tor:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = ctx.match![1]!;
    const t = torLinkById(id);
    if (!t) {
      await ctx.editMessageText("❌ Link not found.", {
        reply_markup: new InlineKeyboard().text("🧅 Tor Links", "cardshop:torlinks"),
      }).catch(() => {});
      return;
    }
    const text =
      `🧅 ${t.name}\n━━━━━━━━━━━━━━━━━━\n\n` +
      `About:\n${t.about}\n\n` +
      `What you can find / do:\n${t.finds}\n\n` +
      `Price: $10.00\n\n` +
      `After payment is confirmed you receive the full onion URL.\nUse Tor Browser only.`;
    const coins = await getAvailableCoins();
    const kb = new InlineKeyboard();
    if (process.env.CRYPTOBOT_API_TOKEN) kb.text("⚡ USDT CryptoBot", `cardshop:tcbpay:${id}:USDT`).row();
    for (const coin of coins) {
      const info = COIN_INFO[coin];
      if (info) kb.text(`${info.emoji} ${coin}`, `cardshop:tcoinsel:${id}:${coin}`).row();
    }
    kb.text("🔙 Tor Links", "cardshop:torlinks");
    await ctx.editMessageText(text, { reply_markup: kb }).catch(() => {});
  });

  bot.callbackQuery(/^cardshop:tcbpay:(.+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("⏳ Invoice...");
    const linkId = ctx.match![1]!;
    const asset = ctx.match![2]! as CryptoBotAsset;
    const t = torLinkById(linkId);
    if (!t) return;
    const [order] = await db.insert(ordersTable).values({
      userId: ctx.from!.id, productId: 0, quantity: 1, status: "pending", details: `TORLINK:${linkId}`,
    }).returning();
    if (!order) return;
    try {
      const invoice = await createCryptoBotInvoice({
        asset, amount: parseFloat(TOR_LINK_PRICE), orderId: order.id, productName: t.name, userId: ctx.from!.id,
      });
      await db.insert(paymentRequestsTable).values({
        orderId: order.id, coin: asset, address: String(invoice.invoice_id), amount: invoice.amount,
        reference: `CB-${invoice.invoice_id}`, status: "pending",
      });
      await ctx.editMessageText(`Pay ${invoice.amount} ${asset}\nOrder #${order.id}\n${t.name}`, {
        reply_markup: new InlineKeyboard()
          .url("Pay", invoice.bot_invoice_url)
          .row()
          .text("Check", `cardshop:cbcheck:${order.id}:${invoice.invoice_id}`),
      }).catch(() => {});
    } catch (e) {
      await db.update(ordersTable).set({ status: "cancelled" }).where(eq(ordersTable.id, order.id));
      await ctx.editMessageText(`❌ ${e instanceof Error ? e.message : "err"}`).catch(() => {});
    }
  });

  bot.callbackQuery(/^cardshop:tcoinsel:(.+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const linkId = ctx.match![1]!;
    const coin = ctx.match![2]!;
    const t = torLinkById(linkId);
    if (!t) return;
    const [order] = await db.insert(ordersTable).values({
      userId: ctx.from!.id, productId: 0, quantity: 1, status: "pending", details: `TORLINK:${linkId}`,
    }).returning();
    if (!order) return;
    const pay = await generatePaymentDetails(coin, order.id, TOR_LINK_PRICE);
    if (!pay) {
      await db.update(ordersTable).set({ status: "cancelled" }).where(eq(ordersTable.id, order.id));
      await ctx.editMessageText("⚠️ No address").catch(() => {});
      return;
    }
    await db.insert(paymentRequestsTable).values({
      orderId: order.id, coin, address: pay.address, amount: pay.amount, reference: `ORD-${order.id}`,
    });
    await ctx.editMessageText(`🧅 ${t.name}\nOrder #${order.id}\nSend ${pay.amount} ${coin}\n\n${pay.address}`, {
      reply_markup: new InlineKeyboard()
        .text("✅ I've Paid", `cardshop:claimed:${order.id}`)
        .text("❌", `cardshop:ordcancel:${order.id}`),
    }).catch(() => {});
    const oid = getOwnerId();
    if (oid) {
      await ctx.api.sendMessage(oid, `TOR LINK ORDER #${order.id}\n${t.name}\n${pay.amount} ${coin}`, {
        reply_markup: new InlineKeyboard()
          .text("✅ Confirm", `hex:oconfirm:${order.id}`)
          .text("❌ Decline", `hex:odecline:${order.id}`),
      }).catch(() => {});
    }
  });
}
