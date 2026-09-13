import { describe, expect, it, vi } from "vitest";
import { PosePipelineController } from "../src/pose/controller.js";
import { COCO_17_KEYPOINT_IDS } from "../src/pose/types.js";
import type {
  CameraFrameSourcePort,
  CameraLeasePort,
  ModelPose,
  PoseDetectorPort,
  PoseModelPort,
} from "../src/pose/types.js";

function setup(
  options: {
    backend?: string;
    initializeError?: Error;
    modelError?: Error;
    frameError?: Error;
    poses?: ModelPose[];
  } = {},
) {
  const frame: CameraFrameSourcePort = {
    kind: "video",
    element: {} as HTMLVideoElement,
    width: 1920,
    height: 1080,
    mirrored: false,
    deviceId: "device-1",
  };
  const release = vi.fn(async () => undefined);
  const lease: CameraLeasePort = {
    getFrameSource: vi.fn(() => {
      if (options.frameError) throw options.frameError;
      return frame;
    }),
    release,
  };
  const dispose = vi.fn();
  const estimatePoses = vi.fn(async () => options.poses ?? [pose(1)]);
  const detector: PoseDetectorPort = { estimatePoses, dispose };
  const model: PoseModelPort = {
    initializeWebGpu: vi.fn(async () => {
      if (options.initializeError) throw options.initializeError;
    }),
    backend: vi.fn(() => options.backend ?? "webgpu"),
    createMultiPoseDetector: vi.fn(async () => {
      if (options.modelError) throw options.modelError;
      return detector;
    }),
  };
  const acquireCamera = vi.fn(async () => lease);
  const runtime: TurboWarpRuntime = {
    ext_kubohiroyacamerasource: { acquireCamera },
  };
  const controller = new PosePipelineController({
    runtime,
    model,
    nowMilliseconds: () => 1234.5,
    clockId: "clock-1",
  });
  return {
    controller,
    runtime,
    model,
    detector,
    estimatePoses,
    dispose,
    acquireCamera,
    release,
    frame,
  };
}

const startOptions = {
  cameraId: "pose",
  peerId: "source-1",
  calibrationId: "calibration-1",
};

describe("PosePipelineController", () => {
  it("produces protocol-v1 COCO-17 frames for at most six tracked people", async () => {
    const poses = Array.from({ length: 7 }, (_, index) => pose(index));
    const { controller, model, estimatePoses, acquireCamera } = setup({
      poses,
    });
    await controller.start(startOptions);
    expect(model.initializeWebGpu).toHaveBeenCalledOnce();
    expect(model.createMultiPoseDetector).toHaveBeenCalledOnce();
    expect(acquireCamera).toHaveBeenCalledWith({
      owner: "turbowarp-multiview-pose",
      cameraId: "pose",
    });
    await controller.inferLatestFrame();
    expect(estimatePoses).toHaveBeenCalledWith(
      expect.anything(),
      { maxPoses: 6, flipHorizontal: false },
      1234.5,
    );
    const frame = JSON.parse(controller.latestFrameJson()) as Record<
      string,
      unknown
    >;
    expect(frame).toMatchObject({
      schema: "twmp/pose-frame-2d",
      version: 1,
      cameraId: "pose",
      peerId: "source-1",
      calibrationId: "calibration-1",
      clockId: "clock-1",
      sequence: 0,
      captureTimestampUs: 1234500,
      frameWidth: 1920,
      frameHeight: 1080,
    });
    const persons = frame.persons as Array<Record<string, unknown>>;
    expect(persons).toHaveLength(6);
    expect(persons[0]?.trackingId).toBe("movenet-0");
    expect(persons[0]?.keypoints).toHaveLength(17);
    expect(
      (persons[0]?.keypoints as Array<{ id: string }>).map(({ id }) => id),
    ).toEqual(COCO_17_KEYPOINT_IDS);
    await controller.inferLatestFrame();
    expect(JSON.parse(controller.latestFrameJson()).sequence).toBe(1);
  });

  it("coalesces concurrent inference requests instead of overlapping or queueing frames", async () => {
    const { controller, estimatePoses } = setup();
    let finish: ((poses: ModelPose[]) => void) | undefined;
    estimatePoses.mockImplementation(
      () => new Promise<ModelPose[]>((resolve) => (finish = resolve)),
    );
    await controller.start(startOptions);
    const first = controller.inferLatestFrame();
    const second = controller.inferLatestFrame();
    expect(first).toBe(second);
    expect(estimatePoses).toHaveBeenCalledOnce();
    finish?.([pose(1)]);
    await Promise.all([first, second]);
    expect(estimatePoses).toHaveBeenCalledOnce();
  });

  it("fails closed when the selected backend is not WebGPU", async () => {
    const { controller, model, acquireCamera } = setup({ backend: "cpu" });
    await expect(controller.start(startOptions)).rejects.toThrow(
      /webgpu-unavailable/u,
    );
    expect(controller.errorCode()).toBe("webgpu-unavailable");
    expect(model.createMultiPoseDetector).not.toHaveBeenCalled();
    expect(acquireCamera).not.toHaveBeenCalled();
  });

  it("distinguishes WebGPU, model, camera startup, and ended-camera failures", async () => {
    const unavailable = setup({ initializeError: new Error("no adapter") });
    await expect(unavailable.controller.start(startOptions)).rejects.toThrow(
      /webgpu-unavailable/u,
    );

    const modelFailure = setup({ modelError: new Error("download failed") });
    await expect(modelFailure.controller.start(startOptions)).rejects.toThrow(
      /model-load-failed/u,
    );
    expect(modelFailure.controller.errorCode()).toBe("model-load-failed");

    const missingCamera = setup();
    delete missingCamera.runtime.ext_kubohiroyacamerasource;
    await expect(missingCamera.controller.start(startOptions)).rejects.toThrow(
      /camera-unavailable/u,
    );
    expect(missingCamera.dispose).toHaveBeenCalledOnce();

    const ended = setup({ frameError: new Error("camera is not active") });
    await ended.controller.start(startOptions);
    await expect(ended.controller.inferLatestFrame()).rejects.toThrow(
      /camera-ended/u,
    );
    expect(ended.controller.errorCode()).toBe("camera-ended");
  });

  it("rejects missing tracking IDs and releases model and Camera Source resources", async () => {
    const invalid = pose(1);
    delete invalid.id;
    const { controller, dispose, release } = setup({ poses: [invalid] });
    await controller.start(startOptions);
    await expect(controller.inferLatestFrame()).rejects.toThrow(
      /invalid-output/u,
    );
    expect(controller.errorCode()).toBe("invalid-output");
    await controller.stop();
    expect(dispose).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(controller.state()).toBe("idle");
    expect(controller.latestFrameJson()).toBe("");
  });

  it("rejects coordinates outside the PoseFrame2D v1 schema range", async () => {
    const invalid = pose(1);
    invalid.keypoints[0]!.x = 1_000_001;
    const { controller } = setup({ poses: [invalid] });
    await controller.start(startOptions);
    await expect(controller.inferLatestFrame()).rejects.toThrow(
      /invalid-output/u,
    );
  });

  it("distinguishes detector inference failures", async () => {
    const { controller, estimatePoses } = setup();
    estimatePoses.mockRejectedValue(new Error("device lost"));
    await controller.start(startOptions);
    await expect(controller.inferLatestFrame()).rejects.toThrow(
      /inference-failed/u,
    );
    expect(controller.errorCode()).toBe("inference-failed");
  });
});

function pose(id: number): ModelPose {
  return {
    id,
    score: 0.9,
    keypoints: COCO_17_KEYPOINT_IDS.map((name, index) => ({
      name,
      x: index * 10,
      y: index * 5,
      score: 0.8,
    })),
  };
}
