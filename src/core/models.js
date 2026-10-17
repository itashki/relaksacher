/** @file Implementation of core/models. */
import { randomInt } from "node:crypto";

/**
 * Select uniformly per request, hiding signatures when only one model is active.
 * @param {import("../types.js").ModelConfig[]} models Nonempty model pool.
 * @param {function(number): number} [chooseIndex=randomInt] Injectable random index source.
 * @returns {function(): import("../types.js").ModelConfig} Model selector.
 * @throws {Error} When the model pool is empty.
 */
export function createModelSelector(models, chooseIndex = randomInt) {
  if (!models.length) throw new Error("At least one model is required");
  return () => {
    const selected = models[chooseIndex(models.length)];
    return models.length === 1 ? { ...selected, alias: undefined } : selected;
  };
}
