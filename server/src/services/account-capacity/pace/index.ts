import { linearPaceModel } from "./linear.js";
import type { PaceModel } from "./model.js";

export type { PaceInput, PaceModel, PaceResult } from "./model.js";

const MODELS = new Map<string, PaceModel>([[linearPaceModel.id, linearPaceModel]]);

export function registerPaceModel(model: PaceModel) {
  MODELS.set(model.id, model);
}

export function paceModelIds(): string[] {
  return [...MODELS.keys()];
}

/** Unknown ids fall back to the linear model rather than failing a run. */
export function getPaceModel(id: string): PaceModel {
  return MODELS.get(id) ?? linearPaceModel;
}
