/** @file Offline smoke check for the native DAVE binding and Discord PCM-to-Opus encoding. */
import { createAudioResource, StreamType } from "@discordjs/voice";
import { Readable } from "node:stream";

/** Load DAVE and encode one silent PCM frame; throw if packaged audio dependencies are broken. */
export async function checkDiscordAudio(): Promise<void> {
  const davey = await import("@snazzah/davey");
  if (!davey.DAVE_PROTOCOL_VERSION) throw new Error("DAVE native binding unavailable");
  const resource = createAudioResource(Readable.from([Buffer.alloc(3840)]), {
    inputType: StreamType.Raw,
  });
  let bytes = 0;
  for await (const chunk of resource.playStream) bytes += chunk.length;
  if (!bytes) throw new Error("Opus encoder produced no audio");
}
