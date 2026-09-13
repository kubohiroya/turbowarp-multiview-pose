import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { AvatarRetargetController } from "../src/avatar/controller.js";
import { AFRAME_CAPABILITY_KEY } from "../src/avatar/aframe-port.js";
import { COCO_17_KEYPOINT_IDS } from "../src/pose/types.js";
import type { KalidokitPoseRig } from "../src/avatar/types.js";

function mockCapability() {
  const nodes = new Set<string>();
  const capability = {
    version: 1,
    requireVersion: vi.fn(function (this: unknown, version: number) {
      if (version !== 1) throw new Error("unsupported A-Frame capability");
      return this;
    }),
    loadTemplate: vi.fn(),
    createFromTemplate: vi.fn((_template: string, instance: string) => {
      nodes.add(instance);
      nodes.add(`${instance}-left-upper-arm`);
      nodes.add(`${instance}-right-upper-arm`);
    }),
    setPosition: vi.fn(),
    setRotation: vi.fn(),
    emitEvent: vi.fn(),
    deleteSelector: vi.fn((selector: string) => {
      const id = selector.replace(/^#/u, "");
      for (const node of [...nodes]) {
        if (node === id || node.startsWith(`${id}-`)) nodes.delete(node);
      }
    }),
    countSelector: vi.fn((selector: string) =>
      nodes.has(selector.replace(/^#/u, "")) ? 1 : 0,
    ),
  };
  const runtime: TurboWarpRuntime = { [AFRAME_CAPABILITY_KEY]: capability };
  return { capability, nodes, runtime };
}

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`fixtures/avatar/${name}`, import.meta.url), "utf8");
}

async function configured() {
  const context = mockCapability();
  const poseSolver = { solve: vi.fn(() => solvedRig()) };
  const controller = new AvatarRetargetController(context.runtime, poseSolver);
  controller.registerAsset(
    "actor",
    await fixture("template.json"),
    await fixture("rig.json"),
  );
  return { ...context, controller, poseSolver };
}

describe("AvatarRetargetController", () => {
  it("uses only the versioned A-Frame v1 capability and applies root and bone transforms", async () => {
    const { capability, controller } = await configured();
    controller.bind("performer-1", "avatar-1", "actor", "#scene", 0.3);
    applyFrame(controller, [person("performer-1")]);
    expect(capability.requireVersion).toHaveBeenCalledWith(1);
    expect(capability.loadTemplate).toHaveBeenCalledWith(
      "twmp-avatar-actor",
      expect.stringContaining('"type": "group"'),
    );
    expect(capability.createFromTemplate).toHaveBeenCalledWith(
      "twmp-avatar-actor",
      "avatar-1",
      "#scene",
    );
    expect(capability.setPosition).toHaveBeenCalledWith("#avatar-1", 3, 4, 5);
    expect(capability.setRotation).toHaveBeenCalledWith(
      "#avatar-1-left-upper-arm",
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );
    expect(capability.emitEvent).toHaveBeenCalledWith(
      "actor-recognition-start",
      "#avatar-1",
      JSON.stringify({
        personId: "performer-1",
        avatarInstanceId: "avatar-1",
        timestampUs: 9_007_199_254_740_000,
      }),
    );
    expect(controller.updatedCount()).toBe(1);
    expect(controller.state()).toBe("ready");
  });

  it("skips low-confidence bones and emits recognition end without blocking another person", async () => {
    const { capability, controller } = await configured();
    controller.bind("performer-1", "avatar-1", "actor", "#scene", 0.5);
    controller.bind("performer-2", "avatar-2", "actor", "#scene", 0.5);
    const first = person("performer-1");
    first.keypoints[5]!.score = 0.1;
    applyFrame(controller, [first, person("performer-2")]);
    expect(capability.setRotation).not.toHaveBeenCalledWith(
      "#avatar-1-left-upper-arm",
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    );
    expect(controller.updatedCount()).toBe(2);

    applyFrame(controller, [person("performer-2")]);
    expect(capability.emitEvent).toHaveBeenCalledWith(
      "actor-recognition-end",
      "#avatar-1",
      expect.any(String),
    );
    expect(controller.updatedCount()).toBe(1);
  });

  it("isolates per-person A-Frame failures and detects scene-reset bindings", async () => {
    const { capability, controller, nodes } = await configured();
    controller.bind("performer-1", "avatar-1", "actor", "#scene", 0.3);
    controller.bind("performer-2", "avatar-2", "actor", "#scene", 0.3);
    capability.setRotation.mockImplementation((selector: string) => {
      if (selector.includes("avatar-1")) throw new Error("bad rig node");
    });
    applyFrame(controller, [person("performer-1"), person("performer-2")]);
    expect(controller.updatedCount()).toBe(1);
    expect(controller.state()).toBe("partial");
    expect(controller.error()).toMatch(/performer-1: bad rig node/u);

    nodes.clear();
    applyFrame(controller, [person("performer-1"), person("performer-2")]);
    expect(controller.bindingCount()).toBe(0);
    expect(controller.error()).toMatch(/scene reset/u);
  });

  it("rejects invalid rigs, frames, duplicate instances, and more than six bindings", async () => {
    const { controller } = await configured();
    expect(() =>
      controller.registerAsset(
        "bad",
        "{}",
        '{"bones":[{"selector":"#{avatar}-x","rig":"UnknownRig"}]}',
      ),
    ).toThrow(/supported Kalidokit/u);
    expect(() => controller.apply("{}", "{}")).toThrow(
      /Invalid PoseFrame3D v1/u,
    );
    for (let index = 0; index < 6; index += 1) {
      controller.bind(
        `performer-${index}`,
        `avatar-${index}`,
        "actor",
        "#scene",
        0.3,
      );
    }
    expect(() =>
      controller.bind("performer-6", "avatar-6", "actor", "#scene", 0.3),
    ).toThrow(/at most six/u);
    expect(() =>
      controller.bind("different", "avatar-0", "actor", "#scene", 0.3),
    ).toThrow(/already bound/u);
  });

  it("cleans recognition state and created instances on reset", async () => {
    const { capability, controller } = await configured();
    controller.bind("performer-1", "avatar-1", "actor", "#scene", 0.3);
    applyFrame(controller, [person("performer-1")]);
    controller.bind("performer-1", "avatar-2", "actor", "#scene", 0.3);
    expect(capability.deleteSelector).toHaveBeenCalledWith("#avatar-1");
    expect(controller.bindingCount()).toBe(1);
    applyFrame(controller, [person("performer-1")]);
    controller.reset();
    expect(capability.emitEvent).toHaveBeenLastCalledWith(
      "actor-recognition-end",
      "#avatar-2",
      expect.any(String),
    );
    expect(capability.deleteSelector).toHaveBeenCalledWith("#avatar-2");
    expect(controller.bindingCount()).toBe(0);
    expect(controller.state()).toBe("idle");
  });

  it("fails closed without A-Frame capability v1", async () => {
    const controller = new AvatarRetargetController({});
    const template = await fixture("template.json");
    const rig = await fixture("rig.json");
    expect(() => controller.registerAsset("actor", template, rig)).toThrow(
      /capability/u,
    );

    const wrongVersion = mockCapability();
    Object.defineProperty(wrongVersion.capability, "version", { value: 2 });
    const incompatible = new AvatarRetargetController(wrongVersion.runtime);
    expect(() => incompatible.registerAsset("actor", template, rig)).toThrow(
      /v1 is required; found version 2/u,
    );
  });
});

function frame(persons: ReturnType<typeof person>[]): string {
  return JSON.stringify({
    schema: "twmp/pose-frame-3d",
    version: 1,
    sequence: 7,
    timestampUs: 9_007_199_254_740_000,
    persons,
  });
}

function applyFrame(
  controller: AvatarRetargetController,
  people: ReturnType<typeof person>[],
): void {
  controller.apply(
    frame(people),
    frame2d(people.map(({ personId }) => person2d(personId))),
  );
}

function person(personId: string) {
  const keypoints = COCO_17_KEYPOINT_IDS.map((id) => ({
    id,
    x: 1,
    y: 1,
    z: 1,
    score: 0.9,
  }));
  keypoints[5] = { ...keypoints[5]!, x: 0, y: 0, z: 0 };
  keypoints[7] = { ...keypoints[7]!, x: 0, y: 1, z: 0 };
  keypoints[11] = { ...keypoints[11]!, x: 0, y: 1, z: 1 };
  keypoints[12] = { ...keypoints[12]!, x: 2, y: 1, z: 1 };
  return {
    personId,
    score: 0.9,
    cameraIds: ["camera-1", "camera-2"],
    meanReprojectionErrorPx: 1,
    keypoints,
  };
}

function frame2d(persons: ReturnType<typeof person2d>[]): string {
  return JSON.stringify({
    schema: "twmp/pose-frame-2d",
    version: 1,
    cameraId: "camera-1",
    peerId: "source-1",
    sequence: 7,
    captureTimestampUs: 9_007_199_254_740_000,
    frameWidth: 1920,
    frameHeight: 1080,
    calibrationId: "calibration-1",
    persons,
  });
}

function person2d(trackingId: string) {
  return {
    trackingId,
    score: 0.9,
    keypoints: COCO_17_KEYPOINT_IDS.map((id, index) => ({
      id,
      x: 100 + index * 10,
      y: 200 + index * 5,
      score: 0.9,
    })),
  };
}

function solvedRig(): KalidokitPoseRig {
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
    Hips: {
      position: rotation,
      worldPosition: { x: 1, y: 1, z: 1 },
      rotation,
    },
  };
}
