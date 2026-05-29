import type { Context, SessionFlavor } from "grammy";
import type { Bot } from "grammy";

export interface MeetingDraft {
  title?: string;
  scheduledAt?: string;
  description?: string;
}

export interface SessionData {
  pendingAction?: string;
  meetingDraft?: MeetingDraft;
}

export type BotContext = Context & SessionFlavor<SessionData>;
export type MyBot = Bot<BotContext>;
