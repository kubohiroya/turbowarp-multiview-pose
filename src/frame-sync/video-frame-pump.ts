import type { CapturedFrame, FramePumpPort } from "./types.js";

interface FrameTimingMetadata {
  captureTime?: number;
  presentationTime?: number;
}

/**
 * Delivers downscaled camera frames to the decoder.
 *
 * `requestVideoFrameCallback` fires once per delivered camera frame and reports
 * when the browser captured it, which is the only part of the latency this
 * computer can observe on its own. The frame buffer is reused between callbacks
 * because the decoder reads it before returning.
 */
export class VideoFramePump implements FramePumpPort {
  private readonly element: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private readonly luminance: Uint8Array;
  private readonly width: number;
  private readonly height: number;
  private handler: ((frame: CapturedFrame) => void) | undefined;
  private videoFrameHandle: number | undefined;
  private animationHandle: number | undefined;

  public constructor(
    element: HTMLVideoElement,
    width: number,
    height: number,
    documentRef: Document = document,
  ) {
    this.element = element;
    this.width = width;
    this.height = height;
    this.canvas = documentRef.createElement("canvas");
    this.canvas.width = width;
    this.canvas.height = height;
    const context = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("The frame sync decoder needs a 2D canvas.");
    this.context = context;
    this.luminance = new Uint8Array(width * height);
  }

  public start(handler: (frame: CapturedFrame) => void): void {
    this.stop();
    this.handler = handler;
    this.schedule();
  }

  public stop(): void {
    this.handler = undefined;
    if (this.videoFrameHandle !== undefined) {
      this.element.cancelVideoFrameCallback(this.videoFrameHandle);
      this.videoFrameHandle = undefined;
    }
    if (this.animationHandle !== undefined) {
      cancelAnimationFrame(this.animationHandle);
      this.animationHandle = undefined;
    }
  }

  private schedule(): void {
    if (!this.handler) return;
    if (typeof this.element.requestVideoFrameCallback === "function") {
      this.videoFrameHandle = this.element.requestVideoFrameCallback(
        (now, metadata) => {
          this.videoFrameHandle = undefined;
          this.deliver(frameAgeUs(now, metadata as FrameTimingMetadata));
        },
      );
      return;
    }
    this.animationHandle = requestAnimationFrame(() => {
      this.animationHandle = undefined;
      this.deliver(0);
    });
  }

  private deliver(ageUs: number): void {
    const handler = this.handler;
    if (!handler) return;
    try {
      this.context.drawImage(this.element, 0, 0, this.width, this.height);
      const pixels = this.context.getImageData(
        0,
        0,
        this.width,
        this.height,
      ).data;
      for (let index = 0; index < this.luminance.length; index += 1) {
        const offset = index * 4;
        const red = pixels[offset] ?? 0;
        const green = pixels[offset + 1] ?? 0;
        const blue = pixels[offset + 2] ?? 0;
        this.luminance[index] = (red * 299 + green * 587 + blue * 114) / 1000;
      }
      handler({
        luminance: {
          width: this.width,
          height: this.height,
          data: this.luminance,
        },
        frameAgeUs: ageUs,
      });
    } finally {
      this.schedule();
    }
  }
}

function frameAgeUs(now: number, metadata: FrameTimingMetadata): number {
  const captured = metadata.captureTime ?? metadata.presentationTime;
  if (captured === undefined || !Number.isFinite(captured)) return 0;
  return Math.max(0, Math.round((now - captured) * 1000));
}
