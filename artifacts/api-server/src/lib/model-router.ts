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
  const timeoutMs = getModelConfig().defaults.timeoutSeconds * 1000;
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
  if (id.includes("gemini-2.5-pro")) return "gemini-2.5-pro";
  if (id.includes("gemini-2.5-flash")) return "gemini-2.5-flash";
  if (id.includes("gemini-2.0-flash-lite")) return "gemini-2.0-flash-lite";
  if (id.includes("gemini-2.0-flash")) return "gemini-2.0-flash";
  if (id.includes("gemini-1.5-flash")) return "gemini-1.5-flash";
  if (id.includes("gemini-1.5-pro")) return "gemini-1.5-pro";
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
          const match = url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
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
  const first = candidates[0] as { content?: { parts?: Array<{ text?: string }> } } | undefined;
  const text = (first?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  if (!text) {
    const block = result.promptFeedback ?? result.error;
    throw new Error(`Google Gemini returned an empty response${block ? `: ${JSON.stringify(block)}` : ""}`);
  }
  return text;
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

  if (provider === "google") {
    return callGoogle(model, messages, maxTokens, temperature);
  }

  const resolvedModel = provider === "openrouter" ? openRouterModelId(model) : nativeModelId(model);
  if (provider === "openrouter" && (resolvedModel.includes(":free") || !getProviderApiKey("openai"))) {
    maxTokens = Math.min(maxTokens, 900);
  }

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
      ...(provider === "openrouter"
        ? {
            "HTTP-Referer": process.env.RENDER_EXTERNAL_URL ?? "https://bot-command-central-1.onrender.com",
            "X-Title": "Crescent-AI",
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

const OPENROUTER_FREE_CHAT = [
  "google/gemini-2.0-flash-exp:free",
  "google/gemma-3-27b-it:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "nvidia/nemotron-nano-9b-v2:free",
];

const GOOGLE_CHAT = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-2.5-flash", "gemini-2.0-flash"];

export async function routeChat(task: TaskType, messages: ChatMessage[]): Promise<RoutedChatResponse> {
  const route = getTaskRoute(task);
  const hasOpenAI = Boolean(getProviderApiKey("openai"));
  const hasAnthropic = Boolean(getProviderApiKey("anthropic"));
  const hasOR = Boolean(getProviderApiKey("openrouter"));
  const hasGoogle = Boolean(getProviderApiKey("google"));
  let candidates = getTaskModels(task);

  if (hasGoogle) {
    candidates = [...new Set([...GOOGLE_CHAT, ...candidates])];
  }
  if (hasOR && !hasOpenAI && !hasAnthropic) {
    candidates = [...new Set([...candidates, ...OPENROUTER_FREE_CHAT])];
  }

  let lastError = "No provider is configured";

  for (const model of candidates) {
    for (const provider of providersForModel(model)) {
      const providerConfig = getModelConfig().providers[provider];
      const supported =
        providerConfig.models.includes("*") ||
        providerConfig.models.includes(nativeModelId(model)) ||
        providerConfig.models.includes(model) ||
        (provider === "google" && isGoogleNativeModel(model));
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
          const is429 =
            /\b429\b/.test(lastError) ||
            /rate.?limit/i.test(lastError) ||
            /too many requests/i.test(lastError) ||
            /resource.?exhausted/i.test(lastError);
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
  const data = Array.isArray(body.data) ? (body.data as Array<{ url?: string; b64_json?: string }>) : [];
  const first = data[0];
  if (!first?.url && !first?.b64_json) {
    throw new Error(`OpenRouter image API returned no image for model ${model}`);
  }
  return { url: first.url, b64: first.b64_json, model };
}

async function generateCloudflareFlux(prompt: string): Promise<GeneratedImage> {
  const accountId =
    process.env.CLOUDFLARE_ACCOUNT_ID?.trim() ||
    process.env.CF_ACCOUNT_ID?.trim() ||
    "";
  const token =
    process.env.CLOUDFLARE_API_TOKEN?.trim() ||
    process.env.CF_API_TOKEN?.trim() ||
    process.env.CLOUDFLARE_API_KEY?.trim() ||
    "";
  if (!accountId || !token) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set");
  }

  const model =
    process.env.CLOUDFLARE_IMAGE_MODEL?.trim() ||
    "@cf/black-forest-labs/flux-1-schnell";
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  const steps = Math.min(8, Math.max(1, Number(process.env.CLOUDFLARE_FLUX_STEPS ?? "4") || 4));

  const body = await requestJson(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      prompt: prompt.slice(0, 2048),
      steps,
    }),
  });

  const result = body.result ?? body;
  let b64: string | undefined;
  if (typeof result === "string") {
    b64 = result;
  } else if (result && typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.image === "string") b64 = r.image;
    else if (typeof r.b64_json === "string") b64 = r.b64_json;
  }
  if (!b64) {
    throw new Error(`Cloudflare Flux returned no image: ${JSON.stringify(body).slice(0, 200)}`);
  }
  const pure = b64.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "");
  return { b64: pure, model: "" };
}

export async function generateImage(prompt: string, size = "1024x1024"): Promise<GeneratedImage> {
  const openaiKey = getProviderApiKey("openai");
  const openrouterKey = getProviderApiKey("openrouter");
  const errors: string[] = [];
  const hasCloudflare = Boolean(
    (process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID) &&
      (process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_KEY),
  );

  // 1) Cloudflare Workers AI — FLUX.1 Schnell (best free quality)
  if (hasCloudflare) {
    try {
      const result = await generateCloudflareFlux(prompt);
      logger.info({ provider: "cloudflare", model: "flux-1-schnell" }, "Image generated via Cloudflare Flux");
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "cloudflare failed";
      errors.push(`Cloudflare: ${msg}`);
      logger.warn({ err: msg }, "Cloudflare Flux image generation failed");
    }
  } else {
    errors.push("CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN not set");
  }

  // 2) OpenRouter (often needs credits)
  if (openrouterKey) {
    const preferred = process.env.IMAGE_MODEL;
    const candidates = preferred
      ? [preferred, ...FREE_IMAGE_MODELS.filter((m) => m !== preferred)]
      : [...FREE_IMAGE_MODELS, "google/gemini-2.5-flash-image"];

    for (const model of candidates) {
      try {
        const result = await openRouterGenerateImage(openrouterKey, model, prompt, size);
        logger.info({ model }, "Image generated via OpenRouter");
        return result;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "image request failed";
        errors.push(`OpenRouter/${model}: ${msg}`);
        logger.warn({ model, err: msg }, "OpenRouter image model failed");
      }
    }
  } else {
    errors.push("OPENROUTER_API_KEY not set");
  }

  // 3) OpenAI DALL·E
  if (openaiKey) {
    try {
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
      const data = Array.isArray(body.data) ? (body.data as Array<{ url?: string; b64_json?: string }>) : [];
      const first = data[0];
      if (!first?.url && !first?.b64_json) throw new Error("OpenAI image generation returned empty result");
      return { url: first.url, b64: first.b64_json, model: process.env.IMAGE_MODEL ?? "dall-e-3" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "openai image failed";
      errors.push(`OpenAI: ${msg}`);
      logger.warn({ err: msg }, "OpenAI image generation failed");
    }
  } else {
    errors.push("OPENAI_API_KEY not set");
  }

  // 4) Pollinations — free but rate-limits after a few images (HTTP 402)
  {
    const dims = size.split("x").map((n) => parseInt(n, 10));
    const w = Number.isFinite(dims[0]) ? Math.min(dims[0]!, 1024) : 1024;
    const h = Number.isFinite(dims[1]) ? Math.min(dims[1]!, 1024) : 1024;
    const encoded = encodeURIComponent(prompt.slice(0, 300));
    const seed = Math.floor(Math.random() * 1_000_000);
    const candidates = [
      `https://image.pollinations.ai/prompt/${encoded}?width=${w}&height=${h}&nologo=true&seed=${seed}`,
      `https://image.pollinations.ai/prompt/${encoded}?width=${w}&height=${h}&nologo=true&model=flux&seed=${seed}`,
    ];
    let pollErr = "unknown";
    for (let i = 0; i < candidates.length; i++) {
      const url = candidates[i]!;
      try {
        if (i > 0) await new Promise((r) => setTimeout(r, 2500));
        const probe = await fetch(url, { method: "GET", signal: AbortSignal.timeout(30_000) });
        if (probe.status === 402 || probe.status === 429) {
          pollErr = `rate limited (HTTP ${probe.status}) — free anonymous quota used up for now`;
          continue;
        }
        if (!probe.ok) {
          pollErr = `HTTP ${probe.status}`;
          continue;
        }
        logger.info({ provider: "pollinations" }, "Image generated via free Pollinations fallback");
        return { url, model: "" };
      } catch (err) {
        pollErr = err instanceof Error ? err.message : "pollinations failed";
      }
    }
    errors.push(`Pollinations: ${pollErr}`);
    logger.warn({ err: pollErr }, "Pollinations free image fallback failed");
  }

  const needsCf = !hasCloudflare;
  throw new Error(
    "Image generation failed on all providers.\n" +
      (needsCf
        ? "• FREE sustained images: set CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN on Render (FLUX.1 Schnell)\n"
        : "• Cloudflare Flux failed — check token permissions (Workers AI)\n") +
      "• Pollinations free tier is tiny and returns 402 after a few images\n" +
      "• Paid options: OPENAI_API_KEY (DALL·E) or OpenRouter credits\n" +
      `Details: ${errors.slice(0, 4).join(" | ")}`,
  );
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
    const data = Array.isArray(body.data) ? (body.data as Array<{ embedding?: unknown }>) : [];
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
