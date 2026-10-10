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

function providerForModel(model: string): ProviderName {
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("text-embedding-") || model.startsWith("dall-e")) {
    return "openai";
  }
  if (model.startsWith("claude-")) return "anthropic";
  return "openrouter";
}

function providersForModel(model: string): ProviderName[] {
  const direct = providerForModel(model);
  return direct === "openrouter" ? ["openrouter"] : [direct, "openrouter"];
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
  const timeoutMs = getModelConfig().defaults.timeoutSeconds * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const raw = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      const error = typeof body.error === "object" && body.error !== null
        ? (body.error as { message?: string }).message
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

async function callProvider(
  provider: ProviderName,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const config = getModelConfig();
  const providerConfig = config.providers[provider];
  const apiKey = getProviderApiKey(provider);
  if (!apiKey) throw new Error(`${providerConfig.apiKeyEnv} is not configured`);

  if (provider === "anthropic") {
    const system = messages
      .filter((message) => message.role === "system")
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n\n");
    const input = messages
      .filter((message) => message.role !== "system")
      .map((message) => {
        if (typeof message.content === "string") {
          return { role: message.role, content: message.content };
        }
        const parts = message.content.map((part) => {
          if (part.type === "text") return { type: "text", text: part.text };
          const url = part.image_url.url;
          if (url.startsWith("data:")) {
            const match = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
            if (match) {
              return {
                type: "image",
                source: { type: "base64", media_type: match[1], data: match[2] },
              };
            }
          }
          return { type: "image", source: { type: "url", url } };
        });
        return { role: message.role, content: parts };
      });
    const body = await requestJson(`${providerConfig.baseUrl}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature,
        system: system || undefined,
        messages: input,
      }),
    });
    const content = normalizeContent(body.content);
    if (!content) throw new Error("Anthropic returned an empty response");
    return content;
  }

  const body = await requestJson(`${providerConfig.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(provider === "openrouter" ? {
        "HTTP-Referer": process.env.RENDER_EXTERNAL_URL ?? "https://bot-command-central-1.onrender.com",
        "X-Title": "Crescent-AI",
      } : {}),
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: buildOpenAiMessages(messages),
    }),
  });
  const choices = Array.isArray(body.choices) ? body.choices as OpenAiResponse["choices"] : [];
  const content = normalizeContent(choices?.[0]?.message?.content);
  if (!content) throw new Error(`${provider} returned an empty response`);
  return content;
}

export async function routeChat(task: TaskType, messages: ChatMessage[]): Promise<RoutedChatResponse> {
  const route = getTaskRoute(task);
  const candidates = getTaskModels(task);
  let lastError = "No provider is configured";

  for (const model of candidates) {
    for (const provider of providersForModel(model)) {
      const providerConfig = getModelConfig().providers[provider];
      const supported = providerConfig.models.includes("*") || providerConfig.models.includes(model);
      if (!supported && provider !== "openrouter") continue;
      if (!getProviderApiKey(provider)) {
        lastError = `${providerConfig.apiKeyEnv} is not configured`;
        continue;
      }
      for (let attempt = 0; attempt <= getModelConfig().defaults.maxRetries; attempt++) {
        try {
          const reply = await callProvider(provider, model, messages, route.params.maxTokens, route.params.temperature);
          logger.info({ task, model, provider }, "AI model responded");
          return { reply, model, provider, task };
        } catch (err) {
          lastError = err instanceof Error ? err.message : "provider request failed";
          logger.warn({ task, model, provider, attempt, err: lastError }, "AI provider attempt failed");
          if (attempt < getModelConfig().defaults.maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
          }
        }
      }
    }
  }

  throw new Error(`All configured AI models failed for ${task}. Last error: ${lastError}`);
}

/** Generate an image from a text prompt (OpenAI DALL-E or OpenRouter image models). */
export async function generateImage(prompt: string, size = "1024x1024"): Promise<GeneratedImage> {
  const openaiKey = getProviderApiKey("openai");
  const openrouterKey = getProviderApiKey("openrouter");

  if (openaiKey) {
    const config = getModelConfig().providers.openai;
    const body = await requestJson(`${config.baseUrl}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.IMAGE_MODEL ?? "dall-e-3",
        prompt,
        n: 1,
        size,
        response_format: "url",
      }),
    });
    const data = Array.isArray(body.data) ? body.data as Array<{ url?: string; b64_json?: string }> : [];
    const first = data[0];
    if (!first?.url && !first?.b64_json) throw new Error("OpenAI image generation returned empty result");
    return { url: first.url, b64: first.b64_json, model: process.env.IMAGE_MODEL ?? "dall-e-3" };
  }

  if (openrouterKey) {
    const model = process.env.IMAGE_MODEL ?? "black-forest-labs/flux-1.1-pro";
    const config = getModelConfig().providers.openrouter;
    const body = await requestJson(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openrouterKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.RENDER_EXTERNAL_URL ?? "https://bot-command-central-1.onrender.com",
        "X-Title": "Crescent-AI",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const choices = Array.isArray(body.choices) ? body.choices as OpenAiResponse["choices"] : [];
    const content = normalizeContent(choices?.[0]?.message?.content);
    const urlMatch = content.match(/https?:\/\/\S+\.(?:png|jpg|jpeg|webp|gif)/i)
      ?? content.match(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/);
    const url = urlMatch ? (urlMatch[1] ?? urlMatch[0]) : undefined;
    if (!url) {
      const anyUrl = content.match(/https?:\/\/\S+/);
      if (anyUrl) return { url: anyUrl[0].replace(/[)\]>]+$/, ""), model };
      throw new Error("OpenRouter image model did not return an image URL. Set OPENAI_API_KEY for DALL-E or configure IMAGE_MODEL.");
    }
    return { url: url.replace(/[)\]>]+$/, ""), model };
  }

  throw new Error("No image provider configured. Set OPENAI_API_KEY (DALL-E) or OPENROUTER_API_KEY + IMAGE_MODEL.");
}

export async function createEmbedding(input: string): Promise<RoutedEmbeddingResponse | null> {
  const config = getModelConfig();
  const provider = "openai" as const;
  const apiKey = getProviderApiKey(provider);
  if (!apiKey) return null;

  try {
    const body = await requestJson(`${config.providers.openai.baseUrl}/embeddings`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.defaults.embedModel, input }),
    });
    const data = Array.isArray(body.data) ? body.data as Array<{ embedding?: unknown }> : [];
    const embedding = data[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length !== config.defaults.embedDim) return null;
    return { embedding: embedding.map(Number), model: config.defaults.embedModel };
  } catch (err) {
    logger.warn({ err }, "AI embedding request failed; continuing without vector memory");
    return null;
  }
}

export function configuredModelCount(task: TaskType): number {
  return getTaskModels(task).length;
}
