/** @file Standalone build probe that must work without external package files. */
import { checkDiscordAudio } from "../../src/adapters/discord/audio-check.ts";

await checkDiscordAudio();
console.log("Standalone DAVE and Opus encoding OK");
