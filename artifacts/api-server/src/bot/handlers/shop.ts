import { InlineKeyboard } from "grammy";
import type { MyBot } from "../index";
import { db } from "@workspace/db";
import { productsTable, ordersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { shopMenuKeyboard } from "./menu";
import { logger } from "../../lib/logger";

const backToShopKb = () =>
  new InlineKeyboard().text("🔙 Back to Shop", "menu:shop").text("🏠 Main Menu", "menu:main");

export function registerShopHandlers(bot: MyBot): void {
  // /buy → redirect to the new CardShop
  bot.command("buy", async (ctx) => {
    await ctx.reply(
      `🛍️ *CARDSHOP*\n━━━━━━━━━━━━━━━━━━\n\nUse the new CardShop to browse and buy with crypto payments.`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("🛍️ Open CardShop", "cardshop:main")
          .text("🏠 Main Menu", "menu:main"),
      }
    );
  });

  // /myorders → shortcut for customers
  bot.command("myorders", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    try {
      const orders = await db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.userId, userId))
        .orderBy(ordersTable.createdAt);

      if (orders.length === 0) {
        await ctx.reply("📋 You have no orders yet.", {
          reply_markup: new InlineKeyboard()
            .text("🛍️ Browse CardShop", "cardshop:main")
            .text("🏠 Main Menu", "menu:main"),
        });
        return;
      }

      const statusEmoji: Record<string, string> = {
        pending: "⏳", claimed: "🔔", confirmed: "✅", cancelled: "❌",
      };

      const kb = new InlineKeyboard();
      const lines: string[] = [];
      for (const o of orders.slice(-10)) {
        const se = statusEmoji[o.status] ?? "❓";
        lines.push(`${se} *#${o.id}* — ${o.status.toUpperCase()} · ${o.createdAt.toLocaleDateString()}`);
        kb.text(`${se} #${o.id}`, `cardshop:myorder:${o.id}`).row();
      }
      kb.text("🛍️ Shop", "cardshop:main");

      await ctx.reply(
        `📋 *MY ORDERS*\n━━━━━━━━━━━━━━━━━━\n\n${lines.join("\n")}`,
        { parse_mode: "Markdown", reply_markup: kb }
      );
    } catch (err) {
      logger.error({ err }, "myorders command error");
      await ctx.reply("❌ Failed to load orders.");
    }
  });

  bot.command("order", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const productId = parseInt(ctx.match?.trim() ?? "", 10);
    if (!productId || isNaN(productId)) { await ctx.reply("Usage: /order <product_id>"); return; }
    await placeOrder(ctx as Parameters<typeof placeOrder>[0], userId, productId);
  });

  bot.command("cancelorder", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    await doCancelOrder(ctx as Parameters<typeof doCancelOrder>[0], userId);
  });

  bot.command("orders", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    await showOrders(ctx as Parameters<typeof showOrders>[0], userId);
  });
}

async function placeOrder(
  ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
  userId: number,
  productId: number
): Promise<void> {
  try {
    const [product] = await db
      .select()
      .from(productsTable)
      .where(and(eq(productsTable.id, productId), eq(productsTable.isActive, true)));

    if (!product) { await ctx.reply("❌ Product not found or unavailable."); return; }

    const [order] = await db
      .insert(ordersTable)
      .values({ userId, productId, quantity: 1, status: "pending" })
      .returning();

    await ctx.reply(
      `✅ *ORDER PLACED!*\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Order #${order.id}\n` +
        `Product: ${product.name}\n` +
        `Price: $${product.price}\n` +
        `Status: ⏳ Pending\n\n` +
        `An admin will contact you shortly.`,
      { parse_mode: "Markdown", reply_markup: backToShopKb() }
    );
  } catch (err) {
    logger.error({ err }, "placeOrder error");
    await ctx.reply("❌ Failed to place order.");
  }
}

async function doCancelOrder(
  ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
  userId: number
): Promise<void> {
  try {
    const [order] = await db
      .select()
      .from(ordersTable)
      .where(and(eq(ordersTable.userId, userId), eq(ordersTable.status, "pending")))
      .orderBy(ordersTable.createdAt)
      .limit(1);

    if (!order) { await ctx.reply("❌ No active orders to cancel."); return; }

    await db
      .update(ordersTable)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(ordersTable.id, order.id));

    await ctx.reply(
      `✅ Order #${order.id} has been cancelled.`,
      { reply_markup: backToShopKb() }
    );
  } catch (err) {
    logger.error({ err }, "cancelOrder error");
    await ctx.reply("❌ Failed to cancel order.");
  }
}

async function showOrders(
  ctx: { from?: { id: number }; reply: (text: string, opts?: object) => Promise<unknown> },
  userId: number
): Promise<void> {
  try {
    const orders = await db
      .select()
      .from(ordersTable)
      .where(eq(ordersTable.userId, userId))
      .orderBy(ordersTable.createdAt);

    if (orders.length === 0) {
      await ctx.reply("📦 You have no orders yet.", { reply_markup: backToShopKb() });
      return;
    }

    const statusEmoji: Record<string, string> = {
      pending: "⏳",
      confirmed: "✅",
      cancelled: "❌",
      completed: "🎉",
    };

    const list = orders
      .map((o) => {
        const e = statusEmoji[o.status] ?? "•";
        return `${e} *#${o.id}* — Product ${o.productId} — ${o.status.toUpperCase()}\n   📅 ${o.createdAt.toLocaleDateString()}`;
      })
      .join("\n\n");

    await ctx.reply(
      `📦 *ORDER HISTORY*\n━━━━━━━━━━━━━━━━━━\n\n${list}`,
      { parse_mode: "Markdown", reply_markup: backToShopKb() }
    );
  } catch (err) {
    logger.error({ err }, "showOrders error");
    await ctx.reply("❌ Failed to fetch orders.");
  }
}

export function registerShopCallbacks(bot: MyBot): void {
  bot.callbackQuery("shop:browse", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const products = await db
        .select()
        .from(productsTable)
        .where(eq(productsTable.isActive, true));

      if (products.length === 0) {
        await ctx.editMessageText(
          `📦 *PRODUCTS*\n━━━━━━━━━━━━━━━━━━\n\n🚫 No products available right now.`,
          { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🔙 Back to Shop", "menu:shop") }
        );
        return;
      }

      const kb = new InlineKeyboard();
      const list = products.map((p, i) => {
        kb.text(`🛒 Buy: ${p.name} ($${p.price})`, `shop:buy:${p.id}`).row();
        return `${i + 1}️⃣ *${p.name}* — $${p.price}\n${p.description ? `   ${p.description}` : ""}`;
      });
      kb.text("🔙 Back to Shop", "menu:shop");

      await ctx.editMessageText(
        `📦 *AVAILABLE PRODUCTS*\n━━━━━━━━━━━━━━━━━━\n\n${list.join("\n\n")}`,
        { parse_mode: "Markdown", reply_markup: kb }
      );
    } catch (err) {
      logger.error({ err }, "shop:browse error");
      await ctx.reply("❌ Failed to load products.");
    }
  });

  bot.callbackQuery(/^shop:buy:(\d+)$/, async (ctx) => {
    const productId = parseInt(ctx.match[1]);
    await ctx.answerCallbackQuery();
    try {
      const [product] = await db
        .select()
        .from(productsTable)
        .where(and(eq(productsTable.id, productId), eq(productsTable.isActive, true)));

      if (!product) {
        await ctx.reply("❌ Product not found."); return;
      }

      await ctx.editMessageText(
        `🛒 *CONFIRM ORDER*\n━━━━━━━━━━━━━━━━━━\n\n` +
          `Product: *${product.name}*\n` +
          `Price: *$${product.price}*\n` +
          `${product.description ? `\n${product.description}\n` : ""}\n` +
          `Confirm your purchase?`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("✅ Confirm", `shop:confirm:${productId}`)
            .text("❌ Cancel", "shop:browse"),
        }
      );
    } catch (err) {
      logger.error({ err }, "shop:buy callback error");
      await ctx.reply("❌ Error loading product.");
    }
  });

  bot.callbackQuery(/^shop:confirm:(\d+)$/, async (ctx) => {
    const productId = parseInt(ctx.match[1]);
    const userId = ctx.from.id;
    await ctx.answerCallbackQuery("✅ Order placed!");
    try {
      const [product] = await db
        .select()
        .from(productsTable)
        .where(and(eq(productsTable.id, productId), eq(productsTable.isActive, true)));

      if (!product) { await ctx.reply("❌ Product no longer available."); return; }

      const [order] = await db
        .insert(ordersTable)
        .values({ userId, productId, quantity: 1, status: "pending" })
        .returning();

      await ctx.editMessageText(
        `🎉 *ORDER PLACED!*\n━━━━━━━━━━━━━━━━━━\n\n` +
          `Order: *#${order.id}*\n` +
          `Product: ${product.name}\n` +
          `Price: $${product.price}\n` +
          `Status: ⏳ Pending\n\n` +
          `An admin will contact you shortly.`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("📋 My Orders", "shop:orders")
            .text("🛒 Shop More", "shop:browse")
            .row()
            .text("🏠 Main Menu", "menu:main"),
        }
      );
    } catch (err) {
      logger.error({ err }, "shop:confirm callback error");
      await ctx.reply("❌ Failed to place order.");
    }
  });

  bot.callbackQuery("shop:orders", async (ctx) => {
    const userId = ctx.from.id;
    await ctx.answerCallbackQuery();
    try {
      const orders = await db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.userId, userId))
        .orderBy(ordersTable.createdAt);

      if (orders.length === 0) {
        await ctx.editMessageText(
          `📦 *MY ORDERS*\n━━━━━━━━━━━━━━━━━━\n\n🚫 No orders yet.`,
          { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🛒 Shop Now", "shop:browse").text("🔙 Shop Menu", "menu:shop") }
        );
        return;
      }

      const statusEmoji: Record<string, string> = {
        pending: "⏳", confirmed: "✅", cancelled: "❌", completed: "🎉",
      };

      const list = orders
        .map((o) => {
          const e = statusEmoji[o.status] ?? "•";
          return `${e} *#${o.id}* — Product ${o.productId}\n   Status: ${o.status.toUpperCase()} · ${o.createdAt.toLocaleDateString()}`;
        })
        .join("\n\n");

      await ctx.editMessageText(
        `📦 *MY ORDERS*\n━━━━━━━━━━━━━━━━━━\n\n${list}`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("🛒 Shop More", "shop:browse")
            .text("🔙 Shop Menu", "menu:shop"),
        }
      );
    } catch (err) {
      logger.error({ err }, "shop:orders callback error");
      await ctx.reply("❌ Failed to fetch orders.");
    }
  });

  bot.callbackQuery("shop:cancel", async (ctx) => {
    const userId = ctx.from.id;
    await ctx.answerCallbackQuery();
    try {
      const [order] = await db
        .select()
        .from(ordersTable)
        .where(and(eq(ordersTable.userId, userId), eq(ordersTable.status, "pending")))
        .orderBy(ordersTable.createdAt)
        .limit(1);

      if (!order) {
        await ctx.editMessageText(
          `❌ You have no active pending orders to cancel.`,
          { reply_markup: new InlineKeyboard().text("🔙 Shop Menu", "menu:shop") }
        );
        return;
      }

      await db
        .update(ordersTable)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(ordersTable.id, order.id));

      await ctx.editMessageText(
        `✅ *ORDER CANCELLED*\n━━━━━━━━━━━━━━━━━━\n\nOrder #${order.id} has been cancelled.`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("📋 My Orders", "shop:orders")
            .text("🏠 Main Menu", "menu:main"),
        }
      );
    } catch (err) {
      logger.error({ err }, "shop:cancel callback error");
      await ctx.reply("❌ Failed to cancel order.");
    }
  });
}
