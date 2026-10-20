/** @file Exercise forecast intervals, location ambiguity and provider failures without network access. */
import { expect, test } from "bun:test";
import { createWeatherForecast } from "../src/core/weather.ts";
import { createToolService } from "./fixtures.ts";

const place = { id: 1, name: "Test", timezone: "Europe/Berlin", latitude: 52, longitude: 13 };
const variables = [
  "temperature_2m",
  "apparent_temperature",
  "precipitation_probability",
  "precipitation",
  "weather_code",
  "wind_speed_10m",
];
function setup(
  places: Array<typeof place & { country?: string; population?: number; feature_code?: string }> = [
    place,
  ],
  missing = false,
) {
  const urls: URL[] = [];
  const forecast = createWeatherForecast(async (address) => {
    const url = new URL(address);
    urls.push(url);
    if (url.hostname.startsWith("geocoding")) return JSON.stringify({ results: places });
    const time = Array.from(
      { length: 48 },
      (_, i) => `2026-10-${i < 24 ? "20" : "21"}T${String(i % 24).padStart(2, "0")}:00`,
    );
    return JSON.stringify({
      timezone: place.timezone,
      hourly_units: { temperature_2m: "°C" },
      hourly: {
        time,
        ...Object.fromEntries(variables.map((key) => [key, time.map(() => (missing ? null : 12))])),
      },
    });
  });
  return { forecast, urls };
}

test("selects one hour, full days and inclusive cross-day intervals in location time", async () => {
  const { forecast, urls } = setup();
  const hour = await forecast({ location: "Test", start: "2026-10-20T18:00" });
  expect(hour.hours).toHaveLength(1);
  expect(hour.timezone).toBe(place.timezone);
  expect((await forecast({ location: "Test", start: "2026-10-20" })).hours).toHaveLength(24);
  expect(
    (await forecast({ location: "Test", start: "2026-10-20T22:00", end: "2026-10-21T02:00" }))
      .hours,
  ).toHaveLength(5);
  expect(urls[1].searchParams.get("timezone")).toBe(place.timezone);
  expect(urls[1].searchParams.get("wind_speed_unit")).toBe("ms");
});

test("selects the likely city automatically and preserves explicit selection", async () => {
  const { forecast, urls } = setup([place, { ...place, id: 2 }]);
  const request = { location: "Test", start: "2026-10-20" };
  const result = await forecast(request);
  expect(result.location.id).toBe(1);
  expect(result.location_ambiguous).toBe(true);
  expect(result.alternatives?.map((p) => p.id)).toEqual([2]);
  expect(urls).toHaveLength(2);
  expect((await forecast({ ...request, location_id: 2 })).location.id).toBe(2);
  await expect(forecast({ ...request, location_id: 3 })).rejects.toThrow("location_id");
});

test("prefers Russian Volgograd and the French capital over namesake villages", async () => {
  for (const [name, country, feature_code] of [
    ["Волгоград", "Россия", "PPLA"],
    ["Париж", "Франция", "PPLC"],
  ]) {
    const village = {
      ...place,
      name,
      country: "Другая страна",
      population: 1000,
      feature_code: "PPL",
    };
    const city = { ...place, id: 2, name, country, population: 1000000, feature_code };
    // Put the namesake village first to ensure provider ordering does not decide.
    const { forecast } = setup([village, city]);
    expect((await forecast({ location: name, start: "2026-10-20" })).location.country).toBe(
      country,
    );
    expect(
      (await forecast({ location: name, start: "2026-10-20", location_id: 1 })).location.country,
    ).toBe("Другая страна");
  }
});

test("rejects invalid inputs, unavailable periods, empty locations and missing data", async () => {
  const { forecast } = setup();
  for (const start of [
    "2026-02-30",
    "2026-10-20T25:00",
    "tomorrow",
    "2026-10-20T12:30",
    "2026-11-01",
  ])
    await expect(forecast({ location: "Test", start })).rejects.toThrow();
  await expect(
    forecast({ location: "Test", start: "2026-10-21", end: "2026-10-20" }),
  ).rejects.toThrow();
  await expect(
    forecast({ location: "Test", start: "2026-10-20", end: "2026-11-20" }),
  ).rejects.toThrow();
  await expect(setup([]).forecast({ location: "Test", start: "2026-10-20" })).rejects.toThrow(
    "не найдена",
  );
  await expect(
    setup([place], true).forecast({ location: "Test", start: "2026-10-20" }),
  ).rejects.toThrow("нет данных");
});

test("tool is available without web search credentials and surfaces network errors", async () => {
  const service = createToolService({
    memory: {},
    fallbackClient: null,
    weatherForecast: async () => {
      throw new Error("provider unavailable");
    },
  });
  expect(service.definitions({}).map((t) => t.function.name)).toContain("weather_forecast");
  expect(
    await service.runTool(
      {
        function: {
          name: "weather_forecast",
          arguments: { location: "Test", start: "2026-10-20" },
        },
      },
      {},
    ),
  ).toContain("provider unavailable");
});
