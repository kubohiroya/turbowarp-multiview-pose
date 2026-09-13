import type { AFramePublicBlockPort } from "./types.js";

export const AFRAME_CAPABILITY_KEY = "turbowarpAFrameCapability";

const METHODS = [
  "loadTemplate",
  "createFromTemplate",
  "setPosition",
  "setRotation",
  "emitEvent",
  "deleteSelector",
  "countSelector",
  "requireVersion",
] as const;

export function requireAFramePublicBlocks(
  runtime: TurboWarpRuntime,
): AFramePublicBlockPort {
  const candidate = runtime[AFRAME_CAPABILITY_KEY];
  if (typeof candidate !== "object" || candidate === null) {
    throw new Error(
      "TurboWarp-A-Frame capability v1 must be loaded before avatar retargeting.",
    );
  }
  for (const method of METHODS) {
    if (typeof Reflect.get(candidate, method) !== "function") {
      throw new Error(
        `TurboWarp-A-Frame capability v1 is missing ${method}().`,
      );
    }
  }
  const capability = candidate as AFramePublicBlockPort;
  if (capability.version !== 1) {
    throw new Error(
      `TurboWarp-A-Frame capability v1 is required; found version ${String(capability.version)}.`,
    );
  }
  return capability.requireVersion(1);
}
