import type { Context, SessionFlavor } from "grammy";
import type { Bot } from "grammy";

export interface MeetingDraft {
  title?: string;
  scheduledAt?: string;
  description?: string;
  chatId?: number;
  organizerName?: string;
}

export interface HexDraft {
  editId?: number;
  name?: string;
  price?: string;
  description?: string;
  category?: string;
  deliveryType?: "manual" | "auto";
  deliveryContent?: string;
}

export interface SessionData {
  pendingAction?: string;
  meetingDraft?: MeetingDraft;
  hexDraft?: HexDraft;
}

export type BotContext = Context & SessionFlavor<SessionData>;
export type MyBot = Bot<BotContext>;
