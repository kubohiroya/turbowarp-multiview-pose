import { hexFromRgb, rgbToHsv } from "./color.js";
import type {
  MarkerPatch,
  MarkerSamplingOptions,
  SampledColor,
} from "./types.js";
import { COCO_17_KEYPOINT_IDS } from "../pose/types.js";
import type {
  Coco17KeypointId,
  ModelPose,
  PoseMarkerV2,
} from "../pose/types.js";

const MIN_PATCH_RADIUS = 6;
const MAX_PATCH_RADIUS = 64;
const PATCH_SCALE = 0.28;

/**
 * Dominant saturated color of one RGBA patch. Unsaturated pixels are skipped so
 * a glow stick wins over skin, clothing, and the venue background; the hue is a
 * circular mean, which keeps a wrapping red cluster near red.
 */
export function dominantSaturatedColor(
  pixels: Uint8ClampedArray,
  options: Pick<
    MarkerSamplingOptions,
    "minSaturation" | "minValue" | "minCoverage"
  >,
): SampledColor | undefined {
  const total = Math.floor(pixels.length / 4);
  if (total === 0) return undefined;
  let qualifying = 0;
  let hueX = 0;
  let hueY = 0;
  let saturation = 0;
  let value = 0;
  for (let index = 0; index < total; index += 1) {
    const red = pixels[index * 4] ?? 0;
    const green = pixels[index * 4 + 1] ?? 0;
    const blue = pixels[index * 4 + 2] ?? 0;
    const hsv = rgbToHsv(red, green, blue);
    if (hsv.saturation < options.minSaturation) continue;
    if (hsv.value < options.minValue) continue;
    const radians = (hsv.hue * Math.PI) / 180;
    hueX += Math.cos(radians);
    hueY += Math.sin(radians);
    saturation += hsv.saturation;
    value += hsv.value;
    qualifying += 1;
  }
  const coverage = qualifying / total;
  if (qualifying === 0 || coverage < options.minCoverage) return undefined;
  const hue =
    (Math.atan2(hueY / qualifying, hueX / qualifying) * 180) / Math.PI;
  return {
    colorHex: hexFromHsv(
      (hue + 360) % 360,
      saturation / qualifying,
      value / qualifying,
    ),
    coverage: Math.min(coverage, 1),
  };
}

/** Patch to sample for one keypoint, scaled by the person's own size. */
export function markerPatchesFor(
  pose: ModelPose,
  options: MarkerSamplingOptions,
): Array<{ keypointId: Coco17KeypointId; patch: MarkerPatch }> {
  const byName = new Map(
    pose.keypoints.map((keypoint) => [keypoint.name, keypoint]),
  );
  const radius = patchRadius(pose);
  const patches: Array<{ keypointId: Coco17KeypointId; patch: MarkerPatch }> =
    [];
  for (const keypointId of options.keypointIds) {
    const keypoint = byName.get(keypointId);
    if (!keypoint || (keypoint.score ?? 0) < options.minKeypointScore) continue;
    if (!Number.isFinite(keypoint.x) || !Number.isFinite(keypoint.y)) continue;
    patches.push({
      keypointId,
      patch: { x: keypoint.x, y: keypoint.y, radius },
    });
  }
  return patches;
}

/** Keeps the strongest observation per keypoint, bounded by the v2 contract. */
export function toMarkers(
  samples: ReadonlyArray<{
    keypointId: Coco17KeypointId;
    color: SampledColor | undefined;
  }>,
): PoseMarkerV2[] {
  const strongest = new Map<Coco17KeypointId, PoseMarkerV2>();
  for (const { keypointId, color } of samples) {
    if (!color) continue;
    const existing = strongest.get(keypointId);
    if (existing && existing.coverage >= color.coverage) continue;
    strongest.set(keypointId, {
      keypointId,
      colorHex: color.colorHex,
      coverage: round(color.coverage),
    });
  }
  return [...strongest.values()]
    .sort(
      (left, right) =>
        right.coverage - left.coverage ||
        COCO_17_KEYPOINT_IDS.indexOf(left.keypointId) -
          COCO_17_KEYPOINT_IDS.indexOf(right.keypointId),
    )
    .slice(0, 4);
}

export function parseKeypointIds(value: string): Coco17KeypointId[] {
  const requested = value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (requested.length === 0) {
    throw new Error("Name at least one COCO-17 keypoint to sample.");
  }
  const keypointIds: Coco17KeypointId[] = [];
  for (const entry of requested) {
    const keypointId = COCO_17_KEYPOINT_IDS.find((id) => id === entry);
    if (!keypointId) throw new Error(`Unknown COCO-17 keypoint: ${entry}`);
    if (!keypointIds.includes(keypointId)) keypointIds.push(keypointId);
  }
  return keypointIds;
}

function patchRadius(pose: ModelPose): number {
  const byName = new Map(
    pose.keypoints.map((keypoint) => [keypoint.name, keypoint]),
  );
  const leftShoulder = byName.get("left_shoulder");
  const rightShoulder = byName.get("right_shoulder");
  let scale = 0;
  if (leftShoulder && rightShoulder) {
    scale = Math.hypot(
      leftShoulder.x - rightShoulder.x,
      leftShoulder.y - rightShoulder.y,
    );
  }
  if (scale === 0) {
    const xs = pose.keypoints.map((keypoint) => keypoint.x);
    const ys = pose.keypoints.map((keypoint) => keypoint.y);
    scale = Math.max(
      Math.max(...xs) - Math.min(...xs),
      Math.max(...ys) - Math.min(...ys),
    );
  }
  const radius = Math.round(scale * PATCH_SCALE);
  return Math.min(Math.max(radius, MIN_PATCH_RADIUS), MAX_PATCH_RADIUS);
}

function hexFromHsv(hue: number, saturation: number, value: number): string {
  const chroma = value * saturation;
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = value - chroma;
  const [red, green, blue] = rgbFromSector(hue, chroma, secondary);
  return hexFromRgb(
    (red + match) * 255,
    (green + match) * 255,
    (blue + match) * 255,
  );
}

function rgbFromSector(
  hue: number,
  chroma: number,
  secondary: number,
): [number, number, number] {
  if (hue < 60) return [chroma, secondary, 0];
  if (hue < 120) return [secondary, chroma, 0];
  if (hue < 180) return [0, chroma, secondary];
  if (hue < 240) return [0, secondary, chroma];
  if (hue < 300) return [secondary, 0, chroma];
  return [chroma, 0, secondary];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
