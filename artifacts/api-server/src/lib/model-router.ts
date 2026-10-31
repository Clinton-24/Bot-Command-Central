import { getModelConfig, getProviderApiKey, getTaskModels, getTaskRoute, type ProviderName, type TaskType } from "./model-config";
import { logger } from "./logger";

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface RoutedChatResponse {
  reply: string;
  model: string;
  provider: ProviderName;
  task: TaskType;
}

export interface RoutedEmbeddingResponse {
  embedding: number[];
  model: string;
}

export interface GeneratedImage {
  url?: string;
  b64?: string;
  model: string;
}

type OpenAiResponse = { choices?: Array<{ message?: { content?: string | null } }> };

function openRouterModelId(model: string): string {
  if (model.includes("/")) return model;
  if (
    model.startsWith("gpt-") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("dall-e") ||
    model.startsWith("text-embedding-")
  ) {
    return `openai/${model}`;
  }
  if (model.startsWith("claude-")) return `anthropic/${model}`;
  if (model.startsWith("gemini") || model.startsWith("gemma")) return `google/${model}`;
  return model;
}

function nativeModelId(model: string): string {
  const slash = model.indexOf("/");
  if (slash < 0) return model;
  return model.slice(slash + 1);
}

function isGoogleNativeModel(model: string): boolean {
  const bare = nativeModelId(model).replace(/:free$/i, "");
  if (model.includes(":free")) return false;
  if (model.startsWith("google/") && bare.startsWith("gemini")) {
    return bare.startsWith("gemini");
  }
  return bare.startsWith("gemini-") || bare.startsWith("gemini");
}

function providerForModel(model: string): ProviderName {
  const bare = nativeModelId(model);
  if (bare.startsWith("gpt-") || bare.startsWith("o1") || bare.startsWith("o3") || bare.startsWith("dall-e") || bare.startsWith("text-embedding-")) {
    return "openai";
  }
  if (bare.startsWith("claude-")) return "anthropic";
  if (isGoogleNativeModel(model)) return "google";
  return "openrouter";
}

function bareStartsGemini(model: string): boolean {
  return nativeModelId(model).replace(/:free$/i, "").startsWith("gemini");
}

function providersForModel(model: string): ProviderName[] {
  const direct = providerForModel(model);
  const hasDirect = Boolean(getProviderApiKey(direct));
  const hasOr = Boolean(getProviderApiKey("openrouter"));
  const hasGoogle = Boolean(getProviderApiKey("google"));

  if (direct === "google") {
    if (hasGoogle) return ["google"];
    if (hasOr) return ["openrouter"];
    return ["google"];
  }
  if (direct === "openrouter") return ["openrouter"];
  if (hasDirect && hasOr) return [direct, "openrouter"];
  if (hasDirect) return [direct];
  if (hasOr) return ["openrouter"];
  if (hasGoogle && bareStartsGemini(model)) return ["google"];
  return [direct, "openrouter"];
}

function normalizeContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value
      .filter((part): part is { text?: string } => typeof part === "object" && part !== null)
      .map((part) => part.text ?? "")
      .join("")
      .trim();
  }
  return "";
}

function backoffMs(attempt: number): number {
  const { retryBackoffBase } = getModelConfig().defaults;
  return Math.min(5000, Math.round(retryBackoffBase ** attempt * 250));
}

async function requestJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const timeoutMs = Math.min(getModelConfig().defaults.timeoutSeconds * 1000, 12_000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      const error =
        typeof body.error === "object" && body.error !== null
          ? (body.error as { message?: string }).message
          : typeof body.message === "string"
            ? body.message
            : typeof body.errors === "object"
              ? JSON.stringify(body.errors)
              : undefined;
      throw new Error(`${response.status} ${error ?? response.statusText}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function buildOpenAiMessages(messages: ChatMessage[]): Array<{ role: string; content: unknown }> {
  return messages.map((message) => ({ role: message.role, content: message.content }));
}

function googleModelId(model: string): string {
  let id = nativeModelId(model).replace(/:free$/i, "");
  if (id.includes("gemini-3.8-flash")) return "gemini-3.8-flash";
  if (id.includes("gemini-3.6-flash")) return "gemini-3.6-flash";
  if (id.includes("gemini-3.5-flash-lite")) return "gemini-3.5-flash-lite";
  if (id.includes("gemini-3.1-flash-lite")) return "gemini-3.1-flash-lite";
  if (id.includes("gemini-2.5-pro")) return "gemini-3.8-flash";
  if (id.includes("gemini-2.5-flash")) return "gemini-3.8-flash";
  if (id.includes("gemini-2.0-flash-lite")) return "gemini-3.5-flash-lite";
  if (id.includes("gemini-2.0-flash")) return "gemini-3.8-flash";
  if (id.includes("gemini-1.5-flash")) return "gemini-3.5-flash-lite";
  if (id.includes("gemini-1.5-pro")) return "gemini-3.8-flash";
  if (id.startsWith("gemini-")) return id;
  return "gemini-3.8-flash";
}

async function callGoogle(
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const providerConfig = getModelConfig().providers.google;
  const apiKey = getProviderApiKey("google");
  if (!apiKey) throw new Error("GEMINI_API_KEY is not configured");

  const resolvedModel = googleModelId(model);
  const systemParts: string[] = [];
  const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

  for (const message of messages) {
    if (message.role === "system") {
      systemParts.push(typeof message.content === "string" ? message.content : "");
      continue;
    }
    const role = message.role === "assistant" ? "model" : "user";
    const parts: Array<Record<string, unknown>> = [];
    if (typeof message.content === "string") {
      parts.push({ text: message.content });
    } else {
      for (const part of message.content) {
        if (part.type === "text") {
          parts.push({ text: part.text });
        } else {
          const url = part.image_url.url;
          const match = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/);
          if (match) {
            parts.push({
              inline_data: {
                mime_type: match[1],
                data: match[2],
              },
            });
          } else {
            parts.push({ text: `[Image URL: ${url}]` });
          }
        }
      }
    }
    if (parts.length) contents.push({ role, parts });
  }

  if (contents.length === 0) {
    contents.push({ role: "user", parts: [{ text: "Hello" }] });
  }

  const body: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: Math.min(maxTokens, 2048),
      temperature,
    },
  };
  if (systemParts.length) {
    body.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
  }

  const url = `${providerConfig.baseUrl}/models/${resolvedModel}:generateContent`;
  const result = await requestJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  const first = candidates[0] as { content?: { parts?: Array<{ text?: string }> } | undefined;
  const text = (first?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  if (!text) {
    const block = result.promptFeedback ?? result.error;
    throw new Error(`Google Gemini returned an empty response${block ? `: ${JSON.stringify(block)}` : ""}`);
  }
  return text;
}
