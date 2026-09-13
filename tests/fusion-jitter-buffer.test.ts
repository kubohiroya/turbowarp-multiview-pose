import { describe, expect, it } from "vitest";
import {
  MultiCameraJitterBuffer,
  PoseFrameRingBuffer,
  type JitterBufferOptions,
} from "../src/fusion/jitter-buffer.js";
import { COCO_17_KEYPOINT_IDS } from "../src/pose/types.js";
import type { PoseFrame2DPersonV1 } from "../src/pose/types.js";
import { poseFrame2D } from "./fusion-fixtures.js";

const options: JitterBufferOptions = {
  capacityPerCamera: 8,
  jitterWindowUs: 100_000,
  maxHoldUs: 50_000,
  maxGapUs: 120_000,
  minKeypointScore: 0.3,
};

function person(
  trackingId: string,
  x: number,
  y: number,
  overrides: Partial<Record<string, number>> = {},
): PoseFrame2DPersonV1 {
  return {
    trackingId,
    score: 0.8,
    keypoints: COCO_17_KEYPOINT_IDS.map((id) => ({
      id,
      x,
      y,
      score: overrides[id] ?? 0.9,
    })),
  };
}

function timestamps(buffer: PoseFrameRingBuffer): number[] {
  return Array.from(
    { length: buffer.size() },
    (_, index) => buffer.at(index)?.captureTimestampUs ?? -1,
  );
}

describe("PoseFrameRingBuffer", () => {
  it("keeps frames in timestamp order regardless of arrival order", () => {
    const buffer = new PoseFrameRingBuffer(8);
    for (const timestamp of [300_000, 220_000, 280_000, 250_000]) {
      expect(
        buffer.insert(poseFrame2D("camera-1", timestamp, []), 100_000),
      ).toBe("accepted");
    }
    expect(timestamps(buffer)).toEqual([220_000, 250_000, 280_000, 300_000]);
  });

  it("rejects duplicates and arrivals past the jitter window", () => {
    const buffer = new PoseFrameRingBuffer(8);
    buffer.insert(poseFrame2D("camera-1", 500_000, []), 100_000);
    expect(buffer.insert(poseFrame2D("camera-1", 500_000, []), 100_000)).toBe(
      "duplicate",
    );
    expect(buffer.insert(poseFrame2D("camera-1", 440_000, []), 100_000)).toBe(
      "accepted",
    );
    expect(buffer.insert(poseFrame2D("camera-1", 399_999, []), 100_000)).toBe(
      "late",
    );
    expect(timestamps(buffer)).toEqual([440_000, 500_000]);
  });

  it("evicts the oldest frame when the ring is full", () => {
    const buffer = new PoseFrameRingBuffer(4);
    for (const timestamp of [10, 20, 30, 40, 50]) {
      buffer.insert(poseFrame2D("camera-1", timestamp, []), 1_000);
    }
    expect(timestamps(buffer)).toEqual([20, 30, 40, 50]);

    // A full ring still accepts an in-window reorder by dropping the oldest.
    expect(buffer.insert(poseFrame2D("camera-1", 35, []), 1_000)).toBe(
      "accepted",
    );
    expect(timestamps(buffer)).toEqual([30, 35, 40, 50]);
    expect(buffer.insert(poseFrame2D("camera-1", 25, []), 1_000)).toBe("late");
  });

  it("interpolates keypoints between the bracketing frames", () => {
    const buffer = new PoseFrameRingBuffer(8);
    buffer.insert(
      poseFrame2D("camera-1", 100_000, [person("movenet-1", 100, 200)]),
      100_000,
    );
    buffer.insert(
      poseFrame2D("camera-1", 140_000, [person("movenet-1", 140, 240)]),
      100_000,
    );
    const sample = buffer.sampleAt(130_000, options);
    expect(sample?.interpolated).toBe(true);
    expect(sample?.alpha).toBeCloseTo(0.75, 9);
    const keypoint = sample?.persons[0]?.keypoints[0];
    expect(keypoint?.x).toBeCloseTo(130, 9);
    expect(keypoint?.y).toBeCloseTo(230, 9);
  });

  it("fills an occluded keypoint from the visible side of the bracket", () => {
    const buffer = new PoseFrameRingBuffer(8);
    buffer.insert(
      poseFrame2D("camera-1", 100_000, [person("movenet-1", 100, 200)]),
      100_000,
    );
    buffer.insert(
      poseFrame2D("camera-1", 140_000, [
        person("movenet-1", 140, 240, { nose: 0.05 }),
      ]),
      100_000,
    );
    const sample = buffer.sampleAt(120_000, options);
    const nose = sample?.persons[0]?.keypoints[0];
    expect(nose?.id).toBe("nose");
    expect(nose?.x).toBeCloseTo(100, 9);
    expect(nose?.score).toBeCloseTo(0.9, 9);
    expect(nose?.filled).toBe(true);
    const leftEye = sample?.persons[0]?.keypoints[1];
    expect(leftEye?.x).toBeCloseTo(120, 9);
  });

  it("returns an exact frame without interpolation and holds only briefly", () => {
    const buffer = new PoseFrameRingBuffer(8);
    buffer.insert(
      poseFrame2D("camera-1", 100_000, [person("movenet-1", 100, 200)]),
      100_000,
    );
    const exact = buffer.sampleAt(100_000, options);
    expect(exact?.interpolated).toBe(false);
    expect(exact?.persons[0]?.keypoints[0]?.x).toBe(100);

    expect(buffer.sampleAt(140_000, options)?.interpolated).toBe(true);
    expect(buffer.sampleAt(160_000, options)).toBeUndefined();
  });

  it("holds the nearer frame instead of interpolating across a long gap", () => {
    const buffer = new PoseFrameRingBuffer(8);
    buffer.insert(
      poseFrame2D("camera-1", 100_000, [person("movenet-1", 100, 200)]),
      1_000_000,
    );
    buffer.insert(
      poseFrame2D("camera-1", 500_000, [person("movenet-1", 500, 600)]),
      1_000_000,
    );
    const held = buffer.sampleAt(130_000, options);
    expect(held?.persons[0]?.keypoints[0]?.x).toBe(100);
    expect(held?.interpolated).toBe(true);
    expect(buffer.sampleAt(300_000, options)).toBeUndefined();
  });
});

describe("MultiCameraJitterBuffer", () => {
  it("resamples every camera at one shared past instant", () => {
    const buffer = new MultiCameraJitterBuffer(options);
    buffer.ingest(
      poseFrame2D("camera-1", 100_000, [person("movenet-1", 100, 100)]),
    );
    buffer.ingest(
      poseFrame2D("camera-1", 140_000, [person("movenet-1", 140, 140)]),
    );
    // camera-2 samples the same motion on a shifted capture phase.
    buffer.ingest(
      poseFrame2D("camera-2", 110_000, [person("movenet-7", 210, 210)]),
    );
    buffer.ingest(
      poseFrame2D("camera-2", 150_000, [person("movenet-7", 250, 250)]),
    );
    const sample = buffer.sampleAt(130_000);
    expect(sample.cameras.map((camera) => camera.cameraId)).toEqual([
      "camera-1",
      "camera-2",
    ]);
    expect(sample.cameras[0]?.persons[0]?.keypoints[0]?.x).toBeCloseTo(130, 9);
    expect(sample.cameras[1]?.persons[0]?.keypoints[0]?.x).toBeCloseTo(230, 9);
    expect(buffer.bufferedFrameCount()).toBe(4);
    expect(buffer.newestTimestampUs()).toBe(150_000);
    expect(buffer.droppedFrameCount()).toBe(0);
  });

  it("counts dropped frames and clears every camera", () => {
    const buffer = new MultiCameraJitterBuffer(options);
    buffer.ingest(poseFrame2D("camera-1", 500_000, []));
    buffer.ingest(poseFrame2D("camera-1", 500_000, []));
    buffer.ingest(poseFrame2D("camera-1", 100_000, []));
    expect(buffer.acceptedFrameCount()).toBe(1);
    expect(buffer.droppedFrameCount()).toBe(2);
    buffer.clear();
    expect(buffer.bufferedFrameCount()).toBe(0);
    expect(buffer.cameraIds()).toEqual([]);
    expect(buffer.sampleAt(500_000).cameras).toEqual([]);
  });
});
