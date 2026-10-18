import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

export const TASK_TYPES = ["chat", "analysis", "code", "math", "creative", "vision"] as const;
export type TaskType = typeof TASK_TYPES[number];
export type ProviderName = "openai" | "anthropic" | "openrouter";

export interface ModelParams {
  maxTokens: number;
  temperature: number;
}

export interface TaskRoute {
  primary: string;
  fallbacks: string[];
  params: ModelParams;
}

export interface ProviderConfig {
  apiKeyEnv: string;
  baseUrl: string;
  models: string[];
}

export interface ModelRoutingConfig {
  taskRouting: Record<TaskType, TaskRoute>;
  providers: Record<ProviderName, ProviderConfig>;
  defaults: {
    timeoutSeconds: number;
    maxRetries: number;
    retryBackoffBase: number;
    embedModel: string;
    embedDim: number;
  };
}

const DEFAULT_ROUTES: Record<TaskType, TaskRoute> = {
  // Prefer OpenRouter free models first so Crescent works without paid OpenAI credits.
  chat: {
    primary: "google/gemini-2.0-flash-exp:free",
    fallbacks: [
      "google/gemma-3-27b-it:free",
      "meta-llama/llama-3.3-70b-instruct:free",
      "gpt-4o-mini",
      "gpt-4o",
    ],
    params: { maxTokens: 900, temperature: 0.3 },
  },
  analysis: {
    primary: "google/gemini-2.0-flash-exp:free",
    fallbacks: ["google/gemma-3-27b-it:free", "gpt-4o-mini", "gpt-4o"],
    params: { maxTokens: 1200, temperature: 0.1 },
  },
  code: {
    primary: "google/gemma-3-27b-it:free",
    fallbacks: ["google/gemini-2.0-flash-exp:free", "gpt-4o-mini", "gpt-4o"],
    params: { maxTokens: 1500, temperature: 0 },
  },
  math: {
    primary: "google/gemini-2.0-flash-exp:free",
    fallbacks: ["gpt-4o-mini", "gpt-4o"],
    params: { maxTokens: 900, temperature: 0 },
  },
  creative: {
    primary: "google/gemini-2.0-flash-exp:free",
    fallbacks: ["google/gemma-3-27b-it:free", "gpt-4o-mini"],
    params: { maxTokens: 1000, temperature: 0.7 },
  },
  vision: {
    primary: "google/gemini-2.0-flash-exp:free",
    fallbacks: ["gpt-4o-mini", "gpt-4o", "google/gemma-3-27b-it:free"],
    params: { maxTokens: 900, temperature: 0.2 },
  },
};

const DEFAULT_PROVIDERS: Record<ProviderName, ProviderConfig> = {
  openai: { apiKeyEnv: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1", models: ["gpt-4o", "gpt-4o-mini", "text-embedding-3-small"] },
  anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY", baseUrl: "https://api.anthropic.com/v1", models: ["claude-3-5-sonnet-20241022"] },
  openrouter: { apiKeyEnv: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api/v1", models: ["*"] },
};

let cachedConfig: ModelRoutingConfig | undefined;

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number, minimum?: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && (minimum === undefined || parsed >= minimum) ? parsed : fallback;
}

function stringList(value: unknown, fallback: string[]): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : fallback;
  const out = values.map((v) => String(v).trim()).filter(Boolean);
  return out.length ? out : fallback;
}

function loadFromDisk(): ModelRoutingConfig {
  const candidates = [
    path.join(process.cwd(), "config", "models.yaml"),
    path.join(process.cwd(), "..", "..", "config", "models.yaml"),
    path.join(process.cwd(), "artifacts", "api-server", "config", "models.yaml"),
  ];
  let rawFile: Record<string, unknown> = {};
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      rawFile = record(parse(readFileSync(file, "utf8")));
      break;
    } catch {
      rawFile = {};
    }
  }

  const taskRouting = { ...DEFAULT_ROUTES } as Record<TaskType, TaskRoute>;
  const rawTasks = record(rawFile["taskRouting"] ?? rawFile["tasks"]);
  for (const task of TASK_TYPES) {
    const fallback = DEFAULT_ROUTES[task];
    const raw = record(rawTasks[task]);
    const rawParams = record(raw["params"]);
    taskRouting[task] = {
      primary: stringValue(raw["primary"], fallback.primary),
      fallbacks: stringList(raw["fallbacks"], fallback.fallbacks),
      params: {
        maxTokens: numberValue(rawParams["maxtokens"] ?? rawParams["maxTokens"], fallback.params.maxTokens, 1),
        temperature: numberValue(rawParams["temperature"], fallback.params.temperature, 0),
      },
    };
  }

  const providers = { ...DEFAULT_PROVIDERS } as Record<ProviderName, ProviderConfig>;
  const rawProviders = record(rawFile["providers"]);
  for (const name of Object.keys(DEFAULT_PROVIDERS) as ProviderName[]) {
    const fallback = DEFAULT_PROVIDERS[name];
    const raw = record(rawProviders[name]);
    providers[name] = {
      apiKeyEnv: stringValue(raw["apikeyenv"] ?? raw["apiKeyEnv"], fallback.apiKeyEnv),
      baseUrl: stringValue(raw["baseurl"] ?? raw["baseUrl"], fallback.baseUrl).replace(/\/$/, ""),
      models: stringList(raw["models"], fallback.models),
    };
  }

  const rawDefaults = record(rawFile["defaults"]);
  return {
    taskRouting,
    providers,
    defaults: {
      timeoutSeconds: numberValue(rawDefaults["timeoutseconds"] ?? rawDefaults["timeoutSeconds"], 60, 5),
      maxRetries: numberValue(rawDefaults["maxretries"] ?? rawDefaults["maxRetries"], 2, 0),
      retryBackoffBase: numberValue(rawDefaults["retrybackoffbase"] ?? rawDefaults["retryBackoffBase"], 1.5, 1),
      embedModel: stringValue(rawDefaults["embedmodel"] ?? rawDefaults["embedModel"], "text-embedding-3-small"),
      embedDim: numberValue(rawDefaults["embeddim"] ?? rawDefaults["embedDim"], 1536, 1),
    },
  };
}

export function getModelConfig(): ModelRoutingConfig {
  cachedConfig ??= loadFromDisk();
  return cachedConfig;
}

export function getTaskRoute(task: TaskType): TaskRoute {
  return getModelConfig().taskRouting[task];
}

export function getTaskModels(task: TaskType): string[] {
  const route = getTaskRoute(task);
  return [...new Set([route.primary, ...route.fallbacks])];
}

export function getProviderApiKey(provider: ProviderName): string {
  const config = getModelConfig().providers[provider];
  const aliases: Record<ProviderName, string[]> = {
    openai: ["OPENAI_API_KEY", "OPENAIAPIKEY"],
    anthropic: ["ANTHROPIC_API_KEY", "ANTHROPICAPIKEY"],
    openrouter: ["OPENROUTER_API_KEY", "AGENTROUTER_API_KEY"],
  };
  return process.env[config.apiKeyEnv] ?? aliases[provider].map((key) => process.env[key]).find(Boolean) ?? "";
}

export function resetModelConfigForTests(): void {
  cachedConfig = undefined;
}
