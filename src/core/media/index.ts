/** @file Media-description facade combining the image and video describers. */
import type { VideoDescriptionResult } from "./video-description.ts";

/** Platform-neutral description service handed to adapters. */
export type MediaDescriber = {
  /** Describe a base64 image through the shared model queue; never call it from a session or tool. */
  describeImage(base64: string, question?: string): Promise<string>;
  /** Describe a video lazily loaded by `load`; rejects with "Описание видео недоступно." when unavailable. */
  describeVideo(load: () => Promise<Blob>, prompt?: string): Promise<VideoDescriptionResult>;
  /** Whether the video backend is ready. */
  videoAvailable(): boolean;
};

/** Compose an image describer and an optional video describer into one `MediaDescriber`. */
export function createMediaDescriber({
  image,
  video,
}: {
  image: { describeImage(base64: string, question?: string): Promise<string> };
  video?: {
    available(): boolean;
    describe(load: () => Promise<Blob>, prompt?: string): Promise<VideoDescriptionResult>;
  };
}): MediaDescriber {
  return {
    describeImage: (base64, question) => image.describeImage(base64, question),
    describeVideo(load, prompt) {
      if (!video?.available()) return Promise.reject(new Error("Описание видео недоступно."));
      return video.describe(load, prompt);
    },
    videoAvailable: () => Boolean(video?.available()),
  };
}
