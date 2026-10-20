/** @file Process-lifetime request counters shared across replaceable application runtimes. */
export const requestFeatures = [
  "model",
  "roll",
  "music",
  "voice",
  "tts",
  "transcribe",
  "access",
] as const;
export type RequestFeature = (typeof requestFeatures)[number];
/** Record one user request, including failed attempts; internal model/tool calls are excluded. */
export type RecordRequest = (
  feature: RequestFeature,
  context?: import("./request-log.ts").RequestContext,
) => void;
export type RequestStatistics = {
  uptimeMs: number;
  total: number;
  counts: Record<RequestFeature, number>;
};
/** Read-only telemetry; each snapshot owns its counter object. */
export type StatisticsSource = { snapshot: () => RequestStatistics };

/** Create counters owned by the persistent host; the injected monotonic clock returns process uptime. */
export function createStatistics(
  now = () => performance.now(),
): StatisticsSource & { record: RecordRequest } {
  const counts: Record<RequestFeature, number> = {
    model: 0,
    roll: 0,
    music: 0,
    voice: 0,
    tts: 0,
    transcribe: 0,
    access: 0,
  };
  let total = 0;
  return {
    record(feature) {
      counts[feature]++;
      total++;
    },
    snapshot() {
      return { uptimeMs: Math.max(0, now()), total, counts: { ...counts } };
    },
  };
}
