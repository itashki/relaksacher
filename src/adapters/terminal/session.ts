/** @file Operator view state retained by the host when terminal code is reloaded. */
import { createNavigation, type Navigation } from "./scroll.ts";
import { createSearch, type SearchState } from "./search.ts";

/** Mutable view state shared only between successive terminal instances, never concurrently. */
export type TerminalSession = { logs: string[]; navigation: Navigation; search: SearchState };

/** Start one operator session; rebuilding the UI reuses its logs and navigation. */
export function createTerminalSession(): TerminalSession {
  return { logs: [], navigation: createNavigation(), search: createSearch() };
}
