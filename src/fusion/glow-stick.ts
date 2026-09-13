import { hsvFromHex, hueDistance } from "../markers/color.js";
import { COCO_17_KEYPOINT_IDS } from "../pose/types.js";
import type { Coco17KeypointId } from "../pose/types.js";
import type { SynchronizedCameraSample } from "./types.js";

/** Left/right pairs whose labels MoveNet swaps when a person faces away. */
const MIRROR_PAIRS: ReadonlyArray<[Coco17KeypointId, Coco17KeypointId]> = [
  ["left_eye", "right_eye"],
  ["left_ear", "right_ear"],
  ["left_shoulder", "right_shoulder"],
  ["left_elbow", "right_elbow"],
  ["left_wrist", "right_wrist"],
  ["left_hip", "right_hip"],
  ["left_knee", "right_knee"],
  ["left_ankle", "right_ankle"],
];

const MIRROR_BY_ID = new Map<Coco17KeypointId, Coco17KeypointId>([
  ...MIRROR_PAIRS.map(([left, right]) => [left, right] as const),
  ...MIRROR_PAIRS.map(([left, right]) => [right, left] as const),
]);

export const DEFAULT_MARKER_KEYPOINT: Coco17KeypointId = "right_wrist";

export interface GlowStickAssignment {
  performerId: string;
  /** True when the color appeared on the mirror of the performer's keypoint. */
  mirrored: boolean;
  colorHex: string;
  coverage: number;
}

export interface GlowStickMatchOptions {
  /** Largest hue difference in degrees that still identifies a performer. */
  maxHueDistance: number;
  /** Coverage required before an observation identifies anybody. */
  minCoverage: number;
}

export const DEFAULT_GLOW_STICK_MATCH_OPTIONS: GlowStickMatchOptions = {
  maxHueDistance: 25,
  minCoverage: 0.08,
};

export function mirrorKeypointId(id: Coco17KeypointId): Coco17KeypointId {
  return MIRROR_BY_ID.get(id) ?? id;
}

/**
 * Performer palette taken from the Performance DSL, plus the keypoint each
 * performer carries the glow stick at. The DSL owns the colors; the carrying
 * hand is a fusion-side setting because it is not part of that contract.
 */
export class GlowStickPalette {
  private readonly colors = new Map<string, string>();
  private readonly keypoints = new Map<string, Coco17KeypointId>();

  public loadPerformers(
    performers: ReadonlyArray<{ performerId: string; glowStickColor: string }>,
  ): void {
    this.colors.clear();
    for (const performer of performers) {
      if (!hsvFromHex(performer.glowStickColor)) {
        throw new Error(
          `Performer ${performer.performerId} has an invalid glow stick color.`,
        );
      }
      this.colors.set(performer.performerId, performer.glowStickColor);
    }
    for (const performerId of [...this.keypoints.keys()]) {
      if (!this.colors.has(performerId)) this.keypoints.delete(performerId);
    }
  }

  public setKeypoint(performerId: string, keypointId: Coco17KeypointId): void {
    if (!this.colors.has(performerId)) {
      throw new Error(`Performer ${performerId} is not in the loaded palette.`);
    }
    this.keypoints.set(performerId, keypointId);
  }

  public keypointOf(performerId: string): Coco17KeypointId {
    return this.keypoints.get(performerId) ?? DEFAULT_MARKER_KEYPOINT;
  }

  public size(): number {
    return this.colors.size;
  }

  public clear(): void {
    this.colors.clear();
    this.keypoints.clear();
  }

  /** Performer whose color is closest to one observation, if any matches. */
  public match(
    colorHex: string,
    options: GlowStickMatchOptions,
  ): { performerId: string; distance: number } | undefined {
    const observed = hsvFromHex(colorHex);
    if (!observed) return undefined;
    let best: { performerId: string; distance: number } | undefined;
    for (const [performerId, performerColor] of this.colors) {
      const expected = hsvFromHex(performerColor);
      if (!expected) continue;
      const distance = hueDistance(observed.hue, expected.hue);
      if (distance > options.maxHueDistance) continue;
      if (!best || distance < best.distance) best = { performerId, distance };
    }
    return best;
  }

  /**
   * Assigns performers to the tracked persons of one camera sample. Each
   * performer takes at most one person per camera, strongest observation first,
   * and a color seen on the mirror of the performer's keypoint marks that view
   * as left/right swapped.
   */
  public assign(
    sample: SynchronizedCameraSample,
    options: GlowStickMatchOptions,
  ): Map<string, GlowStickAssignment> {
    const candidates: Array<{
      trackingId: string;
      performerId: string;
      keypointId: Coco17KeypointId;
      coverage: number;
      distance: number;
    }> = [];
    for (const person of sample.persons) {
      for (const marker of person.markers) {
        if (marker.coverage < options.minCoverage) continue;
        const matched = this.match(marker.colorHex, options);
        if (!matched) continue;
        candidates.push({
          trackingId: person.trackingId,
          performerId: matched.performerId,
          keypointId: marker.keypointId,
          coverage: marker.coverage,
          distance: matched.distance,
        });
      }
    }
    candidates.sort(
      (left, right) =>
        right.coverage - left.coverage || left.distance - right.distance,
    );

    const assignments = new Map<string, GlowStickAssignment>();
    const takenPerformers = new Set<string>();
    for (const candidate of candidates) {
      if (assignments.has(candidate.trackingId)) continue;
      if (takenPerformers.has(candidate.performerId)) continue;
      const expected = this.keypointOf(candidate.performerId);
      const mirrored =
        candidate.keypointId !== expected &&
        candidate.keypointId === mirrorKeypointId(expected);
      assignments.set(candidate.trackingId, {
        performerId: candidate.performerId,
        mirrored,
        colorHex: this.colors.get(candidate.performerId) ?? "",
        coverage: candidate.coverage,
      });
      takenPerformers.add(candidate.performerId);
    }
    return assignments;
  }
}

/** COCO-17 identifiers in their contract order, left/right labels swapped. */
export function mirroredKeypointOrder(): Coco17KeypointId[] {
  return COCO_17_KEYPOINT_IDS.map((id) => mirrorKeypointId(id));
}
