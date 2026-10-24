# Shared speech-model downloads for the package and development shell.
# Fixed hashes verify upstream bytes; Nix owns storage and garbage collection.
{ fetchurl }:
{
  whisper = fetchurl {
    name = "ggml-small.bin";
    url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin";
    hash = "sha256-G+OpsgY4Z7k35k4ux0gzZKeZF+FX+pjF2UtcH//qmHs=";
  };
  sileroRu = fetchurl {
    name = "silero-v5_6_ru.pt";
    url = "https://models.silero.ai/models/tts/ru/v5_6_ru.pt";
    hash = "sha256-BMybHQjOOLyqnQLEiNgNPmgG0X9+qnyVmC82o8v1Cy4=";
  };
  sileroEn = fetchurl {
    name = "silero-v3_en.pt";
    url = "https://models.silero.ai/models/tts/en/v3_en.pt";
    hash = "sha256-ArcQNNnxO8QAEZUBe6ydsca7YRXgP+pSmD6KvP8TtmU=";
  };
}
