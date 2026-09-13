import { describe, expect, it, vi } from "vitest";
import {
  KalidokitPoseAdapter,
  type KalidokitPoseApi,
} from "../src/avatar/kalidokit-adapter.js";
import type {
  KalidokitPoseRig,
  PoseFrame2DPerson,
  PoseFrame3DPerson,
} from "../src/avatar/types.js";
import { COCO_17_KEYPOINT_IDS } from "../src/pose/types.js";

describe("KalidokitPoseAdapter", () => {
  it("adapts corresponding COCO-17 world and screen landmarks to BlazePose-33", () => {
    const solve = vi.fn<KalidokitPoseApi["solve"]>(() => rig());
    const adapter = new KalidokitPoseAdapter({ solve });
    const result = adapter.solve(worldPerson(), screenPerson(), {
      width: 1920,
      height: 1080,
    });
    expect(result).toEqual(rig());
    const [world, screen, options] = solve.mock.calls[0]!;
    expect(world).toHaveLength(33);
    expect(screen).toHaveLength(33);
    expect(world[0]).toMatchObject({ x: 0, y: 1, z: 2, score: 0.9 });
    expect(world[1]).toEqual(world[2]);
    expect(world[11]).toMatchObject({ x: 5, y: 6, z: 7 });
    expect(world[17]?.score).toBeCloseTo(0.225);
    expect(world[29]?.score).toBeCloseTo(0.225);
    expect(screen[11]).toMatchObject({ x: 150, y: 225, z: 0 });
    expect(options).toEqual({
      runtime: "tfjs",
      imageSize: { width: 1920, height: 1080 },
      enableLegs: true,
    });
  });

  it("rejects missing, degenerate, and unsupported solver output explicitly", () => {
    const adapter = new KalidokitPoseAdapter({
      solve: vi.fn<KalidokitPoseApi["solve"]>(() => rig()),
    });
    const missing = worldPerson();
    missing.keypoints.pop();
    expect(() =>
      adapter.solve(missing, screenPerson(), { width: 1920, height: 1080 }),
    ).toThrow(/Missing world COCO-17 landmark/u);

    const degenerate = worldPerson();
    for (const point of degenerate.keypoints) {
      point.x = 0;
      point.y = 0;
      point.z = 0;
    }
    expect(() =>
      adapter.solve(degenerate, screenPerson(), { width: 1920, height: 1080 }),
    ).toThrow(/degenerate world pose/u);

    const empty = new KalidokitPoseAdapter({
      solve: vi.fn<KalidokitPoseApi["solve"]>(() => undefined),
    });
    expect(() =>
      empty.solve(worldPerson(), screenPerson(), { width: 1920, height: 1080 }),
    ).toThrow(/returned no rig/u);
  });
});

function worldPerson(): PoseFrame3DPerson {
  return {
    personId: "performer-1",
    score: 0.9,
    keypoints: COCO_17_KEYPOINT_IDS.map((id, index) => ({
      id,
      x: index,
      y: index + 1,
      z: index + 2,
      score: 0.9,
    })),
  };
}

function screenPerson(): PoseFrame2DPerson {
  return {
    trackingId: "performer-1",
    score: 0.9,
    keypoints: COCO_17_KEYPOINT_IDS.map((id, index) => ({
      id,
      x: 100 + index * 10,
      y: 200 + index * 5,
      score: 0.9,
    })),
  };
}

function rig(): KalidokitPoseRig {
  const rotation = { x: 0.1, y: 0.2, z: 0.3 };
  return {
    RightUpperArm: rotation,
    RightLowerArm: rotation,
    LeftUpperArm: rotation,
    LeftLowerArm: rotation,
    RightHand: rotation,
    LeftHand: rotation,
    RightUpperLeg: rotation,
    RightLowerLeg: rotation,
    LeftUpperLeg: rotation,
    LeftLowerLeg: rotation,
    Spine: rotation,
    Hips: { position: rotation, worldPosition: rotation, rotation },
  };
}
