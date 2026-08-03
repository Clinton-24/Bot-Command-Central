/**
 * CRYPTOBOT PAYMENT INTEGRATION
 * ─────────────────────────────────────────────────────────────
 * Uses @CryptoBot (Telegram native) via Crypto Pay API
 * Docs: https://help.crypt.bot/crypto-pay-api
 *
 * Flow:
 * 1. User selects product → bot creates CryptoBot invoice
 * 2. User pays via @CryptoBot in Telegram
 * 3. CryptoBot sends webhook to POST /api/cryptobot/webhook
 * 4. Bot verifies signature → marks order confirmed → delivers
 *
 * Setup: Get API token from @CryptoBot → /pay → Create App
 */

import { createHmac } from "crypto";
import { Router } from "express";
import { eq } from "drizzle-orm";
import { db, ordersTable, productsTable, paymentRequestsTable } from "@workspace/db";
import type { MyBot } from "../index";
import { logger } from "../../lib/logger";

// ── Config ────────────────────────────────────────────────────────────────────

const CRYPTOBOT_TOKEN = process.env.CRYPTOBOT_API_TOKEN ?? "";
const CRYPTOBOT_API = process.env.CRYPTOBOT_TESTNET === "true"
  ? "https://testnet-pay.crypt.bot/api"
  : "https://pay.crypt.bot/api";

// Supported assets on CryptoBot
export const CRYPTOBOT_ASSETS = ["USDT", "TON", "BTC", "ETH", "LTC", "BNB", "TRX", "USDC"] as const;
export type CryptoBotAsset = typeof CRYPTOBOT_ASSETS[number];

// ── CryptoBot API client ──────────────────────────────────────────────────────

async function cryptoBotRequest<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!CRYPTOBOT_TOKEN) throw new Error("CRYPTOBOT_API_TOKEN not set on Render.");

  const res = await fetch(`${CRYPTOBOT_API}/${method}`, {
    method: "POST",
    headers: {
      "Crypto-Pay-API-Token": CRYPTOBOT_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });

  const data = await res.json() as { ok: boolean; result?: T; error?: { code: number; name: string } };

  if (!data.ok) {
    throw new Error(`CryptoBot API error: ${data.error?.name ?? "Unknown"} (${data.error?.code})`);
  }

  return data.result as T;
}

// ── Create invoice ────────────────────────────────────────────────────────────

interface CryptoBotInvoice {
  invoice_id: number;
  status: string;
  hash: string;
  asset: string;
  amount: string;
  pay_url: string;
  bot_invoice_url: string;
  mini_app_invoice_url: string;
  web_app_invoice_url: string;
  description?: string;
  payload?: string;
  paid_at?: string;
}

export async function createCryptoBotInvoice(params: {
  asset: CryptoBotAsset;
  amount: number;
  orderId: number;
  productName: string;
  userId: number;
}): Promise<CryptoBotInvoice> {
  const invoice = await cryptoBotRequest<CryptoBotInvoice>("createInvoice", {
    asset: params.asset,
    amount: params.amount.toFixed(2),
    description: `${params.productName} — Order #${params.orderId}`,
    payload: JSON.stringify({ orderId: params.orderId, userId: params.userId }),
    paid_btn_name: "callback",
    paid_btn_url: `https://t.me/${process.env.BOT_USERNAME ?? "your_bot"}?start=order_${params.orderId}`,
    allow_comments: false,
    allow_anonymous: false,
    expires_in: 3600, // 1 hour
  });

  return invoice;
}

// ── Check invoice status (polling fallback) ───────────────────────────────────

export async function checkCryptoBotInvoice(invoiceId: number): Promise<CryptoBotInvoice | null> {
  try {
    const result = await cryptoBotRequest<{ items: CryptoBotInvoice[] }>("getInvoices", {
      invoice_ids: [invoiceId],
    });
    return result.items[0] ?? null;
  } catch (err) {
    logger.error({ err }, "checkCryptoBotInvoice failed");
    return null;
  }
}

// ── Webhook signature verification ────────────────────────────────────────────

function verifyWebhookSignature(body: string, signature: string): boolean {
  if (!CRYPTOBOT_TOKEN) return false;
  const secret = createHmac("sha256", "WebAppData").update(CRYPTOBOT_TOKEN).digest();
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  return expected === signature;
}

// ── Deliver order (shared with hex confirm) ───────────────────────────────────

async function deliverOrder(bot: MyBot, orderId: number, userId: number): Promise<void> {
  const [order] = await db.select().from(ordersTable).where(eq(ordersTable.id, orderId));
  if (!order || order.status === "confirmed") return;

  await db.update(ordersTable)
    .set({ status: "confirmed", updatedAt: new Date() })
    .where(eq(ordersTable.id, orderId));

  await db.update(paymentRequestsTable)
    .set({ status: "confirmed", confirmedAt: new Date() })
    .where(eq(paymentRequestsTable.orderId, orderId))
    .catch(() => {});

  const [product] = await db.select().from(productsTable).where(eq(productsTable.id, order.productId));

  // Notify customer
  let deliveryMsg =
    `✅ *PAYMENT CONFIRMED — ORDER #${orderId}*\n━━━━━━━━━━━━━━━━━━\n\n` +
    `📦 ${product?.name ?? "Your order"} has been confirmed!\n\n`;

  if (product?.deliveryType === "auto" && product.deliveryContent) {
    deliveryMsg += `🎁 *Your delivery:*\n\n${product.deliveryContent}`;
  } else {
    deliveryMsg += `⏳ The seller will deliver your order shortly.`;
  }

  await bot.api.sendMessage(userId, deliveryMsg, { parse_mode: "Markdown" }).catch(() => {});

  // Notify owner
  const ownerId = parseInt(process.env.BOT_OWNER_ID ?? "0");
  if (ownerId) {
    await bot.api.sendMessage(
      ownerId,
      `✅ *AUTO-CONFIRMED — ORDER #${orderId}*\n━━━━━━━━━━━━━━━━━━\n\n` +
      `📦 ${product?.name ?? "Product"}\n` +
      `👤 Customer: \`${userId}\`\n` +
      `🤖 Paid via CryptoBot — auto-delivered.`,
      { parse_mode: "Markdown" }
    ).catch(() => {});
  }

  logger.info({ orderId, userId }, "Order auto-confirmed and delivered");
}

// ── Webhook route (registered on Express app) ─────────────────────────────────

export function createCryptoBotRouter(bot: MyBot): Router {
  const router = Router();

  router.post("/cryptobot/webhook", async (req, res) => {
    try {
      const signature = req.headers["crypto-pay-api-signature"] as string;
      const rawBody = JSON.stringify(req.body);

      if (!verifyWebhookSignature(rawBody, signature)) {
        logger.warn("CryptoBot webhook: invalid signature");
        return res.status(401).json({ ok: false });
      }

      const update = req.body as {
        update_type: string;
        update_id: number;
        payload?: CryptoBotInvoice;
      };

      if (update.update_type !== "invoice_paid" || !update.payload) {
        return res.json({ ok: true }); // ignore other events
      }

      const invoice = update.payload;
      logger.info({ invoice_id: invoice.invoice_id, asset: invoice.asset, amount: invoice.amount }, "CryptoBot payment received");

      // Parse order info from payload
      let orderId: number | null = null;
      let userId: number | null = null;

      try {
        const parsed = JSON.parse(invoice.payload ?? "{}") as { orderId?: number; userId?: number };
        orderId = parsed.orderId ?? null;
        userId = parsed.userId ?? null;
      } catch {
        logger.warn({ payload: invoice.payload }, "Could not parse invoice payload");
      }

      if (!orderId || !userId) {
        return res.status(400).json({ ok: false, error: "Missing orderId/userId in payload" });
      }

      await deliverOrder(bot, orderId, userId);
      return res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "CryptoBot webhook error");
      return res.status(500).json({ ok: false });
    }
  });

  // Manual check endpoint — poll CryptoBot for a specific invoice
  router.get("/cryptobot/check/:invoiceId", async (req, res) => {
    const invoiceId = parseInt(req.params["invoiceId"] ?? "");
    if (isNaN(invoiceId)) return res.status(400).json({ ok: false });

    const invoice = await checkCryptoBotInvoice(invoiceId);
    if (!invoice) return res.status(404).json({ ok: false });

    return res.json({ ok: true, invoice });
  });

  return router;
}

// ── Get app info (to verify token works) ─────────────────────────────────────

export async function getCryptoBotAppInfo(): Promise<{ name: string; payment_processing_bot_username: string } | null> {
  try {
    return await cryptoBotRequest("getMe");
  } catch {
    return null;
  }
}
