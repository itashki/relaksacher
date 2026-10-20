/** @file Validate supported music URLs and normalize YouTube playlist links. */
/** Validate a bounded HTTPS media URL against supported music hosts.
 * @throws When the protocol, host, credentials, port or URL length is unsupported. */
export function musicUrl(input: string) {
  const url = new URL(input.replace(/^<|>$/g, ""));
  if (
    input.length > 500 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      /^[a-z0-9-]+\.bandcamp\.com$/.test(url.hostname) ||
      [
        "bandcamp.com",
        "audiomack.com",
        "www.audiomack.com",
        "music.yandex.ru",
        "music.yandex.com",
        "music.yandex.kz",
        "music.yandex.by",
        "youtube.com",
        "www.youtube.com",
        "m.youtube.com",
        "music.youtube.com",
        "youtu.be",
        "soundcloud.com",
        "www.soundcloud.com",
        "on.soundcloud.com",
      ].includes(url.hostname)
    )
  ) {
    throw new Error(
      "Нужна HTTPS-ссылка на YouTube, SoundCloud, Bandcamp, Audiomack или Яндекс Музыку.",
    );
  }
  return url.href;
}

/** Normalize YouTube URLs with a list parameter to a playlist URL, or return null for single tracks. */
export function youtubePlaylistUrl(input: string): string | null {
  const url = new URL(musicUrl(input));
  const id = url.searchParams.get("list");
  if (
    !["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(
      url.hostname,
    ) ||
    !id
  )
    return null;
  if (!/^[A-Za-z0-9_-]{2,150}$/.test(id))
    throw new Error("Некорректная ссылка на YouTube-плейлист.");
  return `https://www.youtube.com/playlist?list=${id}`;
}
