import { randomInt } from "node:crypto";

export function createModelSelector(models, chooseIndex = randomInt) {
  if (!models.length) throw new Error("At least one model is required");
  return () => {
    const selected = models[chooseIndex(models.length)];
    return models.length === 1 ? { ...selected, alias: undefined } : selected;
  };
}
