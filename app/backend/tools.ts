import { createHash } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import {
  readCurrentLocationSignal,
  readHomeEnvironmentSignal,
  readTimeNowSignal,
  readWeatherSignal
} from "./runtime-signals";
import { ToolExecutionResult, ToolName, ToolSourceLink } from "./types";

type ToolExecutionInput = {
  toolName: ToolName;
  message: string;
  imageDataUrls: string[];
  signal?: AbortSignal;
};

type HomeContext = {
  home_id: string;
  address_label: string;
  city: string;
  district: string;
  timezone: string;
  latitude: number;
  longitude: number;
};

type CurrentLocationState = {
  home_id: string;
  area_id: string;
  area_name: string;
  floor_id: string;
  floor_name: string;
  timestamp: string;
  source_type: string;
  source_label: string;
  confidence: number;
};

type HomeEnvironmentState = {
  home_id: string;
  area_id: string;
  area_name: string;
  floor_name: string;
  timestamp: string;
  source: string;
  states: {
    occupancy: string;
    door: string;
    window: string;
    light: string;
    air_conditioner: string;
    temperature_c: number;
    humidity_pct: number;
  };
};

const ROOT = process.cwd();
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const TOOL_CACHE_ROOT = path.join(os.tmpdir(), "robot-agent-student-tool-cache");
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const TOOL_CACHE_POLICY: Partial<
  Record<
    ToolName,
    {
      ttlMs: number;
      staleFallbackMaxAgeMs: number;
    }
  >
> = {
  weather_lookup: {
    ttlMs: 5 * 60 * 1000,
    staleFallbackMaxAgeMs: 60 * 60 * 1000
  },
  web_search: {
    ttlMs: 10 * 60 * 1000,
    staleFallbackMaxAgeMs: 30 * 60 * 1000
  }
};

type ToolCacheEntry = {
  toolName: ToolName;
  cacheKey: string;
  cachedAt: string;
  result: ToolExecutionResult;
};

function resolveToolStatePath(filename: string) {
  return path.join(ROOT, "runtime", "tool-state", filename);
}

function resolveToolCachePath(toolName: ToolName, cacheKey: string) {
  const hash = createHash("sha1").update(`${toolName}:${cacheKey}`).digest("hex");
  return path.join(TOOL_CACHE_ROOT, toolName, `${hash}.json`);
}

function cloneToolResult(result: ToolExecutionResult): ToolExecutionResult {
  return JSON.parse(JSON.stringify(result)) as ToolExecutionResult;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

async function sleep(ms: number, signal?: AbortSignal) {
  if (ms <= 0) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function retryOperation<T>(
  operation: () => Promise<T>,
  options?: {
    retries?: number;
    delayMs?: number;
    signal?: AbortSignal;
  }
) {
  const retries = options?.retries ?? 1;
  const delayMs = options?.delayMs ?? 240;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      lastError = error;
      if (attempt === retries) {
        break;
      }

      await sleep(delayMs * (attempt + 1), options?.signal);
    }
  }

  throw lastError;
}

async function readToolCache(
  toolName: ToolName,
  cacheKey: string
): Promise<ToolCacheEntry | null> {
  try {
    const fullPath = resolveToolCachePath(toolName, cacheKey);
    return JSON.parse(await fs.readFile(fullPath, "utf8")) as ToolCacheEntry;
  } catch {
    return null;
  }
}

async function writeToolCache(
  toolName: ToolName,
  cacheKey: string,
  result: ToolExecutionResult
) {
  const fullPath = resolveToolCachePath(toolName, cacheKey);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const payload: ToolCacheEntry = {
    toolName,
    cacheKey,
    cachedAt: new Date().toISOString(),
    result: cloneToolResult(result)
  };
  await fs.writeFile(fullPath, JSON.stringify(payload, null, 2), "utf8");
}

function markCachedResult(
  entry: ToolCacheEntry,
  cacheStatus: "fresh_cache" | "stale_fallback",
  overrides?: Partial<ToolExecutionResult>
): ToolExecutionResult {
  const cloned = cloneToolResult(entry.result);
  return {
    ...cloned,
    ...overrides,
    output: {
      ...cloned.output,
      cache_status: cacheStatus,
      cached_at: entry.cachedAt
    }
  };
}

async function readJsonFile<T>(filename: string): Promise<T> {
  const fullPath = resolveToolStatePath(filename);
  return JSON.parse(await fs.readFile(fullPath, "utf8")) as T;
}

function normalizeQuery(message: string) {
  return message.replace(/\s+/g, " ").trim();
}

function stripSystemPrefix(message: string) {
  return normalizeQuery(
    message
      .replace(/^请问[:：]?\s*/i, "")
      .replace(/^帮我[:：]?\s*/i, "")
      .replace(/^搜索一下[:：]?\s*/i, "")
      .replace(/^请搜索[:：]?\s*/i, "")
  );
}

function weatherCodeToText(code: number, isDay: number) {
  const table: Record<number, string> = {
    0: isDay ? "晴朗" : "夜间晴朗",
    1: "大致晴",
    2: "局部多云",
    3: "阴",
    45: "有雾",
    48: "霜雾",
    51: "毛毛雨",
    53: "中度毛毛雨",
    55: "较强毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    71: "小雪",
    73: "中雪",
    75: "大雪",
    80: "小阵雨",
    81: "中阵雨",
    82: "强阵雨",
    95: "雷暴"
  };

  return table[code] || `天气代码 ${code}`;
}

async function executeTimeNow(): Promise<ToolExecutionResult> {
  const snapshot = await readTimeNowSignal();

  return {
    toolName: "time_now",
    status: "success",
    summary: `当前时间为 ${snapshot.value.formatted_time}（${snapshot.value.timezone}）。`,
    sourceLabel: snapshot.source,
    output: {
      ...snapshot.value,
      signal_mode: snapshot.signal_mode,
      signal_freshness: snapshot.signal_freshness,
      fetched_at: snapshot.fetched_at
    }
  };
}

async function executeCurrentLocation(): Promise<ToolExecutionResult> {
  const snapshot = await readCurrentLocationSignal();
  const location = snapshot.value;

  return {
    toolName: "current_location",
    status: "success",
    summary: `机器人当前位于 ${location.floor_name}${location.area_name}。`,
    sourceLabel: snapshot.source,
    sourceType: location.source_type,
    output: {
      ...location,
      signal_mode: snapshot.signal_mode,
      signal_freshness: snapshot.signal_freshness,
      fetched_at: snapshot.fetched_at
    }
  };
}

async function inferLocationFromImages(
  imageDataUrls: string[],
  signal?: AbortSignal
): Promise<ToolExecutionResult> {
  const apiKey = process.env.API_KEY?.trim();
  const model = process.env.MODEL?.trim();
  const baseUrl = process.env.BASE_URL?.trim() || DEFAULT_BASE_URL;

  if (!apiKey || !model || imageDataUrls.length === 0) {
    throw new Error("scene_inference fallback unavailable.");
  }

  const content: Array<Record<string, unknown>> = [
    {
      type: "text",
      text:
        "请只根据画面判断最可能的家庭区域，仅允许从以下区域中选择一个：客厅、书桌区、餐桌区、玄关、走廊、未知。只输出合法 JSON，包含字段 area_name、area_id、confidence。"
    },
    ...imageDataUrls.map((url) => ({
      type: "image_url",
      image_url: { url }
    }))
  ];

  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 200,
      messages: [
        {
          role: "user",
          content
        }
      ]
    })
  });

  if (!response.ok) {
    throw new Error(`scene_inference fallback failed with status ${response.status}`);
  }

  const data = await response.json();
  const rawContent =
    data?.choices?.[0]?.message?.content ||
    data?.choices?.[0]?.message?.reasoning_content ||
    "";

  const jsonText =
    typeof rawContent === "string"
      ? rawContent.slice(rawContent.indexOf("{"), rawContent.lastIndexOf("}") + 1)
      : "";

  const parsed = JSON.parse(jsonText || "{}") as {
    area_name?: string;
    area_id?: string;
    confidence?: number | string;
  };

  const confidence = Number(parsed.confidence ?? 0.58) || 0.58;

  return {
    toolName: "current_location",
    status: "success",
    summary: `当前未命中外部位置源，已退化为画面推断：机器人可能位于${parsed.area_name || "未知区域"}。`,
    sourceLabel: "multimodal_scene_inference",
    sourceType: "scene_inference",
    output: {
      home_id: "student-template-home-001",
      area_id: parsed.area_id || "unknown_area",
      area_name: parsed.area_name || "未知区域",
      floor_id: "unknown_floor",
      floor_name: "未知楼层",
      timestamp: new Date().toISOString(),
      source_type: "scene_inference",
      source_label: "multimodal_scene_inference",
      confidence
    }
  };
}

async function executeWeatherLookup(signal?: AbortSignal): Promise<ToolExecutionResult> {
  const snapshot = await readWeatherSignal({ signal });

  return {
    toolName: "weather_lookup",
    status: "success",
    summary:
      snapshot.signal_freshness === "stale_fallback"
        ? "外部天气服务当前不可用，已退化为最近一次成功获取的天气快照。"
        : `${snapshot.value.city} 当前天气为 ${snapshot.value.condition}，气温约 ${snapshot.value.temperature_c}°C。`,
    sourceLabel: snapshot.source,
    output: {
      ...snapshot.value,
      signal_mode: snapshot.signal_mode,
      signal_freshness: snapshot.signal_freshness,
      fetched_at: snapshot.fetched_at,
      expires_at: snapshot.expires_at,
      stale_fallback_until: snapshot.stale_fallback_until,
      last_success_latency_ms: snapshot.last_success_latency_ms,
      last_error: snapshot.last_error,
      cache_status:
        snapshot.signal_freshness === "stale_fallback" ? "stale_fallback" : "fresh_cache"
    }
  };
}

async function executeHomeEnvironmentStatus(): Promise<ToolExecutionResult> {
  const snapshot = await readHomeEnvironmentSignal();
  const state = snapshot.value;

  return {
    toolName: "home_environment_status",
    status: "success",
    summary: `${state.area_name}当前门窗状态稳定，空调为 ${state.states.air_conditioner}，温度 ${state.states.temperature_c}°C。`,
    sourceLabel: snapshot.source,
    output: {
      ...state,
      signal_mode: snapshot.signal_mode,
      signal_freshness: snapshot.signal_freshness,
      fetched_at: snapshot.fetched_at
    }
  };
}

function decodeDuckDuckGoRedirect(url: string) {
  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg ? decodeURIComponent(uddg) : parsed.toString();
  } catch {
    return url;
  }
}

function extractDuckDuckGoResults(html: string): ToolSourceLink[] {
  const matches = Array.from(
    html.matchAll(
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
    )
  );

  const links: ToolSourceLink[] = [];
  for (const match of matches) {
    const href = match[1];
    const rawTitle = match[2]
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, "\"")
      .replace(/\s+/g, " ")
      .trim();

    if (!rawTitle) {
      continue;
    }

    const url = decodeDuckDuckGoRedirect(href);
    if (!/^https?:\/\//i.test(url)) {
      continue;
    }

    links.push({
      title: rawTitle,
      url
    });
  }

  const deduped = new Map<string, ToolSourceLink>();
  for (const item of links) {
    if (!deduped.has(item.url)) {
      deduped.set(item.url, item);
    }
  }

  return Array.from(deduped.values()).slice(0, 5);
}

async function executeWebSearch(
  message: string,
  signal?: AbortSignal
): Promise<ToolExecutionResult> {
  const query = stripSystemPrefix(message);
  if (!query) {
    throw new Error("web_search requires a non-empty explicit query.");
  }

  const cachePolicy = TOOL_CACHE_POLICY.web_search;
  const cacheKey = query.toLowerCase();
  const cached = cachePolicy ? await readToolCache("web_search", cacheKey) : null;
  const now = Date.now();

  if (
    cached &&
    cachePolicy &&
    now - new Date(cached.cachedAt).getTime() <= cachePolicy.ttlMs
  ) {
    return markCachedResult(cached, "fresh_cache");
  }

  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);

  try {
    const sources = await retryOperation(
      async () => {
        const response = await fetch(url.toString(), {
          signal,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; RobotAgentStudentStarter/1.0; +https://duckduckgo.com/)"
          }
        });

        if (!response.ok) {
          if (RETRYABLE_STATUS.has(response.status)) {
            throw new Error(`web_search retryable status ${response.status}`);
          }

          throw new Error(`web_search failed with status ${response.status}`);
        }

        const html = await response.text();
        const links = extractDuckDuckGoResults(html);

        if (links.length === 0) {
          throw new Error("web_search returned no usable sources.");
        }

        return links;
      },
      {
        retries: 1,
        delayMs: 260,
        signal
      }
    );

    const result: ToolExecutionResult = {
      toolName: "web_search",
      status: "success",
      summary: `已围绕“${query}”检索到 ${sources.length} 条可供学生溯源的网页来源。`,
      sourceLabel: "DuckDuckGo HTML Search",
      output: {
        query,
        source_count: sources.length
      },
      sources
    };

    if (cachePolicy) {
      await writeToolCache("web_search", cacheKey, result);
    }

    return result;
  } catch (error) {
    if (
      !isAbortError(error) &&
      cached &&
      cachePolicy &&
      now - new Date(cached.cachedAt).getTime() <= cachePolicy.staleFallbackMaxAgeMs
    ) {
      return markCachedResult(cached, "stale_fallback", {
        summary:
          "外部检索服务当前不可用，已退化为最近一次成功获取的搜索缓存结果，用于保证课堂演示连续性。",
        sourceLabel: "DuckDuckGo HTML Search (stale cache fallback)"
      });
    }

    throw error;
  }
}

export async function executeToolForRoute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
  switch (input.toolName) {
    case "time_now":
      return executeTimeNow();
    case "current_location":
      try {
        return await executeCurrentLocation();
      } catch (error) {
        if (input.imageDataUrls.length > 0) {
          return inferLocationFromImages(input.imageDataUrls, input.signal);
        }
        throw error;
      }
    case "weather_lookup":
      return executeWeatherLookup(input.signal);
    case "home_environment_status":
      return executeHomeEnvironmentStatus();
    case "web_search":
      return executeWebSearch(input.message, input.signal);
    default:
      throw new Error(`Unsupported tool route: ${String(input.toolName)}`);
  }
}
