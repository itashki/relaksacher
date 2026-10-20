/** @file Resolve locations and retrieve bounded, local-time hourly Open-Meteo forecasts. */
import { fetchText } from "./web-fallback.ts";

type Place = {
  id: number;
  name: string;
  country?: string;
  population?: number;
  feature_code?: string;
  admin1?: string;
  latitude: number;
  longitude: number;
  timezone: string;
};

/** Model arguments use local calendar dates/hours; end is inclusive, dates cover whole days. */
export type WeatherRequest = {
  location: string;
  start: string;
  end?: string;
  location_id?: number;
};

const VARIABLES = [
  "temperature_2m",
  "apparent_temperature",
  "precipitation_probability",
  "precipitation",
  "weather_code",
  "wind_speed_10m",
];

/** Validate calendar input without silently normalizing impossible dates or hours. */
function boundary(value: string, end: boolean) {
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:00)?$/.test(value))
    throw new Error("Укажи дату YYYY-MM-DD или час YYYY-MM-DDTHH:00 по местному времени локации.");
  const hour = value.length === 10 ? `${value}T${end ? "23" : "00"}:00` : value;
  const parsed = new Date(`${hour}:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 16) !== hour)
    throw new Error("Некорректная дата или час.");
  return hour;
}

/** Create a forecast operation; ambiguous names prefer capitals/population unless an id is selected. */
export function createWeatherForecast(getText = fetchText) {
  return async ({ location, start, end, location_id }: WeatherRequest) => {
    const first = boundary(start, false);
    const last = boundary(end ?? start, true);
    if (last < first || Date.parse(last + "Z") - Date.parse(first + "Z") >= 16 * 86400000)
      throw new Error("Конец должен быть не раньше начала; период — не более 16 дней.");
    const query = String(location ?? "").trim();
    if (!query || query.length > 200) throw new Error("Укажи локацию длиной до 200 символов.");
    const geo = new URL("https://geocoding-api.open-meteo.com/v1/search");
    geo.search = new URLSearchParams({
      name: query,
      count: "5",
      language: "ru",
      format: "json",
    }).toString();
    const places: Place[] = JSON.parse(await getText(geo.href)).results ?? [];
    if (!places.length) throw new Error("Локация не найдена. Уточни город и страну.");
    // Prefer capitals, then larger settlements; stable ties preserve provider relevance.
    const ranked = [...places].sort(
      (a, b) =>
        Number(b.feature_code === "PPLC") - Number(a.feature_code === "PPLC") ||
        (b.population ?? 0) - (a.population ?? 0),
    );
    const place = location_id === undefined ? ranked[0] : places.find((p) => p.id === location_id);
    if (!place)
      throw new Error("Неизвестный location_id: используй id из результатов для этой локации.");
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      timezone: place.timezone,
      hourly: VARIABLES.join(","),
      forecast_days: "16",
      wind_speed_unit: "ms",
    }).toString();
    const data = JSON.parse(await getText(url.href));
    if (data.error) throw new Error(String(data.reason ?? "Прогноз недоступен."));
    const hourly = data.hourly as Record<string, (string | number | null)[]> | undefined;
    if (
      !Array.isArray(hourly?.time) ||
      !VARIABLES.every(
        (key) => Array.isArray(hourly[key]) && hourly[key].length === hourly.time.length,
      )
    )
      throw new Error("Сервис погоды вернул некорректный прогноз.");
    const hours = hourly.time.flatMap((time, index) =>
      typeof time === "string" && time >= first && time <= last
        ? [{ time, ...Object.fromEntries(VARIABLES.map((key) => [key, hourly[key][index]])) }]
        : [],
    );
    if (!hours.length || hours[0].time !== first || hours.at(-1)?.time !== last)
      throw new Error(
        "Запрошенный период недоступен целиком в почасовом прогнозе (до 16 дней вперёд). Уточни даты; не подменяй их доступными.",
      );
    if (
      hours.every((hour) =>
        VARIABLES.every((key) => (hour as Record<string, unknown>)[key] === null),
      )
    )
      throw new Error("Для выбранного периода нет данных прогноза.");
    return {
      source: "Open-Meteo",
      source_url: "https://open-meteo.com/",
      location: place,
      ...(places.length > 1
        ? {
            location_ambiguous: true,
            alternatives: ranked.filter((candidate) => candidate.id !== place.id),
            location_note:
              "Автоматически выбрано наиболее вероятное место: столица или крупнейший населённый пункт. Можно кратко упомянуть неоднозначность. Если пользователь указал другую страну или регион, выбери подходящий вариант из alternatives и повтори запрос с его location_id без лишнего уточнения.",
          }
        : {}),
      timezone: data.timezone,
      start: first,
      end: last,
      units: data.hourly_units,
      weather_code_standard: "WMO",
      hours,
      instruction:
        "Укажи место, даты, местное время и источник. null означает отсутствие данных, не ноль. Это почасовой прогноз, точность до минут не поддерживается.",
    };
  };
}
