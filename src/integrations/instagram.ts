import { config } from "../config.js";

/** Аккаунт Instagram: у студии свой (IG_USER_ID/IG_ACCESS_TOKEN), у каждого клиента — свой в кабинете. */
export interface IgAccount {
  userId: string;
  token: string;
}

/** Аккаунт студии из настроек, если он задан. */
export function studioInstagram(): IgAccount | undefined {
  const { userId, token } = config.instagram;
  return userId && token ? { userId, token } : undefined;
}

export function instagramEnabled(): boolean {
  return studioInstagram() !== undefined;
}

function graphUrl(account: IgAccount, pathname: string, params: Record<string, string> = {}): string {
  const url = new URL(`https://${config.instagram.graphHost}/${config.instagram.graphVersion}/${pathname}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("access_token", account.token);
  return url.toString();
}

async function graph<T>(account: IgAccount, method: "GET" | "POST", pathname: string, params: Record<string, string> = {}): Promise<T> {
  const res = await fetch(graphUrl(account, pathname, params), { method, signal: AbortSignal.timeout(60_000) });
  const data = (await res.json()) as T & { error?: { message?: string; code?: number } };
  if (!res.ok || data.error) {
    throw new Error(`Instagram ${pathname}: ${data.error?.message ?? res.status}`);
  }
  return data;
}

/**
 * Публикация Reels в три шага: контейнер по ссылке на видео → ждём обработку → публикуем.
 * Instagram сам скачивает видео по videoUrl, поэтому ссылка должна быть публичной.
 */
export async function publishReel(account: IgAccount, videoUrl: string, caption: string): Promise<{ mediaId: string; permalink?: string }> {
  const { userId } = account;
  const container = await graph<{ id: string }>(account, "POST", `${userId}/media`, {
    media_type: "REELS",
    video_url: videoUrl,
    caption,
    share_to_feed: "true",
  });

  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("Instagram слишком долго обрабатывает видео");
    await new Promise((r) => setTimeout(r, 5000));
    const status = await graph<{ status_code?: string; status?: string }>(account, "GET", container.id, { fields: "status_code,status" });
    if (status.status_code === "FINISHED") break;
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new Error(`Instagram не принял видео: ${status.status ?? status.status_code}`);
    }
  }

  const published = await graph<{ id: string }>(account, "POST", `${userId}/media_publish`, { creation_id: container.id });
  const info = await graph<{ permalink?: string }>(account, "GET", published.id, { fields: "permalink" }).catch(() => ({ permalink: undefined }));
  return { mediaId: published.id, permalink: info.permalink };
}

interface InsightsResponse {
  data: { name: string; values?: { value: number }[]; total_value?: { value: number } }[];
}

function parseInsights(body: InsightsResponse): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of body.data) {
    const value = item.total_value?.value ?? item.values?.[0]?.value;
    if (typeof value === "number") out[item.name] = value;
  }
  return out;
}

/** Метрики ролика. Если какую-то метрику API не отдаёт, она пропускается, остальные собираются. */
export async function mediaInsights(account: IgAccount, mediaId: string, metrics = config.instagram.insightMetrics): Promise<Record<string, number>> {
  const list = metrics.split(",").map((m) => m.trim()).filter(Boolean);
  try {
    return parseInsights(await graph<InsightsResponse>(account, "GET", `${mediaId}/insights`, { metric: list.join(",") }));
  } catch {
    const out: Record<string, number> = {};
    for (const metric of list) {
      try {
        Object.assign(out, parseInsights(await graph<InsightsResponse>(account, "GET", `${mediaId}/insights`, { metric })));
      } catch {
        // Метрика недоступна для этого ролика или версии API — пропускаем.
      }
    }
    return out;
  }
}
