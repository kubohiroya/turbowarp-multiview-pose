import { TrackerType } from "@tensorflow-models/pose-detection/dist/calculators/types.js";
import { MULTIPOSE_LIGHTNING } from "@tensorflow-models/pose-detection/dist/movenet/constants.js";
import { load as loadMoveNet } from "@tensorflow-models/pose-detection/dist/movenet/detector.js";
import "@tensorflow/tfjs-backend-webgpu";
import * as tf from "@tensorflow/tfjs-core";
import type { PoseDetectorPort, PoseModelPort } from "./types.js";

export class TfjsWebGpuMoveNet implements PoseModelPort {
  public async initializeWebGpu(): Promise<void> {
    if (!("gpu" in navigator) || navigator.gpu == null) {
      throw new Error("WebGPU is unavailable in this browser.");
    }
    const selected = await tf.setBackend("webgpu");
    await tf.ready();
    if (!selected || tf.getBackend() !== "webgpu") {
      throw new Error(
        `TensorFlow.js selected backend ${tf.getBackend() || "none"}, not webgpu.`,
      );
    }
  }

  public backend(): string {
    return tf.getBackend() ?? "";
  }

  public async createMultiPoseDetector(): Promise<PoseDetectorPort> {
    const detector = await loadMoveNet({
      modelType: MULTIPOSE_LIGHTNING,
      enableTracking: true,
      trackerType: TrackerType.BoundingBox,
    });
    return detector as PoseDetectorPort;
  }
}
