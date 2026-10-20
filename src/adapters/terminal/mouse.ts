/** @file Decode terminal mouse reports before forwarding remaining bytes to the keyboard parser. */
import type { PanelId } from "./scroll.ts";

/** Terminal cells use one-based coordinates, including panel borders. */
export type PanelRegion = { id: PanelId; x: number; y: number; width: number; height: number };
/** Supported mouse actions; releases, dragging and horizontal wheels are ignored. */
export type MouseAction = { kind: "click" | "up" | "down"; x: number; y: number };
/** Enable button/wheel reporting with SGR coordinates while the dashboard owns the terminal. */
export const enableMouse = "\x1b[?1000h\x1b[?1006h";
/** Release the mouse before leaving the alternate screen. */
export const disableMouse = "\x1b[?1000l\x1b[?1006l";

/** Find the visible panel beneath a terminal cell; headers and footer are not panels. */
export function panelAt(regions: PanelRegion[], x: number, y: number) {
  return regions.find(
    (region) =>
      x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height,
  )?.id;
}

/**
 * Separate SGR and legacy X10 reports from keyboard input, even across read boundaries.
 * Limit incomplete reports and discard malformed mouse packets so coordinates cannot
 * become keyboard shortcuts. A short timer releases a standalone Escape key.
 */
export function createMouseDecoder(
  onMouse: (event: MouseAction) => void,
  onKeyboard: (data: Uint8Array) => void,
) {
  let pending = new Uint8Array(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const emit = (button: number, x: number, y: number, released = false) => {
    if (
      released ||
      x < 1 ||
      y < 1 ||
      x > 65535 ||
      y > 65535 ||
      button > 127 ||
      button < 0 ||
      button & 32
    )
      return;
    if (button & 64) {
      if ((button & 3) <= 1) onMouse({ kind: button & 1 ? "down" : "up", x, y });
    } else if ((button & 3) === 0) onMouse({ kind: "click", x, y });
  };
  return {
    /** Consume raw stdin bytes, preserving UTF-8 keyboard data without decoding/re-encoding it. */
    write(data: Uint8Array | string) {
      if (closed) return;
      clearTimeout(timer);
      pending = new Uint8Array(
        Bun.concatArrayBuffers([pending, typeof data === "string" ? encoder.encode(data) : data]),
      );
      while (pending.length) {
        if (pending[0] !== 27) {
          const next = pending.indexOf(27);
          const count = next < 0 ? pending.length : next;
          onKeyboard(pending.slice(0, count));
          pending = pending.slice(count);
          continue;
        }
        if (pending.length === 1 || (pending[1] === 91 && pending.length === 2)) break;
        if (pending[1] === 91 && pending[2] === 77) {
          if (pending.length < 6) break;
          emit(pending[3] - 32, pending[4] - 32, pending[5] - 32);
          pending = pending.slice(6);
          continue;
        }
        if (pending[1] === 91 && pending[2] === 60) {
          let end = 3;
          while (
            end < pending.length &&
            pending[end] !== 77 &&
            pending[end] !== 109 &&
            pending[end] !== 27
          )
            end++;
          if (end === pending.length && pending.length <= 64) break;
          const packet = decoder.decode(pending.subarray(3, end));
          const match = packet.match(/^(\d{1,5});(\d{1,5});(\d{1,5})$/);
          if (match && end < pending.length && pending[end] !== 27)
            emit(Number(match[1]), Number(match[2]), Number(match[3]), pending[end] === 109);
          pending = pending.slice(end + (end < pending.length && pending[end] !== 27 ? 1 : 0));
          continue;
        }
        onKeyboard(pending.slice(0, 1));
        pending = pending.slice(1);
      }
      if (pending.length) {
        timer = setTimeout(() => {
          // Only incomplete Escape/CSI keyboard prefixes may be passed through.
          if (pending.length <= 2) onKeyboard(pending);
          pending = new Uint8Array(0);
        }, 100);
        timer.unref?.();
      }
    },
    /** Cancel incomplete reports without emitting late key or mouse events after teardown. */
    close() {
      closed = true;
      clearTimeout(timer);
      pending = new Uint8Array(0);
    },
  };
}
