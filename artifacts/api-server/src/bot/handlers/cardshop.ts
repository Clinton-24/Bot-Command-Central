import { InlineKeyboard } from "grammy";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  productsTable,
  ordersTable,
  paymentSettingsTable,
  paymentRequestsTable,
} from "@workspace/db";
import type { MyBot } from "../index";
import type { BotContext } from "../context";
import { logger } from "../../lib/logger";
import { getProductPriceLimit, subscriptionPlansKeyboard } from "./access";
import { createCryptoBotInvoice, CRYPTOBOT_ASSETS, type CryptoBotAsset } from "./cryptobot";

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

const COIN_INFO: Record<string, { emoji: string; network: string }> = {
  "USDT-BEP20": { emoji: "💛", network: "BEP20 (BSC)" },
  BNB: { emoji: "🟡", network: "BSC" },
  "USDT-TRC20": { emoji: "🟢", network: "TRC20 (Tron)" },
  BTC: { emoji: "🟠", network: "Bitcoin" },
  ETH: { emoji: "⬜", network: "Ethereum" },
};

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
    .text("🎭 All Products", "cardshop:all")
    .row()
    .text("📦 General", "cardshop:cat:general")
    .text("🌐 Other", "cardshop:cat:other")
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
      ? products.filter((p) => String(p.category || "general").trim().toLowerCase() === catNorm)
      : products;
    const priceLimit = ctx.from ? await getProductPriceLimit(ctx.from.id) : null;
    const visibleProducts = scoped.filter(
      (product) => priceLimit !== null && parseFloat(String(product.price)) <= priceLimit,
    );

    if (visibleProducts.length === 0) {
      await ctx.editMessageText(
        priceLimit === null
          ? "🔐 *Access required*\n\nUse a referral from an active bot user for Free access, or choose a paid plan."
          : `🔐 No products in this category are available for your tier.\n\nYour tier allows products up to *$${priceLimit === Number.POSITIVE_INFINITY ? "any price" : priceLimit.toFixed(2)}*. Upgrade for broader access.`,
        { parse_mode: "Markdown", reply_markup: subscriptionPlansKeyboard() }
      );
      return;
    }

    const catLabel = category ? `${catEmoji(category)} ${category.toUpperCase()}` : "🎭 ALL PRODUCTS";
    const kb = new InlineKeyboard();
    for (const p of visibleProducts) {
      kb.text(
        `${catEmoji(p.category)} ${p.name} — $${parseFloat(String(p.price)).toFixed(2)}`,
        `cardshop:product:${p.id}`
      ).row();
    }
    kb.text("🔙 Shop", "cardshop:main");

    await ctx.editMessageText(
      `🛍️ *${catLabel}*\n━━━━━━━━━━━━━━━━━━\n\n${visibleProducts.length} product(s) available:`,
      { parse_mode: "Markdown", reply_markup: kb }
    ).catch(() => {});
  }

  bot.callbackQuery("cardshop:all", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showProductList(ctx);
  });

  bot.callbackQuery(/^cardshop:cat:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await showProductList(ctx, ctx.match[1]);
  });

  bot.callbackQuery(/^cardshop:product:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const id = parseInt(ctx.match[1]!);
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, id));

    if (!p || !p.isActive) {
      await ctx.editMessageText("❌ This product is no longer available.", {
        reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main"),
      });
      return;
    }

    const priceLimit = ctx.from ? await getProductPriceLimit(ctx.from.id) : null;
    if (priceLimit === null || parseFloat(String(p.price)) > priceLimit) {
      await ctx.editMessageText(
        "🔐 This product requires a higher access tier.\n\nChoose a paid plan to unlock more products.",
        { parse_mode: "Markdown", reply_markup: subscriptionPlansKeyboard() }
      );
      return;
    }

    const coins = await getAvailableCoins();
    const paymentNote =
      coins.length > 0
        ? `💳 Accepts: ${coins.map((c) => COIN_INFO[c]?.emoji ?? c).join(" ")}`
        : process.env.CRYPTOBOT_API_TOKEN
          ? "💳 CryptoBot payments available"
          : "⚠️ Payments not yet configured";

    await ctx
      .editMessageText(
        `${catEmoji(p.category)} ${p.name}\n━━━━━━━━━━━━━━━━━━\n\n` +
          `💰 Price: $${parseFloat(String(p.price)).toFixed(2)}\n` +
          `📁 Category: ${p.category || "general"}\n` +
          `${paymentNote}\n\n` +
          (p.description ? `📝 ${p.description}` : "No description."),
        {
          reply_markup: new InlineKeyboard()
            .text(
              coins.length > 0 || !!process.env.CRYPTOBOT_API_TOKEN
                ? "🛒 Buy Now"
                : "⚠️ Payments not set up",
              `cardshop:buy:${p.id}`,
            )
            .row()
            .text("🔙 Back", p.category ? `cardshop:cat:${p.category}` : "cardshop:all"),
        },
      )
      .catch(async () => {
        await ctx.reply(
          `${p.name}\nPrice: $${parseFloat(String(p.price)).toFixed(2)}\n${p.description || ""}`,
          {
            reply_markup: new InlineKeyboard()
              .text("🛒 Buy Now", `cardshop:buy:${p.id}`)
              .text("🛍️ Shop", "cardshop:main"),
          },
        );
      });
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

    const priceLimit = await getProductPriceLimit(ctx.from!.id);
    if (priceLimit === null || parseFloat(String(p.price)) > priceLimit) {
      await ctx.editMessageText("🔐 This product requires a higher access tier. Choose a paid plan to continue.", {
        reply_markup: subscriptionPlansKeyboard(),
      });
      return;
    }

    const cryptoBotEnabled = !!process.env.CRYPTOBOT_API_TOKEN;
    const coins = await getAvailableCoins();
    const kb = new InlineKeyboard();

    if (cryptoBotEnabled) {
      const assets: CryptoBotAsset[] = ["USDT", "TON", "BTC", "ETH", "LTC", "BNB", "TRX"];
      const assetEmojis: Record<string, string> = {
        USDT: "💚", TON: "💎", BTC: "🟠", ETH: "⬜", LTC: "🩶", BNB: "💛", TRX: "🔴",
      };
      for (const asset of assets) {
        kb.text(`${assetEmojis[asset] ?? "💰"} ${asset} via CryptoBot ⚡`, `cardshop:cbpay:${productId}:${asset}`).row();
      }
    }

    for (const coin of coins) {
      const info = COIN_INFO[coin];
      if (info) kb.text(`${info.emoji} ${coin} (manual)`, `cardshop:coinsel:${productId}:${coin}`).row();
    }

    if (!cryptoBotEnabled && coins.length === 0) {
      await ctx.editMessageText("⚠️ Payments not configured yet. Please try again later.", {
        reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main"),
      });
      return;
    }

    kb.text("❌ Cancel", "cardshop:main");

    await ctx.editMessageText(
      `🛒 *CHECKOUT*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `📦 ${p.name}\n💰 $${parseFloat(String(p.price)).toFixed(2)}\n\n` +
        `${cryptoBotEnabled ? "⚡ CryptoBot = instant auto-confirmation\n" : ""}` +
        `Select payment method:`,
      { parse_mode: "Markdown", reply_markup: kb },
    );
  });

  bot.callbackQuery(/^cardshop:cbpay:(\d+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("⏳ Creating invoice...");
    const productId = parseInt(ctx.match[1]!);
    const asset = ctx.match[2] as CryptoBotAsset;
    const userId = ctx.from!.id;

    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!p || !p.isActive) {
      await ctx.editMessageText("❌ Product no longer available.", {
        reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main"),
      });
      return;
    }

    const [order] = await db
      .insert(ordersTable)
      .values({ userId, productId, quantity: 1, status: "pending" })
      .returning();
    if (!order) {
      await ctx.editMessageText("❌ Failed to create order. Please try again.");
      return;
    }

    try {
      const invoice = await createCryptoBotInvoice({
        asset,
        amount: parseFloat(String(p.price)),
        orderId: order.id,
        productName: p.name,
        userId,
      });

      await db.insert(paymentRequestsTable).values({
        orderId: order.id,
        coin: asset,
        address: invoice.invoice_id.toString(),
        amount: invoice.amount,
        reference: `CB-${invoice.invoice_id}`,
        status: "pending",
      });

      const assetEmojis: Record<string, string> = {
        USDT: "💚", TON: "💎", BTC: "🟠", ETH: "⬜", LTC: "🩶", BNB: "💛", TRX: "🔴",
      };

      await ctx.editMessageText(
        `💳 *PAY WITH CRYPTOBOT*\n━━━━━━━━━━━━━━━━━━\n\n` +
          `📦 ${p.name}\n` +
          `🔖 Order: *#${order.id}*\n\n` +
          `${assetEmojis[asset] ?? "💰"} Amount: *${invoice.amount} ${asset}*\n\n` +
          `Tap the button below to pay securely via @CryptoBot:\n` +
          `_Payment is auto-confirmed — no manual steps needed._`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .url("💳 Pay Now via CryptoBot", invoice.bot_invoice_url)
            .row()
            .text("🔄 Check Payment", `cardshop:cbcheck:${order.id}:${invoice.invoice_id}`)
            .text("❌ Cancel", `cardshop:ordcancel:${order.id}`),
        },
      );

      const ownerId = parseInt(process.env.BOT_OWNER_ID ?? "0");
      if (ownerId) {
        await ctx.api
          .sendMessage(
            ownerId,
            `🛒 *NEW ORDER #${order.id}*\n━━━━━━━━━━━━━━━━━━\n\n` +
              `👤 \`${userId}\`\n📦 ${p.name}\n` +
              `${assetEmojis[asset] ?? "💰"} ${invoice.amount} ${asset} via CryptoBot\n\n` +
              `_Auto-confirms on payment._`,
            { parse_mode: "Markdown" },
          )
          .catch(() => {});
      }
    } catch (err) {
      logger.error({ err }, "CryptoBot invoice creation failed");
      await db.update(ordersTable).set({ status: "cancelled" }).where(eq(ordersTable.id, order.id));
      await ctx.editMessageText(
        `❌ *Payment Error*\n\n${err instanceof Error ? err.message : "Failed to create invoice"}`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main") },
      );
    }
  });

  bot.callbackQuery(/^cardshop:cbcheck:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery("🔄 Checking...");
    const orderId = parseInt(ctx.match[1]!);
    const invoiceId = parseInt(ctx.match[2]!);
    const { checkCryptoBotInvoice } = await import("./cryptobot");
    const invoice = await checkCryptoBotInvoice(invoiceId);
    if (!invoice) {
      await ctx.reply("❌ Could not check payment status. Try again.");
      return;
    }
    if (invoice.status === "paid") {
      const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
      if (order && order.status !== "confirmed") {
        await db.update(ordersTable).set({ status: "confirmed", updatedAt: new Date() }).where(eq(ordersTable.id, orderId));
        await db
          .update(paymentRequestsTable)
          .set({ status: "confirmed", confirmedAt: new Date() })
          .where(eq(paymentRequestsTable.orderId, orderId))
          .catch(() => {});
        const [product] = await db.select().from(productsTable).where(eq(productsTable.id, order.productId));
        let msg = `✅ *Payment Confirmed — Order #${orderId}*\n━━━━━━━━━━━━━━━━━━\n\n📦 ${product?.name ?? "Order"} confirmed!\n\n`;
        if (product?.deliveryType === "auto" && product.deliveryContent) {
          msg += `🎁 *Your delivery:*\n\n${product.deliveryContent}`;
        } else {
          msg += `⏳ Seller will deliver shortly.`;
        }
        await ctx.editMessageText(msg, { parse_mode: "Markdown" });
      } else {
        await ctx.reply("✅ Already confirmed.");
      }
    } else {
      await ctx.reply(`⏳ Payment status: *${invoice.status}*\n\nPay via CryptoBot then tap check again.`, {
        parse_mode: "Markdown",
      });
    }
  });

  bot.callbackQuery(/^cardshop:coinsel:(\d+):(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const productId = parseInt(ctx.match[1]!);
    const coin = ctx.match[2]!;
    const userId = ctx.from!.id;
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, productId));
    if (!p || !p.isActive) {
      await ctx.editMessageText("❌ Product no longer available.", {
        reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main"),
      });
      return;
    }
    const [order] = await db
      .insert(ordersTable)
      .values({ userId, productId, quantity: 1, status: "pending" })
      .returning();
    if (!order) {
      await ctx.editMessageText("❌ Failed to create order. Please try again.");
      return;
    }
    const payDetails = await generatePaymentDetails(coin, order.id, String(p.price));
    if (!payDetails) {
      await db.update(ordersTable).set({ status: "cancelled" }).where(eq(ordersTable.id, order.id));
      await ctx.editMessageText("⚠️ Payment address unavailable for this coin. Please choose another.", {
        reply_markup: new InlineKeyboard().text("🛒 Try Again", `cardshop:buy:${productId}`),
      });
      return;
    }
    await db.insert(paymentRequestsTable).values({
      orderId: order.id,
      coin,
      address: payDetails.address,
      amount: payDetails.amount,
      reference: `ORD-${order.id}`,
    });
    const coinInfo = COIN_INFO[coin]!;
    await ctx.editMessageText(
      `💳 *PAYMENT DETAILS*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `📦 ${p.name}\n` +
        `🔖 Order: *#${order.id}*\n\n` +
        `${coinInfo.emoji} Send exactly:\n` +
        `*${payDetails.amount} ${coin}*\n` +
        `🌐 Network: ${coinInfo.network}\n\n` +
        `📬 To address:\n\`${payDetails.address}\`\n\n` +
        `After sending, tap *"✅ I've Paid"*:`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✅ I've Paid", `cardshop:claimed:${order.id}`)
          .text("❌ Cancel", `cardshop:ordcancel:${order.id}`),
      },
    );
    const ownerId = getOwnerId();
    if (ownerId) {
      await ctx.api
        .sendMessage(
          ownerId,
          `🛒 *NEW ORDER #${order.id}*\n━━━━━━━━━━━━━━━━━━\n\n` +
            `👤 Customer: \`${userId}\`\n` +
            `📦 ${p.name} — $${parseFloat(String(p.price)).toFixed(2)}\n` +
            `${coinInfo.emoji} ${payDetails.amount} ${coin}\n\n` +
            `_Awaiting payment confirmation._`,
          {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard().text("📋 View Order", `hex:oview:${order.id}`),
          },
        )
        .catch(() => {});
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
      await ctx.answerCallbackQuery(`Order is already ${order.status}.`);
      return;
    }
    await db.update(ordersTable).set({ status: "claimed", updatedAt: new Date() }).where(eq(ordersTable.id, orderId));
    await db
      .update(paymentRequestsTable)
      .set({ status: "claimed", claimedAt: new Date() })
      .where(eq(paymentRequestsTable.orderId, orderId));
    await ctx.answerCallbackQuery("✅ Payment submitted for review!");
    await ctx.editMessageText(
      `🔔 *PAYMENT SUBMITTED — ORDER #${orderId}*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Your payment has been submitted for review.\n\n` +
        `⏳ The seller will confirm and deliver your order soon.\n\n` +
        `Use /myorders to check your order status.`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("📋 My Orders", "cardshop:myorders")
          .text("🛍️ Shop", "cardshop:main"),
      },
    );
    const ownerId = getOwnerId();
    if (ownerId) {
      const [pr] = await db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.orderId, orderId));
      await ctx.api
        .sendMessage(
          ownerId,
          `🔔 *PAYMENT CLAIMED — ORDER #${orderId}*\n━━━━━━━━━━━━━━━━━━\n\n` +
            `👤 Customer: \`${userId}\`\n` +
            (pr ? `💰 ${pr.amount} ${pr.coin}\n🏦 ${pr.address}` : "") +
            `\n\n_Verify and confirm in your Hex panel._`,
          {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard().text("✅ Confirm Order", `hex:oview:${orderId}`),
          },
        )
        .catch(() => {});
    }
  });

  bot.callbackQuery(/^cardshop:ordcancel:(\d+)$/, async (ctx) => {
    const orderId = parseInt(ctx.match[1]!);
    const userId = ctx.from!.id;
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    if (!order || order.userId !== userId) {
      await ctx.answerCallbackQuery("Not found.");
      return;
    }
    if (order.status !== "pending") {
      await ctx.answerCallbackQuery("Cannot cancel — already processed.");
      return;
    }
    await db.update(ordersTable).set({ status: "cancelled", updatedAt: new Date() }).where(eq(ordersTable.id, orderId));
    await db.update(paymentRequestsTable).set({ status: "cancelled" }).where(eq(paymentRequestsTable.orderId, orderId));
    await ctx.answerCallbackQuery("❌ Order cancelled");
    await ctx.editMessageText(`❌ Order #${orderId} cancelled.`, {
      reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main"),
    });
  });

  bot.callbackQuery("cardshop:myorders", async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from!.id;
    const orders = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.userId, userId))
      .orderBy(desc(ordersTable.createdAt))
      .limit(10);
    if (orders.length === 0) {
      await ctx.editMessageText(`📋 *MY ORDERS*\n━━━━━━━━━━━━━━━━━━\n\nYou haven't placed any orders yet.`, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🛍️ Shop", "cardshop:main"),
      });
      return;
    }
    const statusEmoji: Record<string, string> = {
      pending: "⏳",
      claimed: "🔔",
      confirmed: "✅",
      cancelled: "❌",
    };
    const kb = new InlineKeyboard();
    for (const o of orders) {
      const se = statusEmoji[o.status] ?? "❓";
      kb.text(`${se} #${o.id} — ${o.status.toUpperCase()}`, `cardshop:myorder:${o.id}`).row();
    }
    kb.text("🛍️ Shop", "cardshop:main");
    await ctx.editMessageText(`📋 *MY ORDERS*\n━━━━━━━━━━━━━━━━━━\n\n${orders.length} order(s):`, {
      parse_mode: "Markdown",
      reply_markup: kb,
    });
  });

  bot.callbackQuery(/^cardshop:myorder:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const orderId = parseInt(ctx.match[1]!);
    const userId = ctx.from!.id;
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    if (!order || order.userId !== userId) {
      await ctx.editMessageText("❌ Order not found.");
      return;
    }
    const [product] = await db.select().from(productsTable).where(eq(productsTable.id, order.productId));
    const [pr] = await db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.orderId, orderId));
    const statusEmoji: Record<string, string> = {
      pending: "⏳",
      claimed: "🔔",
      confirmed: "✅",
      cancelled: "❌",
    };
    const se = statusEmoji[order.status] ?? "❓";
    const text =
      `${se} *ORDER #${orderId}*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `📦 ${product?.name ?? "Unknown"}\n` +
      `💰 ${pr ? `${pr.amount} ${pr.coin}` : `$${parseFloat(String(product?.price ?? "0")).toFixed(2)}`}\n` +
      `📊 Status: *${order.status.toUpperCase()}*\n` +
      `📅 ${order.createdAt.toLocaleString()}`;
    const kb = new InlineKeyboard();
    if (order.status === "pending" && pr) {
      kb.text("💳 Payment Details", `cardshop:reshow:${orderId}`).row();
      kb.text("✅ I've Paid", `cardshop:claimed:${orderId}`).row();
    }
    kb.text("🔙 My Orders", "cardshop:myorders").text("🛍️ Shop", "cardshop:main");
    await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: kb });
  });

  bot.callbackQuery(/^cardshop:reshow:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const orderId = parseInt(ctx.match[1]!);
    const userId = ctx.from!.id;
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
    if (!order || order.userId !== userId) return;
    const [pr] = await db.select().from(paymentRequestsTable).where(eq(paymentRequestsTable.orderId, orderId));
    const [p] = await db.select().from(productsTable).where(eq(productsTable.id, order.productId));
    if (!pr) return;
    const coinInfo = COIN_INFO[pr.coin] ?? { emoji: "💰", network: pr.coin };
    await ctx.editMessageText(
      `💳 *PAYMENT DETAILS — ORDER #${orderId}*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `📦 ${p?.name ?? "Order"}\n\n` +
        `${coinInfo.emoji} Send exactly:\n*${pr.amount} ${pr.coin}*\n` +
        `🌐 Network: ${coinInfo.network}\n\n` +
        `📬 To address:\n\`${pr.address}\`\n\n` +
        `After sending, tap *"✅ I've Paid"*:`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✅ I've Paid", `cardshop:claimed:${orderId}`)
          .text("❌ Cancel", `cardshop:ordcancel:${orderId}`),
      },
    );
  });
}
