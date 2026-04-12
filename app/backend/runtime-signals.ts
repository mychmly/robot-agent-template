import { promises as fs } from "fs";
import path from "path";
import { RuntimeSignalKey } from "./types";

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

type WeatherSnapshotValue = {
  city: string;
  district: string;
  condition: string;
  temperature_c: number;
  humidity_pct: number;
  timestamp: string;
  source: string;
};

export type RuntimeSignalSnapshot<T> = {
  key: RuntimeSignalKey;
  signal_mode: "immediate_local" | "state_mirror" | "ttl_snapshot";
  source: string;
  fetched_at: string;
  expires_at?: string;
  stale_fallback_until?: string;
  signal_freshness: "fresh" | "stale_fallback";
  last_success_latency_ms?: number;
  last_error?: string;
  value: T;
};

const ROOT = process.cwd();
const WEATHER_TTL_MS = 10 * 60 * 1000;
const WEATHER_STALE_FALLBACK_MS = 60 * 60 * 1000;
const WEATHER_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const WEATHER_SIGNAL_PATH = path.join(ROOT, "runtime", "tool-state", "weather-snapshot.json");
const HOME_CONTEXT_PATH = path.join(ROOT, "runtime", "tool-state", "home-context.json");
let weatherRefreshTimer: NodeJS.Timeout | null = null;

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

async function readJsonFile<T>(fullPath: string): Promise<T> {
  return JSON.parse(await fs.readFile(fullPath, "utf8")) as T;
}

async function atomicWriteJson(fullPath: string, payload: unknown) {
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const tempPath = `${fullPath}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tempPath, fullPath);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function isFresh(expiresAt?: string) {
  if (!expiresAt) {
    return false;
  }

  return Date.now() <= new Date(expiresAt).getTime();
}

function isWithinStaleWindow(staleFallbackUntil?: string) {
  if (!staleFallbackUntil) {
    return false;
  }

  return Date.now() <= new Date(staleFallbackUntil).getTime();
}

function withDuration(startedAt: number) {
  return Date.now() - startedAt;
}

export async function readTimeNowSignal() {
  const homeContext = await readJsonFile<HomeContext>(HOME_CONTEXT_PATH);
  const now = new Date();
  const formatted = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone: homeContext.timezone
  }).format(now);

  return {
    key: "time_now",
    signal_mode: "immediate_local",
    source: "system_clock",
    fetched_at: now.toISOString(),
    signal_freshness: "fresh",
    value: {
      timestamp: now.toISOString(),
      timezone: homeContext.timezone,
      formatted_time: formatted,
      source: "system_clock"
    }
  } satisfies RuntimeSignalSnapshot<{
    timestamp: string;
    timezone: string;
    formatted_time: string;
    source: string;
  }>;
}

export async function readCurrentLocationSignal() {
  const fullPath = path.join(ROOT, "runtime", "tool-state", "current-location.json");
  const payload = await readJsonFile<CurrentLocationState>(fullPath);

  return {
    key: "current_location",
    signal_mode: "state_mirror",
    source: payload.source_label,
    fetched_at: payload.timestamp,
    signal_freshness: "fresh",
    value: payload
  } satisfies RuntimeSignalSnapshot<CurrentLocationState>;
}

export async function readHomeEnvironmentSignal() {
  const fullPath = path.join(ROOT, "runtime", "tool-state", "home-environment-status.json");
  const payload = await readJsonFile<HomeEnvironmentState>(fullPath);

  return {
    key: "home_environment_status",
    signal_mode: "state_mirror",
    source: payload.source,
    fetched_at: payload.timestamp,
    signal_freshness: "fresh",
    value: payload
  } satisfies RuntimeSignalSnapshot<HomeEnvironmentState>;
}

async function fetchWeatherSnapshot(
  signal?: AbortSignal
): Promise<RuntimeSignalSnapshot<WeatherSnapshotValue>> {
  const startedAt = Date.now();
  const homeContext = await readJsonFile<HomeContext>(HOME_CONTEXT_PATH);
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(homeContext.latitude));
  url.searchParams.set("longitude", String(homeContext.longitude));
  url.searchParams.set("current", "temperature_2m,relative_humidity_2m,weather_code,is_day");
  url.searchParams.set("timezone", homeContext.timezone);

  const response = await fetch(url.toString(), { signal });
  if (!response.ok) {
    throw new Error(`weather_signal_refresh failed with status ${response.status}`);
  }

  const data = (await response.json()) as {
    current?: {
      time?: string;
      temperature_2m?: number;
      relative_humidity_2m?: number;
      weather_code?: number;
      is_day?: number;
    };
  };

  if (!data.current) {
    throw new Error("weather_signal_refresh returned no current weather.");
  }

  const fetchedAt = new Date().toISOString();
  const snapshot = {
    key: "weather_lookup",
    signal_mode: "ttl_snapshot",
    source: "Open-Meteo",
    fetched_at: fetchedAt,
    expires_at: new Date(Date.now() + WEATHER_TTL_MS).toISOString(),
    stale_fallback_until: new Date(Date.now() + WEATHER_STALE_FALLBACK_MS).toISOString(),
    signal_freshness: "fresh",
    last_success_latency_ms: withDuration(startedAt),
    value: {
      city: homeContext.city,
      district: homeContext.district,
      condition: weatherCodeToText(
        Number(data.current.weather_code ?? -1),
        Number(data.current.is_day ?? 1)
      ),
      temperature_c: Number(data.current.temperature_2m ?? 0),
      humidity_pct: Number(data.current.relative_humidity_2m ?? 0),
      timestamp: data.current.time || fetchedAt,
      source: "Open-Meteo"
    }
  } satisfies RuntimeSignalSnapshot<WeatherSnapshotValue>;

  await atomicWriteJson(WEATHER_SIGNAL_PATH, snapshot);
  return snapshot;
}

async function readWeatherSnapshotFile() {
  try {
    return await readJsonFile<RuntimeSignalSnapshot<WeatherSnapshotValue>>(WEATHER_SIGNAL_PATH);
  } catch {
    return null;
  }
}

export async function readWeatherSignal(options?: {
  signal?: AbortSignal;
  forceRefresh?: boolean;
}): Promise<RuntimeSignalSnapshot<WeatherSnapshotValue>> {
  const cached = await readWeatherSnapshotFile();

  if (!options?.forceRefresh && cached && isFresh(cached.expires_at)) {
    return cached;
  }

  try {
    return await fetchWeatherSnapshot(options?.signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    if (cached && isWithinStaleWindow(cached.stale_fallback_until)) {
      return {
        ...cached,
        signal_freshness: "stale_fallback",
        last_error: error instanceof Error ? error.message : "unknown weather refresh error"
      } satisfies RuntimeSignalSnapshot<WeatherSnapshotValue>;
    }

    throw error;
  }
}

async function backgroundRefreshWeather() {
  try {
    await readWeatherSignal({ forceRefresh: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown weather refresh error";
    console.warn(`[teacher-pilot][runtime-signals][weather-refresh] ${message}`);
  }
}

export function initializeRuntimeSignals() {
  if (!weatherRefreshTimer) {
    weatherRefreshTimer = setInterval(() => {
      void backgroundRefreshWeather();
    }, WEATHER_REFRESH_INTERVAL_MS);

    void backgroundRefreshWeather();
  }
}
