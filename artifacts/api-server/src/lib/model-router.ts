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

/** Map bare model names to OpenRouter-qualified IDs. */
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

/** Strip provider prefix for native OpenAI / Anthropic APIs. */
function nativeModelId(model: string): string {
  const slash = model.indexOf("/");
  if (slash < 0) return model;
  return model.slice(slash + 1);
}

function providerForModel(model: string): ProviderName {
  const bare = nativeModelId(model);
  if (bare.startsWith("gpt-") || bare.startsWith("o1") || bare.startsWith("o3") || bare.startsWith("dall-e") || bare.startsWith("text-embedding-")) {
    return "openai";
  }
  if (bare.startsWith("claude-")) return "anthropic";
  return "openrouter";
}

function providersForModel(model: string): ProviderName[] {
  const direct = providerForModel(model);
  if (direct === "openrouter") return ["openrouter"];
  const hasDirect = Boolean(getProviderApiKey(direct));
  const hasOr = Boolean(getProviderApiKey("openrouter"));
  if (hasDirect && hasOr) return [direct, "openrouter"];
  if (hasDirect) return [direct];
  if (hasOr) return ["openrouter"];
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

  const resolvedModel = provider === "openrouter" ? openRouterModelId(model) : nativeModelId(model);

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
        "x-api-key": apiKey,
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: resolvedModel,
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
      model: resolvedModel,
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
      const supported = providerConfig.models.includes("*") || providerConfig.models.includes(nativeModelId(model)) || providerConfig.models.includes(model);
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

/** Free / zero-cost OpenRouter image models tried first when account has no credits. */
const FREE_IMAGE_MODELS = [
  "inclusionai/ming-image-0.1-design",
  "inclusionai/ming-image-0.1-design-layer",
  "meta/muse-image",
  "recraft/recraft-v4.1-flash",
  "bytedance-seed/seedream-5-0-flash",
];

async function openRouterGenerateImage(
  apiKey: string,
  model: string,
  prompt: string,
  size: string,
): Promise<GeneratedImage> {
  const config = getModelConfig().providers.openrouter;
  const body = await requestJson(`${config.baseUrl}/images`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.RENDER_EXTERNAL_URL ?? "https://bot-command-central-1.onrender.com",
      "X-Title": "Crescent-AI",
    },
    body: JSON.stringify({
      model,
      prompt,
      aspect_ratio: "1:1",
      size,
    }),
  });
  const data = Array.isArray(body.data) ? body.data as Array<{ url?: string; b64_json?: string }> : [];
  const first = data[0];
  if (!first?.url && !first?.b64_json) {
    throw new Error(`OpenRouter image API returned no image for model ${model}`);
  }
  return { url: first.url, b64: first.b64_json, model };
}

/** Generate an image via OpenAI DALL-E or OpenRouter Images API. */
export async function generateImage(prompt: string, size = "1024x1024"): Promise<GeneratedImage> {
  const openaiKey = getProviderApiKey("openai");
  const openrouterKey = getProviderApiKey("openrouter");

  if (openrouterKey) {
    const preferred = process.env.IMAGE_MODEL;
    const candidates = preferred
      ? [preferred, ...FREE_IMAGE_MODELS.filter((m) => m !== preferred)]
      : [...FREE_IMAGE_MODELS, "google/gemini-2.5-flash-image"];

    let lastError = "No image model succeeded";
    for (const model of candidates) {
      try {
        const result = await openRouterGenerateImage(openrouterKey, model, prompt, size);
        logger.info({ model }, "Image generated via OpenRouter");
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err.message : "image request failed";
        logger.warn({ model, err: lastError }, "OpenRouter image model failed");
        // If account has never bought credits, keep trying free models then surface a clear tip
        if (lastError.includes("402") || lastError.toLowerCase().includes("insufficient credits")) {
          continue;
        }
      }
    }

    if (lastError.includes("402") || lastError.toLowerCase().includes("insufficient credits")) {
      throw new Error(
        "OpenRouter image generation needs credits (even small ones). " +
          "Add credits at https://openrouter.ai/settings/credits  — or set OPENAI_API_KEY for DALL·E. " +
          `Last error: ${lastError}`,
      );
    }
    throw new Error(lastError);
  }

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

  throw new Error("No image provider configured. Set OPENROUTER_API_KEY or OPENAI_API_KEY.");
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
