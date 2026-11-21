import { config } from "./config.js";
import type { Episode, Series } from "./types.js";

const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Страница ролика по ссылке — для показа потенциальным клиентам: вертикальный плеер,
 * название серии и кнопка «Хочу такой сериал». С PUBLIC_BASE_URL у ссылки есть превью
 * в WhatsApp и Telegram (Open Graph: кадр, название, видео).
 */
export function renderWatchPage(ep: Episode, series: Series, urls: { video: string; poster?: string }): string {
  const base = config.server.publicBaseUrl;
  const abs = (u?: string) => (u && base ? `${base}${u.startsWith("/") ? "" : "/"}${u}` : u);
  const title = ep.script?.title ?? series.title;
  const description = ep.idea?.logline ?? series.logline;
  const og = base
    ? `<meta property="og:type" content="video.other">
<meta property="og:title" content="${esc(title)} — ${esc(series.title)}">
<meta property="og:description" content="${esc(description)}">
${urls.poster ? `<meta property="og:image" content="${esc(abs(urls.poster))}">` : ""}
<meta property="og:video" content="${esc(abs(urls.video))}">
<meta property="og:video:type" content="video/mp4">
<meta property="og:video:width" content="1080">
<meta property="og:video:height" content="1920">`
    : "";
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="same-origin">
<title>${esc(title)} — ${esc(series.title)}</title>
${og}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Onest:wght@600;700&family=Golos+Text:wght@400;500;600&display=swap">
<style>
:root { color-scheme: dark; --bg: #0B0D12; --surface: #12151C; --line: #262B37; --ink: #E9ECF3; --muted: #9098AB; --accent: #5B8CFF; --accent-ink: #06122E; --saffron: #F2B544; --saffron-soft: rgba(242, 181, 68, .14); }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { color-scheme: light; --bg: #F3F4F8; --surface: #FFFFFF; --line: #E0E4EC; --ink: #121622; --muted: #586074; --accent: #2F5BEA; --accent-ink: #FFFFFF; --saffron: #A15F00; --saffron-soft: rgba(214, 137, 16, .14); } }
:root[data-theme="light"] { color-scheme: light; --bg: #F3F4F8; --surface: #FFFFFF; --line: #E0E4EC; --ink: #121622; --muted: #586074; --accent: #2F5BEA; --accent-ink: #FFFFFF; --saffron: #A15F00; --saffron-soft: rgba(214, 137, 16, .14); }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100dvh; background: var(--bg); color: var(--ink); font: 16px/1.55 "Golos Text", system-ui, -apple-system, "Segoe UI", sans-serif; display: grid; place-items: center; padding: 20px 16px 32px; }
main { width: min(960px, 100%); display: grid; gap: 28px; align-items: center; }
@media (min-width: 820px) { main { grid-template-columns: 340px minmax(0, 1fr); } }
.phone { justify-self: center; width: min(340px, 86vw); aspect-ratio: 9 / 16; background: #0A0F1A; border-radius: 34px; padding: 8px; box-shadow: 0 12px 32px rgba(18, 26, 43, .18); }
video { width: 100%; height: 100%; border-radius: 27px; object-fit: cover; background: #0A0F1A; display: block; }
.kicker { display: inline-block; background: var(--saffron-soft); color: var(--saffron); font-weight: 700; font-size: 13px; padding: 5px 12px; border-radius: 99px; }
h1 { font: 700 clamp(26px, 4vw, 40px)/1.12 "Onest", "Golos Text", sans-serif; letter-spacing: -.015em; margin: 14px 0 10px; text-wrap: balance; }
p { margin: 0 0 12px; color: var(--muted); max-width: 52ch; }
.cta { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
.btn { display: inline-flex; align-items: center; justify-content: center; border-radius: 12px; padding: 12px 18px; font-weight: 700; text-decoration: none; border: 1px solid var(--line); color: var(--ink); background: var(--surface); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
small { color: var(--muted); display: block; margin-top: 18px; font-size: 13px; }
</style>
</head>
<body>
<main>
  <div class="phone"><video src="${esc(urls.video)}" ${urls.poster ? `poster="${esc(urls.poster)}"` : ""} controls playsinline preload="metadata"></video></div>
  <div>
    <span class="kicker">${esc(series.title)}</span>
    <h1>${esc(title)}</h1>
    <p>${esc(description)}</p>
    <p>Такую серию AI-студия делает для вашего бренда каждый день: свой маскот, ваш язык и юмор, ваши акции. Вы только нажимаете «Одобрить».</p>
    <div class="cta"><a class="btn primary" href="/#order">Хочу такой сериал</a><a class="btn" href="/#plans">Тарифы</a></div>
    <small>🤖 Ролик создан с помощью искусственного интеллекта · AI-студия</small>
  </div>
</main>
</body>
</html>`;
}
