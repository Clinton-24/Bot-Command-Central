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
  // /buy → redirect to CardShop
  bot.command("buy", async (ctx) => {
    await ctx.reply(
      `🛍️ CARDSHOP\n━━━━━━━━━━━━━━━━━━\n\nBrowse and buy with crypto payments.`,
      {
        reply_markup: new InlineKeyboard()
          .text("🛍️ Open CardShop", "cardshop:main")
          .text("🏠 Main Menu", "menu:main"),
      },
    );
  });

  bot.command("myorders", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    await showUserOrders(ctx, userId);
  });

  bot.command("orders", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    await showUserOrders(ctx, userId);
  });

  bot.command("order", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    const productId = parseInt(ctx.match?.trim() ?? "", 10);
    if (!productId || isNaN(productId)) {
      await ctx.reply("Usage: /order <product_id>\nOr open CardShop with /shop");
      return;
    }
    await placeOrder(ctx as Parameters<typeof placeOrder>[0], userId, productId);
  });

  bot.command("cancelorder", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    await doCancelOrder(ctx as Parameters<typeof doCancelOrder>[0], userId);
  });
}

async function showUserOrders(
  ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
  userId: number,
): Promise<void> {
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
      pending: "⏳",
      claimed: "🔔",
      confirmed: "✅",
      cancelled: "❌",
      declined: "🚫",
    };

    const kb = new InlineKeyboard();
    const lines: string[] = [];
    for (const o of orders.slice(-10).reverse()) {
      const se = statusEmoji[o.status] ?? "❓";
      const date =
        o.createdAt instanceof Date ? o.createdAt.toLocaleDateString() : String(o.createdAt);
      lines.push(`${se} #${o.id} — ${o.status.toUpperCase()} · ${date}`);
      kb.text(`${se} #${o.id}`, `cardshop:myorder:${o.id}`).row();
    }
    kb.text("🛍️ Shop", "cardshop:main").text("🏠 Menu", "menu:main");

    await ctx.reply(`📋 MY ORDERS\n━━━━━━━━━━━━━━━━━━\n\n${lines.join("\n")}`, {
      reply_markup: kb,
    });
  } catch (err) {
    logger.error({ err }, "orders command error");
    await ctx.reply("❌ Failed to load orders.");
  }
}

async function placeOrder(
  ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
  userId: number,
  productId: number,
): Promise<void> {
  try {
    const [product] = await db
      .select()
      .from(productsTable)
      .where(and(eq(productsTable.id, productId), eq(productsTable.isActive, true)));

    if (!product) {
      await ctx.reply("❌ Product not found or unavailable.");
      return;
    }

    const [order] = await db
      .insert(ordersTable)
      .values({ userId, productId, quantity: 1, status: "pending" })
      .returning();

    await ctx.reply(
      `✅ ORDER PLACED\n━━━━━━━━━━━━━━━━━━\n\n` +
        `Order #${order!.id}\n` +
        `Product: ${product.name}\n` +
        `Price: $${product.price}\n` +
        `Status: Pending\n\n` +
        `Open CardShop for payment options.`,
      {
        reply_markup: new InlineKeyboard()
          .text("🛍️ CardShop", "cardshop:main")
          .text("🏠 Menu", "menu:main"),
      },
    );
  } catch (err) {
    logger.error({ err }, "placeOrder error");
    await ctx.reply("❌ Failed to place order.");
  }
}

async function doCancelOrder(
  ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
  userId: number,
): Promise<void> {
  try {
    const [order] = await db
      .select()
      .from(ordersTable)
      .where(and(eq(ordersTable.userId, userId), eq(ordersTable.status, "pending")))
      .orderBy(ordersTable.createdAt)
      .limit(1);

    if (!order) {
      await ctx.reply("❌ No active orders to cancel.");
      return;
    }

    await db
      .update(ordersTable)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(ordersTable.id, order.id));

    await ctx.reply(`✅ Order #${order.id} has been cancelled.`, {
      reply_markup: backToShopKb(),
    });
  } catch (err) {
    logger.error({ err }, "cancelOrder error");
    await ctx.reply("❌ Failed to cancel order.");
  }
}

export function registerShopCallbacks(bot: MyBot): void {
  bot.callbackQuery("shop:browse", async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const products = await db.select().from(productsTable).where(eq(productsTable.isActive, true));

      if (products.length === 0) {
        await ctx.editMessageText(`📦 PRODUCTS\n━━━━━━━━━━━━━━━━━━\n\nNo products available.`, {
          reply_markup: new InlineKeyboard().text("🔙 Back", "menu:shop"),
        });
        return;
      }

      const kb = new InlineKeyboard();
      const list = products.map((p, i) => {
        kb.text(`Buy: ${p.name} ($${p.price})`, `shop:buy:${p.id}`).row();
        return `${i + 1}. ${p.name} — $${p.price}`;
      });
      kb.text("🔙 Back", "menu:shop");

      await ctx.editMessageText(
        `📦 AVAILABLE PRODUCTS\n━━━━━━━━━━━━━━━━━━\n\n${list.join("\n")}`,
        { reply_markup: kb },
      );
    } catch (err) {
      logger.error({ err }, "shop:browse error");
      await ctx.reply("❌ Failed to load products.");
    }
  });

  bot.callbackQuery(/^shop:buy:(\d+)$/, async (ctx) => {
    const productId = parseInt(ctx.match![1]!, 10);
    await ctx.answerCallbackQuery();
    try {
      const [product] = await db
        .select()
        .from(productsTable)
        .where(and(eq(productsTable.id, productId), eq(productsTable.isActive, true)));

      if (!product) {
        await ctx.reply("❌ Product not found.");
        return;
      }

      await ctx.editMessageText(
        `🛒 CONFIRM ORDER\n━━━━━━━━━━━━━━━━━━\n\n` +
          `Product: ${product.name}\n` +
          `Price: $${product.price}\n\n` +
          `Prefer CardShop for crypto checkout.`,
        {
          reply_markup: new InlineKeyboard()
            .text("✅ Confirm", `shop:confirm:${productId}`)
            .text("🛍️ CardShop", "cardshop:main")
            .row()
            .text("❌ Cancel", "shop:browse"),
        },
      );
    } catch (err) {
      logger.error({ err }, "shop:buy callback error");
      await ctx.reply("❌ Error loading product.");
    }
  });

  bot.callbackQuery(/^shop:confirm:(\d+)$/, async (ctx) => {
    const productId = parseInt(ctx.match![1]!, 10);
    const userId = ctx.from!.id;
    await ctx.answerCallbackQuery("Order placed");
    try {
      const [product] = await db
        .select()
        .from(productsTable)
        .where(and(eq(productsTable.id, productId), eq(productsTable.isActive, true)));

      if (!product) {
        await ctx.reply("❌ Product no longer available.");
        return;
      }

      const [order] = await db
        .insert(ordersTable)
        .values({ userId, productId, quantity: 1, status: "pending" })
        .returning();

      await ctx.editMessageText(
        `🎉 ORDER PLACED\n━━━━━━━━━━━━━━━━━━\n\n` +
          `Order #${order!.id}\n` +
          `Product: ${product.name}\n` +
          `Price: $${product.price}\n` +
          `Status: Pending`,
        {
          reply_markup: new InlineKeyboard()
            .text("📋 My Orders", "shop:orders")
            .text("🛍️ CardShop", "cardshop:main")
            .row()
            .text("🏠 Main Menu", "menu:main"),
        },
      );
    } catch (err) {
      logger.error({ err }, "shop:confirm callback error");
      await ctx.reply("❌ Failed to place order.");
    }
  });

  bot.callbackQuery("shop:orders", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showUserOrders(ctx, ctx.from!.id);
  });

  bot.callbackQuery("shop:cancel", async (ctx) => {
    const userId = ctx.from!.id;
    await ctx.answerCallbackQuery();
    try {
      const [order] = await db
        .select()
        .from(ordersTable)
        .where(and(eq(ordersTable.userId, userId), eq(ordersTable.status, "pending")))
        .orderBy(ordersTable.createdAt)
        .limit(1);

      if (!order) {
        await ctx.editMessageText(`No active pending orders to cancel.`, {
          reply_markup: new InlineKeyboard().text("🔙 Shop", "menu:shop"),
        });
        return;
      }

      await db
        .update(ordersTable)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(eq(ordersTable.id, order.id));

      await ctx.editMessageText(`✅ Order #${order.id} cancelled.`, {
        reply_markup: new InlineKeyboard()
          .text("📋 My Orders", "shop:orders")
          .text("🏠 Menu", "menu:main"),
      });
    } catch (err) {
      logger.error({ err }, "shop:cancel callback error");
      await ctx.reply("❌ Failed to cancel order.");
    }
  });
}
