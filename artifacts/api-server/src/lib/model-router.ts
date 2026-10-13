import { logger } from "./logger";
import {
  getModelConfig,
  getProviderApiKey,
  getTaskModels,
  getTaskRoute,
  type ProviderName,
  type TaskType,
} from "./model-config";

export type ChatRole = "system" | "user" | "assistant";

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ChatMessage {
  role: ChatRole;
  content: string | ContentPart[];
}

export interface RoutedChatResponse {
  reply: string;
  model: string;
  provider: ProviderName;
  task: TaskType;
}

export interface GeneratedImage {
  url?: string;
  b64?: string;
  model: string;
}

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string | ContentPart[] } }>;
  error?: { message?: string };
}

function openRouterModelId(model: string): string {
  if (model.includes("/")) return model;
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("text-embedding") || model.startsWith("dall-e")) {
    return `openai/${model}`;
  }
  if (model.startsWith("claude")) return `anthropic/${model}`;
  if (model.startsWith("gemini") || model.startsWith("gemma")) return `google/${model}`;
  return model;
}

function nativeModelId(model: string): string {
  const parts = model.split("/");
  return parts.length > 1 ? parts[parts.length - 1]!.replace(/:free$/, "") : model;
}

function providersForModel(model: string): ProviderName[] {
  const lower = model.toLowerCase();
  const direct: ProviderName | null =
    lower.includes("openai/") || lower.startsWith("gpt-") || lower.startsWith("o1")
      ? "openai"
      : lower.includes("anthropic/") || lower.startsWith("claude")
        ? "anthropic"
        : lower.includes("openrouter")
          ? "openrouter"
          : null;
  if (direct === "openrouter") return ["openrouter"];
  const hasDirect = direct ? Boolean(getProviderApiKey(direct)) : false;
  const hasOr = Boolean(getProviderApiKey("openrouter"));
  if (hasDirect && hasOr) return [direct!, "openrouter"];
  if (hasDirect) return [direct!];
  if (hasOr) return ["openrouter"];
  return direct ? [direct, "openrouter"] : ["openrouter"];
}

function backoffMs(attempt: number): number {
  const { retryBackoffBase } = getModelConfig().defaults;
  return Math.min(5000, Math.round(retryBackoffBase ** attempt * 250));
}

async function fetchJson(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const timeoutMs = getModelConfig().defaults.timeoutSeconds * 1000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const error =
        typeof body.error === "object" && body.error !== null
          ? (body.error as { message?: string }).message
          : undefined;
      throw new Error(`${response.status} ${error ?? response.statusText}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeContent(content: string | ContentPart[] | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content.trim();
  return content
    .map((p) => (p.type === "text" ? p.text ?? "" : ""))
    .join("")
    .trim();
}

function buildOpenAiMessages(messages: ChatMessage[]) {
  return messages.map((m) => ({ role: m.role, content: m.content as any }));
}

async function callProvider(
  provider: ProviderName,
  model: string,
  messages: ChatMessage[],
  maxTokens: number,
  temperature: number,
): Promise<string> {
  const providerConfig = getModelConfig().providers[provider];
  const apiKey = getProviderApiKey(provider);
  if (!apiKey) throw new Error(`${providerConfig.apiKeyEnv} is not configured`);

  const resolvedModel = provider === "openrouter" ? openRouterModelId(model) : nativeModelId(model);

  if (provider === "anthropic") {
    const system = messages
      .filter((m) => m.role === "system")
      .map((m) => (typeof m.content === "string" ? m.content : normalizeContent(m.content)))
      .join("\n\n");
    const nonSystem = messages.filter((m) => m.role !== "system");
    const body = await fetchJson(`${providerConfig.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: resolvedModel,
        max_tokens: maxTokens,
        temperature,
        system: system || undefined,
        messages: nonSystem.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: typeof m.content === "string" ? m.content : m.content,
        })),
      }),
    });
    const content = Array.isArray(body.content)
      ? (body.content as Array<{ type?: string; text?: string }>)
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("")
      : "";
    if (!content) throw new Error("Anthropic returned an empty response");
    return content.trim();
  }

  const body = await fetchJson(`${providerConfig.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...(provider === "openrouter"
        ? {
            "HTTP-Referer": process.env.RENDER_EXTERNAL_URL ?? "https://bot-command-central",
            "X-Title": "Bot-Command-Central Crescent",
          }
        : {}),
    },
    body: JSON.stringify({
      model: resolvedModel,
      max_tokens: maxTokens,
      temperature,
      messages: buildOpenAiMessages(messages),
    }),
  });
  const choices = Array.isArray(body.choices) ? (body.choices as OpenAiResponse["choices"]) : [];
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
      const supported =
        providerConfig.models.includes("*") ||
        providerConfig.models.includes(nativeModelId(model)) ||
        providerConfig.models.includes(model);
      if (!supported && provider !== "openrouter") continue;
      if (!getProviderApiKey(provider)) {
        lastError = `${providerConfig.apiKeyEnv} is not configured`;
        continue;
      }
      for (let attempt = 0; attempt <= getModelConfig().defaults.maxRetries; attempt++) {
        try {
          const reply = await callProvider(
            provider,
            model,
            messages,
            route.params.maxTokens,
            route.params.temperature,
          );
          logger.info({ task, model, provider }, "AI model responded");
          return { reply, model, provider, task };
        } catch (err) {
          lastError = err instanceof Error ? err.message : "provider request failed";
          logger.warn({ task, model, provider, attempt, err: lastError }, "AI provider attempt failed");
          const is429 =
            /\b429\b/.test(lastError) ||
            /rate.?limit/i.test(lastError) ||
            /too many requests/i.test(lastError);
          if (is429) {
            await new Promise((resolve) => setTimeout(resolve, 2000 + attempt * 1500));
            break;
          }
          if (attempt < getModelConfig().defaults.maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, backoffMs(attempt)));
          }
        }
      }
    }
  }

  throw new Error(`All configured AI models failed for ${task}. Last error: ${lastError}`);
}

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
  const body = await fetchJson(`${config.baseUrl}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.RENDER_EXTERNAL_URL ?? "https://bot-command-central",
      "X-Title": "Bot-Command-Central Crescent",
    },
    body: JSON.stringify({ model, prompt, size, response_format: "url" }),
  });
  const data = Array.isArray(body.data) ? body.data : [];
  const first = data[0] as { url?: string; b64_json?: string } | undefined;
  if (!first?.url && !first?.b64_json) {
    throw new Error(`OpenRouter image API returned no image for model ${model}`);
  }
  return { url: first.url, b64: first.b64_json, model };
}

export async function generateImage(prompt: string, size = "1024x1024"): Promise<GeneratedImage> {
  const openrouterKey = getProviderApiKey("openrouter");
  const openaiKey = getProviderApiKey("openai");

  if (openrouterKey) {
    const preferred = process.env.IMAGE_MODEL?.trim();
    const models = preferred
      ? [preferred, ...FREE_IMAGE_MODELS.filter((m) => m !== preferred)]
      : [...FREE_IMAGE_MODELS, "google/gemini-2.5-flash-image"];
    let lastError = "No image model succeeded";
    for (const model of models) {
      try {
        const result = await openRouterGenerateImage(openrouterKey, model, prompt, size);
        logger.info({ model }, "Image generated via OpenRouter");
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err.message : "image request failed";
        logger.warn({ model, err: lastError }, "OpenRouter image model failed");
        if (lastError.includes("402") || lastError.toLowerCase().includes("insufficient credits")) {
          continue;
        }
      }
    }
    if (lastError.includes("402") || lastError.toLowerCase().includes("insufficient credits")) {
      throw new Error(
        "OpenRouter image generation needs credits. Add credits at https://openrouter.ai/settings/credits or set OPENAI_API_KEY. " +
          `Last error: ${lastError}`,
      );
    }
    throw new Error(lastError);
  }

  if (openaiKey) {
    const body = await fetchJson("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.IMAGE_MODEL?.trim() || "dall-e-3",
        prompt,
        size,
        n: 1,
      }),
    });
    const data = Array.isArray(body.data) ? body.data : [];
    const first = data[0] as { url?: string; b64_json?: string } | undefined;
    if (!first?.url && !first?.b64_json) throw new Error("OpenAI image generation returned empty result");
    return { url: first.url, b64: first.b64_json, model: process.env.IMAGE_MODEL || "dall-e-3" };
  }

  throw new Error("No image provider configured. Set OPENROUTER_API_KEY or OPENAI_API_KEY.");
}

export function countConfiguredModels(task: TaskType = "chat"): number {
  return getTaskModels(task).length;
}
