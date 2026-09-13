import { describe, expect, it } from "vitest";
import { hsvFromHex, hueDistance } from "../src/markers/color.js";
import {
  dominantSaturatedColor,
  markerPatchesFor,
  parseKeypointIds,
  toMarkers,
} from "../src/markers/sampler.js";
import { DEFAULT_MARKER_SAMPLING_OPTIONS } from "../src/markers/types.js";
import { COCO_17_KEYPOINT_IDS } from "../src/pose/types.js";
import type { ModelPose } from "../src/pose/types.js";

const options = DEFAULT_MARKER_SAMPLING_OPTIONS;

/** Builds an RGBA patch where `share` of the pixels carry one color. */
function patch(
  total: number,
  share: number,
  color: [number, number, number],
  background: [number, number, number] = [90, 88, 86],
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(total * 4);
  const colored = Math.round(total * share);
  for (let index = 0; index < total; index += 1) {
    const [r, g, b] = index < colored ? color : background;
    pixels[index * 4] = r;
    pixels[index * 4 + 1] = g;
    pixels[index * 4 + 2] = b;
    pixels[index * 4 + 3] = 255;
  }
  return pixels;
}

function pose(scale: number): ModelPose {
  return {
    id: 1,
    score: 0.9,
    keypoints: COCO_17_KEYPOINT_IDS.map((name, index) => ({
      name,
      x:
        name === "left_shoulder"
          ? 0
          : name === "right_shoulder"
            ? scale
            : index,
      y: 100 + index,
      score: 0.9,
    })),
  };
}

describe("glow stick sampling", () => {
  it("reports the dominant saturated color of a patch", () => {
    const sampled = dominantSaturatedColor(
      patch(400, 0.35, [0, 255, 170]),
      options,
    );
    expect(sampled).toBeDefined();
    expect(sampled?.coverage).toBeCloseTo(0.35, 2);
    const observed = hsvFromHex(sampled?.colorHex ?? "");
    const expected = hsvFromHex("#00FFAA");
    expect(observed && expected).toBeTruthy();
    expect(hueDistance(observed?.hue ?? 0, expected?.hue ?? 0)).toBeLessThan(3);
  });

  it("ignores dull scenes and patches below the coverage threshold", () => {
    expect(
      dominantSaturatedColor(patch(400, 1, [120, 118, 116]), options),
    ).toBeUndefined();
    expect(
      dominantSaturatedColor(patch(400, 0.02, [255, 40, 0]), options),
    ).toBeUndefined();
    expect(
      dominantSaturatedColor(new Uint8ClampedArray(), options),
    ).toBeUndefined();
  });

  it("averages a wrapping red hue instead of landing on cyan", () => {
    const pixels = new Uint8ClampedArray(8 * 4);
    for (let index = 0; index < 8; index += 1) {
      // Alternates just above and just below hue 0.
      const [r, g, b] = index % 2 === 0 ? [255, 10, 0] : [255, 0, 10];
      pixels[index * 4] = r;
      pixels[index * 4 + 1] = g;
      pixels[index * 4 + 2] = b;
      pixels[index * 4 + 3] = 255;
    }
    const sampled = dominantSaturatedColor(pixels, options);
    const observed = hsvFromHex(sampled?.colorHex ?? "");
    expect(hueDistance(observed?.hue ?? 180, 0)).toBeLessThan(5);
  });

  it("scales the sampled patch with the person and clamps it", () => {
    const wide = markerPatchesFor(pose(200), options);
    const narrow = markerPatchesFor(pose(10), options);
    expect(wide.map(({ keypointId }) => keypointId)).toEqual([
      "right_wrist",
      "left_wrist",
    ]);
    expect(wide[0]?.patch.radius).toBe(56);
    expect(narrow[0]?.patch.radius).toBe(6);
  });

  it("keeps the strongest observation per keypoint and caps the contract limit", () => {
    const markers = toMarkers([
      {
        keypointId: "right_wrist",
        color: { colorHex: "#00FFAA", coverage: 0.2 },
      },
      {
        keypointId: "right_wrist",
        color: { colorHex: "#FF0000", coverage: 0.6 },
      },
      { keypointId: "left_wrist", color: undefined },
      {
        keypointId: "left_elbow",
        color: { colorHex: "#0000FF", coverage: 0.1 },
      },
    ]);
    expect(markers).toEqual([
      { keypointId: "right_wrist", colorHex: "#FF0000", coverage: 0.6 },
      { keypointId: "left_elbow", colorHex: "#0000FF", coverage: 0.1 },
    ]);
    const many = toMarkers(
      COCO_17_KEYPOINT_IDS.map((keypointId, index) => ({
        keypointId,
        color: { colorHex: "#00FF00", coverage: (index + 1) / 20 },
      })),
    );
    expect(many.length).toBe(4);
  });

  it("validates the requested keypoint list", () => {
    expect(parseKeypointIds(" right_wrist , left_wrist ")).toEqual([
      "right_wrist",
      "left_wrist",
    ]);
    expect(parseKeypointIds("right_wrist,right_wrist")).toEqual([
      "right_wrist",
    ]);
    expect(() => parseKeypointIds("")).toThrow(/at least one/u);
    expect(() => parseKeypointIds("right_hand")).toThrow(/Unknown COCO-17/u);
  });
});
