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
  chat: { primary: "gpt-4o-mini", fallbacks: ["gpt-4o", "claude-3-5-sonnet-20241022"], params: { maxTokens: 2000, temperature: 0.3 } },
  analysis: { primary: "gpt-4o", fallbacks: ["claude-3-5-sonnet-20241022"], params: { maxTokens: 4000, temperature: 0.1 } },
  code: { primary: "claude-3-5-sonnet-20241022", fallbacks: ["gpt-4o"], params: { maxTokens: 8000, temperature: 0 } },
  math: { primary: "gpt-4o", fallbacks: ["claude-3-5-sonnet-20241022"], params: { maxTokens: 2000, temperature: 0 } },
  creative: { primary: "claude-3-5-sonnet-20241022", fallbacks: ["gpt-4o"], params: { maxTokens: 4000, temperature: 0.7 } },
  vision: { primary: "gpt-4o", fallbacks: ["claude-3-5-sonnet-20241022"], params: { maxTokens: 2000, temperature: 0.2 } },
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
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && (minimum === undefined || parsed >= minimum) ? parsed : fallback;
}

function stringList(value: unknown, fallback: string[]): string[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? [value] : fallback;
  return values.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function loadFromDisk(): ModelRoutingConfig {
  const configuredPath = process.env.MODEL_CONFIG_PATH
    ? path.resolve(process.env.MODEL_CONFIG_PATH)
    : undefined;
  const candidates = configuredPath
    ? [configuredPath]
    : [
        path.resolve(process.cwd(), "config/models.yaml"),
        path.resolve(process.cwd(), "../../config/models.yaml"),
        path.resolve(process.cwd(), "../config/models.yaml"),
      ];
  const filePath = candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
  const source = readFileSync(filePath, "utf8");
  const parsed = record(parse(source));
  const rawRoutes = record(parsed["taskrouting"]);
  const rawProviders = record(parsed["providers"]);
  const rawDefaults = record(parsed["defaults"]);

  const taskRouting = Object.fromEntries(TASK_TYPES.map((task) => {
    const fallback = DEFAULT_ROUTES[task];
    const raw = record(rawRoutes[task]);
    const rawParams = record(raw["params"]);
    return [task, {
      primary: stringValue(raw["primary"], fallback.primary),
      fallbacks: stringList(raw["fallbacks"], fallback.fallbacks),
      params: {
        maxTokens: numberValue(rawParams["maxtokens"] ?? rawParams["maxTokens"], fallback.params.maxTokens, 1),
        temperature: numberValue(rawParams["temperature"], fallback.params.temperature, 0),
      },
    } satisfies TaskRoute];
  })) as Record<TaskType, TaskRoute>;

  const providers = Object.fromEntries((Object.keys(DEFAULT_PROVIDERS) as ProviderName[]).map((name) => {
    const fallback = DEFAULT_PROVIDERS[name];
    const raw = record(rawProviders[name]);
    return [name, {
      apiKeyEnv: stringValue(raw["apikeyenv"] ?? raw["apiKeyEnv"], fallback.apiKeyEnv),
      baseUrl: stringValue(raw["baseurl"] ?? raw["baseUrl"], fallback.baseUrl).replace(/\/$/, ""),
      models: stringList(raw["models"], fallback.models),
    } satisfies ProviderConfig];
  })) as Record<ProviderName, ProviderConfig>;

  return {
    taskRouting,
    providers,
    defaults: {
      timeoutSeconds: numberValue(rawDefaults["timeoutseconds"] ?? rawDefaults["timeoutSeconds"], 30, 1),
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
