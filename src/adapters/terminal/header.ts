/** @file Fit operator controls and their mouse regions into the dashboard header. */
type Region = { x: number; y: number; width: number; height: number };

/** Clip controls to terminal width, keeping restart on the right and pause beside it. */
export function dashboardHeader(width: number, restarting?: boolean, paused?: boolean) {
  let remaining = width;
  let controls = "";
  const button = (label: string): Region => {
    const clipped = Bun.sliceAnsi(label, 0, remaining);
    const size = Bun.stringWidth(clipped);
    const region = { x: remaining - size + 1, y: 1, width: size, height: 1 };
    controls = clipped + controls;
    remaining -= size;
    if (remaining > 0) {
      controls = " " + controls;
      remaining--;
    }
    return region;
  };
  const restartRegion =
    restarting === undefined ? undefined : button(restarting ? "[Рестарт…]" : "[R Рестарт]");
  const pauseRegion =
    paused === undefined ? undefined : button(paused ? "[P Включить ИИ]" : "[P Пауза ИИ]");
  const title = Bun.sliceAnsi(" РЕЛАКСАЧЕР / операторская панель", 0, remaining);
  return {
    restartRegion,
    pauseRegion,
    header: title + " ".repeat(remaining - Bun.stringWidth(title)) + controls,
  };
}
