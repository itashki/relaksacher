/** @file Compact operator telemetry with a day-aware uptime and per-feature request totals. */
import { requestFeatures, type RequestStatistics } from "../../core/statistics.ts";

const labels = {
  model: "Модель",
  roll: "Кубы",
  music: "Музыка",
  voice: "Голос",
  tts: "Озвучка",
  transcribe: "Расшифровка",
  access: "Доступ",
};

/** Format monotonic elapsed time as [days] HH:MM:SS, without wrapping at 24 hours. */
export function formatUptime(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(seconds / 86400);
  const clock = [Math.floor(seconds / 3600) % 24, Math.floor(seconds / 60) % 60, seconds % 60]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  return `${days ? `${days}д ` : ""}${clock}`;
}

/** Return plain text lines; the dashboard owns wrapping and available screen space. */
export function statisticsLines(statistics: RequestStatistics) {
  return [
    ` Аптайм: ${formatUptime(statistics.uptimeMs)} · Запросы: ${statistics.total}`,
    ` ${requestFeatures.map((feature) => `${labels[feature]}: ${statistics.counts[feature]}`).join(" · ")}`,
  ];
}
