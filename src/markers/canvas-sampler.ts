import { dominantSaturatedColor } from "./sampler.js";
import type {
  MarkerFrame,
  MarkerImageSamplerPort,
  MarkerPatch,
  MarkerSamplingOptions,
  SampledColor,
} from "./types.js";

/**
 * Copies the current video frame into one temporary canvas and reads each patch
 * from it. The canvas is released after every call, like the calibration
 * backend does, so no frame data outlives the sampling request.
 */
export class CanvasGlowStickSampler implements MarkerImageSamplerPort {
  public readonly name = "canvas-2d";

  public constructor(
    private readonly options: Pick<
      MarkerSamplingOptions,
      "minSaturation" | "minValue" | "minCoverage"
    >,
  ) {}

  public sample(
    frame: MarkerFrame,
    patches: readonly MarkerPatch[],
  ): Array<SampledColor | undefined> {
    if (patches.length === 0) return [];
    const canvas = document.createElement("canvas");
    canvas.width = frame.width;
    canvas.height = frame.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("A 2D canvas context is unavailable.");
    try {
      context.drawImage(frame.element, 0, 0, frame.width, frame.height);
      return patches.map((patch) => {
        const left = Math.max(Math.round(patch.x - patch.radius), 0);
        const top = Math.max(Math.round(patch.y - patch.radius), 0);
        const right = Math.min(Math.round(patch.x + patch.radius), frame.width);
        const bottom = Math.min(
          Math.round(patch.y + patch.radius),
          frame.height,
        );
        if (right - left < 1 || bottom - top < 1) return undefined;
        const image = context.getImageData(
          left,
          top,
          right - left,
          bottom - top,
        );
        return dominantSaturatedColor(image.data, this.options);
      });
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}
