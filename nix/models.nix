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
  # HuggingFaceTB/SmolVLM2-500M-Video-Instruct pinned to a fixed commit, one file each.
  smolvlm2 = {
    "added_tokens.json" = fetchurl {
      name = "smolvlm2-added_tokens.json";
      url = "https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct/resolve/4cde9d208e19519c36917aa170fffc7e381aa0ad/added_tokens.json";
      hash = "sha256-dBNbhmS1YIjAAG8cjoSNeajroANBH3Lr8dwu6WInvjo=";
    };
    "chat_template.json" = fetchurl {
      name = "smolvlm2-chat_template.json";
      url = "https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct/resolve/4cde9d208e19519c36917aa170fffc7e381aa0ad/chat_template.json";
      hash = "sha256-m8Tza40GT4JDaGSEcqSgkmjEu/m/kw8E+uR/H1ltrpI=";
    };
    "config.json" = fetchurl {
      name = "smolvlm2-config.json";
      url = "https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct/resolve/4cde9d208e19519c36917aa170fffc7e381aa0ad/config.json";
      hash = "sha256-6mvBI36WJH9iWN4+IC4uYrk9bzhtxH57NrVYi/OhXhc=";
    };
    "generation_config.json" = fetchurl {
      name = "smolvlm2-generation_config.json";
      url = "https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct/resolve/4cde9d208e19519c36917aa170fffc7e381aa0ad/generation_config.json";
      hash = "sha256-NINQYMnw900ay0VsxyyjJ0bThD2etfV4+cv/rB0uuEA=";
    };
    "merges.txt" = fetchurl {
      name = "smolvlm2-merges.txt";
      url = "https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct/resolve/4cde9d208e19519c36917aa170fffc7e381aa0ad/merges.txt";
      hash = "sha256-C1Toqk5T1Tg+LkvGNaVrQ/lkf3sTgy1dns2PgtrE9RA=";
    };
    "model.safetensors" = fetchurl {
      name = "smolvlm2-model.safetensors";
      url = "https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct/resolve/4cde9d208e19519c36917aa170fffc7e381aa0ad/model.safetensors";
      hash = "sha256-ub/UVslHLArNVxnW5RTEuFmJGvIF7hpzZVL9NJe4sMM=";
    };
    "preprocessor_config.json" = fetchurl {
      name = "smolvlm2-preprocessor_config.json";
      url = "https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct/resolve/4cde9d208e19519c36917aa170fffc7e381aa0ad/preprocessor_config.json";
      hash = "sha256-FJ4xXZQQNo5UkUVbsG4PdjQm6eVsynMcE7JEBKKbY3Q=";
    };
    "processor_config.json" = fetchurl {
      name = "smolvlm2-processor_config.json";
      url = "https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct/resolve/4cde9d208e19519c36917aa170fffc7e381aa0ad/processor_config.json";
      hash = "sha256-861FAoRHs1YrR1K+DVkW1oBsHvWJCRpGlgjc8Pqhc3w=";
    };
    "special_tokens_map.json" = fetchurl {
      name = "smolvlm2-special_tokens_map.json";
      url = "https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct/resolve/4cde9d208e19519c36917aa170fffc7e381aa0ad/special_tokens_map.json";
      hash = "sha256-Lf6ipCYWIxb/FWfIK8bTbZaQzZ+QRV8HXHfayni0XGA=";
    };
    "tokenizer.json" = fetchurl {
      name = "smolvlm2-tokenizer.json";
      url = "https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct/resolve/4cde9d208e19519c36917aa170fffc7e381aa0ad/tokenizer.json";
      hash = "sha256-Xs54HcjSsvPi8onKCuULF8/CfdJ7/nlxu4JB4LlkMxo=";
    };
    "tokenizer_config.json" = fetchurl {
      name = "smolvlm2-tokenizer_config.json";
      url = "https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct/resolve/4cde9d208e19519c36917aa170fffc7e381aa0ad/tokenizer_config.json";
      hash = "sha256-iyYuwqy3dzyqx7Hlnt+SFnHNtMfIFanHFCQlQNP8tTE=";
    };
    "vocab.json" = fetchurl {
      name = "smolvlm2-vocab.json";
      url = "https://huggingface.co/HuggingFaceTB/SmolVLM2-500M-Video-Instruct/resolve/4cde9d208e19519c36917aa170fffc7e381aa0ad/vocab.json";
      hash = "sha256-grhAEuOt1NAdEroURCAm5JuMu66tH3ns89kZeE+C3Hk=";
    };
  };
}
