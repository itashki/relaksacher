# Shared speech-model downloads for the package and development shell.
# Fixed hashes verify upstream bytes; Nix owns storage and garbage collection.
{ fetchurl }:
{
  gigaam = fetchurl {
    name = "v3_e2e_rnnt.ckpt";
    url = "https://cdn.chatwm.opensmodel.sberdevices.ru/GigaAM/v3_e2e_rnnt.ckpt";
    hash = "sha256-9gxi/kWQLZZwAHcKEvJg3nxaxNS45ehS8d+MVI45WLU=";
  };
  gigaamTokenizer = fetchurl {
    name = "v3_e2e_rnnt_tokenizer.model";
    url = "https://cdn.chatwm.opensmodel.sberdevices.ru/GigaAM/v3_e2e_rnnt_tokenizer.model";
    hash = "sha256-gowSyZEBnu+VKpYGYfJaktatJ5WR4upGa0rt3x0goYo=";
  };
  whisper = fetchurl {
    name = "ggml-large-v3.bin";
    url = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin";
    hash = "sha256-ZNGCtEC5jVIDxPm9VBVE2ExgUZbE97hF36EfsjWU0eI=";
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
