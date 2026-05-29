import type { Context, SessionFlavor } from "grammy";

export interface SessionData {
  pendingAction?: string;
}

export type BotContext = Context & SessionFlavor<SessionData>;
