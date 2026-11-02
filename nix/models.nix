# Shared speech-model downloads for the package and development shell.
# Fixed hashes verify upstream bytes; Nix owns storage and garbage collection.
{ fetchurl }:
{
  whisper = fetchurl {
    name = "ggml-large-v3-turbo.bin";
    url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin";
    hash = "sha256-H8cPd0046xaZk6w5Huo1fvR8iHV+9y7llDh5t+jivGk=";
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
