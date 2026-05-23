import type { Bot } from "grammy";
import { db } from "@workspace/db";
import { productsTable, ordersTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../../lib/logger";

export function registerShopHandlers(bot: Bot) {
  bot.command("buy", async (ctx) => {
    try {
      const products = await db
        .select()
        .from(productsTable)
        .where(eq(productsTable.isActive, true));

      if (products.length === 0) {
        await ctx.reply("🛒 No products available right now.");
        return;
      }

      const list = products
        .map((p) => `*${p.id}.* ${p.name} — $${p.price}\n${p.description ?? ""}`)
        .join("\n\n");

      await ctx.reply(
        `🛒 *Available Products*\n\n${list}\n\nReply with: /order <ID> to purchase`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      logger.error({ err }, "buy command error");
      await ctx.reply("❌ Failed to load products.");
    }
  });

  bot.command("order", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const args = ctx.match?.trim();
    const productId = parseInt(args ?? "", 10);

    if (!productId || isNaN(productId)) {
      await ctx.reply("Usage: /order <product_id>");
      return;
    }

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
        `✅ *Order placed!*\n\nOrder #${order.id}\nProduct: ${product.name}\nPrice: $${product.price}\nStatus: Pending\n\nAn admin will contact you shortly.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      logger.error({ err }, "order command error");
      await ctx.reply("❌ Failed to place order.");
    }
  });

  bot.command("cancelorder", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

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

      await ctx.reply(`✅ Order #${order.id} has been cancelled.`);
    } catch (err) {
      logger.error({ err }, "cancelorder command error");
      await ctx.reply("❌ Failed to cancel order.");
    }
  });

  bot.command("orders", async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    try {
      const orders = await db
        .select()
        .from(ordersTable)
        .where(eq(ordersTable.userId, userId))
        .orderBy(ordersTable.createdAt);

      if (orders.length === 0) {
        await ctx.reply("📦 You have no orders yet.");
        return;
      }

      const list = orders
        .map(
          (o) =>
            `#${o.id} — Product ${o.productId} | Status: *${o.status}* | ${o.createdAt.toLocaleDateString()}`
        )
        .join("\n");

      await ctx.reply(`📦 *Your Orders*\n\n${list}`, { parse_mode: "Markdown" });
    } catch (err) {
      logger.error({ err }, "orders command error");
      await ctx.reply("❌ Failed to fetch orders.");
    }
  });
}
