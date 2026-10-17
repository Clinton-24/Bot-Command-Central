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
    .text("🏦 Bank Logs", "cardshop:banklogs")
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
