/**
 * Per-user Gmail reader via OAuth refresh tokens.
 *
 * Env (shared app credentials):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *   RENDER_EXTERNAL_URL (for OAuth redirect)
 *   GMAIL_REFRESH_TOKEN (optional legacy owner fallback)
 */

import { createHmac, timingSafeEqual } from "crypto";
import { pool } from "@workspace/db";
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

export interface UserGmailConnection {
  userId: number;
  email: string | null;
  connectedAt: Date;
}

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

function oauthClientConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function isGmailOAuthAppConfigured(): boolean {
  return oauthClientConfigured();
}

/** @deprecated use hasUserGmail / isGmailOAuthAppConfigured */
export function isGmailConfigured(): boolean {
  return oauthClientConfigured() && Boolean(process.env.GMAIL_REFRESH_TOKEN);
}

function redirectUri(): string {
  const base = (process.env.RENDER_EXTERNAL_URL ?? "").replace(/\/$/, "");
  if (!base) throw new Error("RENDER_EXTERNAL_URL is required for Gmail OAuth");
  return `${base}/oauth/google/callback`;
}

function signState(userId: number): string {
  const exp = Date.now() + 15 * 60 * 1000;
  const payload = `${userId}.${exp}`;
  const secret = process.env.GOOGLE_CLIENT_SECRET ?? "state";
  const sig = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 24);
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

export function verifyOAuthState(state: string): number | null {
  try {
    const raw = Buffer.from(state, "base64url").toString("utf8");
    const [userIdStr, expStr, sig] = raw.split(".");
    if (!userIdStr || !expStr || !sig) return null;
    const exp = Number(expStr);
    if (!Number.isFinite(exp) || Date.now() > exp) return null;
    const payload = `${userIdStr}.${expStr}`;
    const secret = process.env.GOOGLE_CLIENT_SECRET ?? "state";
    const expected = createHmac("sha256", secret).update(payload).digest("hex").slice(0, 24);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const userId = Number(userIdStr);
    return Number.isFinite(userId) ? userId : null;
  } catch {
    return null;
  }
}

export function buildGmailAuthUrl(userId: number): string {
  if (!oauthClientConfigured()) {
    throw new Error("Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.");
  }
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID!);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GMAIL_SCOPE);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", signState(userId));
  return url.toString();
}

export async function getUserGmail(userId: number): Promise<UserGmailConnection | null> {
  const result = await pool.query(
    `SELECT user_id, email, connected_at FROM user_gmail_tokens WHERE user_id = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    userId: Number(row.user_id),
    email: row.email ?? null,
    connectedAt: row.connected_at,
  };
}

export async function hasUserGmail(userId: number): Promise<boolean> {
  if (await getUserGmail(userId)) return true;
  // Legacy owner env token
  if (String(userId) === process.env.BOT_OWNER_ID && process.env.GMAIL_REFRESH_TOKEN) {
    return oauthClientConfigured();
  }
  return false;
}

async function getRefreshTokenForUser(userId: number): Promise<string | null> {
  const result = await pool.query(
    `SELECT refresh_token FROM user_gmail_tokens WHERE user_id = $1`,
    [userId],
  );
  if (result.rows[0]?.refresh_token) return result.rows[0].refresh_token as string;
  if (String(userId) === process.env.BOT_OWNER_ID && process.env.GMAIL_REFRESH_TOKEN) {
    return process.env.GMAIL_REFRESH_TOKEN;
  }
  return null;
}

async function getAccessToken(refreshToken: string): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = (await res.json()) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description ?? body.error ?? `Gmail token refresh failed (${res.status})`);
  }
  return body.access_token;
}

export async function exchangeCodeAndSave(userId: number, code: string): Promise<{ email: string | null }> {
  if (!oauthClientConfigured()) throw new Error("Google OAuth not configured");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: redirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const body = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description ?? body.error ?? "Token exchange failed");
  }
  if (!body.refresh_token) {
    throw new Error(
      "No refresh_token returned. Revoke app access at https://myaccount.google.com/permissions and try again with prompt=consent.",
    );
  }

  let email: string | null = null;
  try {
    const profileRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${body.access_token}` },
    });
    const profile = (await profileRes.json()) as { emailAddress?: string };
    email = profile.emailAddress ?? null;
  } catch (err) {
    logger.warn({ err }, "Could not fetch Gmail profile email");
  }

  await pool.query(
    `INSERT INTO user_gmail_tokens (user_id, refresh_token, email, connected_at, updated_at)
     VALUES ($1, $2, $3, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       refresh_token = EXCLUDED.refresh_token,
       email = COALESCE(EXCLUDED.email, user_gmail_tokens.email),
       updated_at = NOW()`,
    [userId, body.refresh_token, email],
  );

  return { email };
}

export async function disconnectUserGmail(userId: number): Promise<boolean> {
  const result = await pool.query(`DELETE FROM user_gmail_tokens WHERE user_id = $1`, [userId]);
  return (result.rowCount ?? 0) > 0;
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

/** Fetch recent inbox for a specific user (their connected Gmail). */
export async function fetchRecentEmailsForUser(
  userId: number,
  options?: { maxResults?: number; query?: string },
): Promise<GmailMessage[]> {
  if (!oauthClientConfigured()) {
    throw new Error("Google OAuth not configured on the server (GOOGLE_CLIENT_ID / SECRET).");
  }
  const refresh = await getRefreshTokenForUser(userId);
  if (!refresh) {
    throw new Error("Gmail not connected. Use /connect_gmail to link your inbox.");
  }

  const token = await getAccessToken(refresh);
  const maxResults = options?.maxResults ?? 25;
  const q = options?.query ?? "in:inbox newer_than:2d -category:promotions -category:social";

  const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
  listUrl.searchParams.set("q", q);
  listUrl.searchParams.set("maxResults", String(maxResults));

  const listRes = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
  const listBody = (await listRes.json()) as {
    messages?: Array<{ id: string; threadId: string }>;
    error?: { message?: string };
  };
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
      const msg = (await msgRes.json()) as any;
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

/** Legacy helper — owner env token only. Prefer fetchRecentEmailsForUser. */
export async function fetchRecentEmails(options?: {
  maxResults?: number;
  query?: string;
}): Promise<GmailMessage[]> {
  const ownerId = parseInt(process.env.BOT_OWNER_ID ?? "0", 10);
  if (!ownerId) throw new Error("BOT_OWNER_ID not set");
  return fetchRecentEmailsForUser(ownerId, options);
}

export function formatEmailsForPrompt(emails: GmailMessage[]): string {
  if (emails.length === 0) return "No recent inbox messages.";
  return emails
    .map(
      (e, i) =>
        `${i + 1}. From: ${e.from}\n   Subject: ${e.subject}\n   Date: ${e.date}\n   Preview: ${e.bodyPreview || e.snippet}`,
    )
    .join("\n\n");
}
