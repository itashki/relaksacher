/** @file Media-description facade combining the image and video describers. */
import type { VideoDescriptionResult } from "./video-description.ts";

/** Platform-neutral description service handed to adapters. */
export type MediaDescriber = {
  /** Describe a base64 image through the shared model queue; never call it from a session or tool. */
  describeImage(base64: string, question?: string): Promise<string>;
  /**
   * Describe a video lazily loaded by `load`; rejects with "Описание видео недоступно." when unavailable.
   * The description is translated to Russian through the shared model queue unless
   * `options.translate` is false; pass false from inside a running session or tool, where the
   * queue is held and translating would deadlock (the English text is then returned as is).
   */
  describeVideo(
    load: () => Promise<Blob>,
    prompt?: string,
    options?: { translate?: boolean },
  ): Promise<VideoDescriptionResult>;
  /** Whether the video backend is ready. */
  videoAvailable(): boolean;
};

/** Compose an image describer and an optional video describer into one `MediaDescriber`.
 * With `translator`, SmolVLM2's English text is translated to Russian and `model` becomes
 * `SmolVLM2+<text model>`. A translation failure is logged as a warning and the English
 * description is kept, so a description is never dropped. */
export function createMediaDescriber({
  image,
  video,
  translator,
}: {
  image: { describeImage(base64: string, question?: string): Promise<string> };
  video?: {
    available(): boolean;
    describe(load: () => Promise<Blob>, prompt?: string): Promise<VideoDescriptionResult>;
  };
  translator?: { model: string; toRussian(text: string): Promise<string> };
}): MediaDescriber {
  return {
    describeImage: (base64, question) => image.describeImage(base64, question),
    async describeVideo(load, prompt, options) {
      if (!video?.available()) throw new Error("Описание видео недоступно.");
      const result = await video.describe(load, prompt);
      if (!translator || options?.translate === false) return result;
      try {
        const description = await translator.toRussian(result.description);
        return {
          ...result,
          description,
          model:
            description === result.description
              ? result.model
              : `${result.model}+${translator.model}`,
        };
      } catch (error) {
        console.warn(
          "Video description translation failed, keeping English:",
          error instanceof Error ? error.message : error,
        );
        return result;
      }
    },
    videoAvailable: () => Boolean(video?.available()),
  };
}
