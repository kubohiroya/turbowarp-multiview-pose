import type { LuminanceFrame } from "./detector.js";

/**
 * A clock shared with the other computers in the session.
 *
 * This extension never establishes that clock. It reads whatever the external
 * synchronized time service reports and treats the value as opaque.
 */
export interface TimeSourcePort {
  nowUs(): number;
}

export interface CapturedFrame {
  luminance: LuminanceFrame;
  /**
   * How old the frame already was when the browser handed it over, in
   * microseconds, or 0 when the browser does not report a capture time.
   */
  frameAgeUs: number;
}

export interface FramePumpPort {
  start(handler: (frame: CapturedFrame) => void): void;
  stop(): void;
}

export interface FrameSyncObservation {
  /** When this computer finished recording the frame, in the shared clock. */
  frameTimestampUs: number;
  frameAgeUs: number;
  /** The display time decoded out of the frame, within the pattern wrap window. */
  patternTimestampUs: number;
}

export interface PatternDisplayPort {
  show(): void;
  hide(): void;
  visible(): boolean;
}
