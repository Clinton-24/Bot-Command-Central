/**
 * Gmail reader — OAuth refresh token OR skipped if not configured.
 * Uses Gmail REST API (no extra npm deps beyond fetch).
 *
 * Env:
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   GMAIL_REFRESH_TOKEN
 *   GMAIL_USER (optional, for display)
 */

import { logger } from "./logger";

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  labelIds: string[];
  bodyPreview: string;
}

function configured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GMAIL_REFRESH_TOKEN,
  );
}

export function isGmailConfigured(): boolean {
  return configured();
}

async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: process.env.GMAIL_REFRESH_TOKEN!,
      grant_type: "refresh_token",
    }),
  });
  const body = await res.json() as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description ?? body.error ?? `Gmail token refresh failed (${res.status})`);
  }
  return body.access_token;
}

function headerValue(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
  const h = headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function decodeBody(payload: any): string {
  if (!payload) return "";
  if (payload.body?.data) {
    try {
      return Buffer.from(payload.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    } catch {
      return "";
    }
  }
  if (Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain") {
        const t = decodeBody(part);
        if (t) return t;
      }
    }
    for (const part of payload.parts) {
      const t = decodeBody(part);
      if (t) return t;
    }
  }
  return "";
}

/** Fetch recent inbox messages (default: last 2 days, max 25). */
export async function fetchRecentEmails(options?: {
  maxResults?: number;
  query?: string;
}): Promise<GmailMessage[]> {
  if (!configured()) {
    throw new Error(
      "Gmail not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN on Render.",
    );
  }

  const token = await getAccessToken();
  const maxResults = options?.maxResults ?? 25;
  const q = options?.query ?? "in:inbox newer_than:2d -category:promotions -category:social";

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", q);
  listUrl.searchParams.set("maxResults", String(maxResults));

  const listRes = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listBody = await listRes.json() as { messages?: Array<{ id: string; threadId: string }>; error?: { message?: string } };
  if (!listRes.ok) {
    throw new Error(listBody.error?.message ?? `Gmail list failed (${listRes.status})`);
  }

  const messages: GmailMessage[] = [];
  for (const m of listBody.messages ?? []) {
    try {
      const msgRes = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const msg = await msgRes.json() as any;
      if (!msgRes.ok) continue;
      const headers = msg.payload?.headers as Array<{ name: string; value: string }> | undefined;
      const body = decodeBody(msg.payload).replace(/\s+/g, " ").trim().slice(0, 800);
      messages.push({
        id: msg.id,
        threadId: msg.threadId,
        from: headerValue(headers, "From"),
        subject: headerValue(headers, "Subject") || "(no subject)",
        snippet: msg.snippet ?? "",
        date: headerValue(headers, "Date"),
        labelIds: msg.labelIds ?? [],
        bodyPreview: body || (msg.snippet ?? ""),
      });
    } catch (err) {
      logger.warn({ err, id: m.id }, "Failed to fetch Gmail message");
    }
  }
  return messages;
}

/** Build a compact text block for AI / briefing. */
export function formatEmailsForPrompt(emails: GmailMessage[]): string {
  if (emails.length === 0) return "No recent inbox messages.";
  return emails
    .map(
      (e, i) =>
        `${i + 1}. From: ${e.from}\n   Subject: ${e.subject}\n   Date: ${e.date}\n   Preview: ${e.bodyPreview || e.snippet}`,
    )
    .join("\n\n");
}
