/** @file Assemble guild music runtime, command dispatch and interactive controls. */
import { createMusicRuntime } from "./runtime.ts";
import { createMusicCommandHandler } from "./command-handler.ts";
import { createMusicInteractionHandler } from "./interactions.ts";
export { musicUrl, youtubePlaylistUrl } from "../../music/url.ts";
export { loadYouTubePlaylist } from "../../music/youtube-playlist.ts";
export { searchMusic, type MusicSearchResult } from "../../music/search.ts";

/** Create persistent guild music controls without starting voice or network connections. */
export function createDiscordMusic(
  directory: string,
  options: Parameters<typeof createMusicRuntime>[1] = {},
) {
  const runtime = createMusicRuntime(directory, options);
  const handle = createMusicCommandHandler(runtime);
  return {
    handle,
    handleInteraction: createMusicInteractionHandler(runtime, handle),
    stop: runtime.stop,
  };
}
