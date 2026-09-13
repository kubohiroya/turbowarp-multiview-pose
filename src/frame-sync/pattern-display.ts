import {
  PATTERN_COLUMNS,
  PATTERN_ROWS,
  encodePatternCells,
  patternCodeForTimestamp,
} from "./pattern.js";
import type { TimeSourcePort } from "./types.js";

export interface PatternDisplayOptions {
  timeSource: TimeSourcePort;
  documentRef?: Document;
  /** Panel size as a share of the shorter viewport edge. */
  panelScale?: number;
}

const REFRESH_SAMPLES = 30;
const MINIMUM_REFRESH_US = 4_000;
const MAXIMUM_REFRESH_US = 40_000;
const DEFAULT_PANEL_SCALE = 0.7;
const CELL_GAP_RATIO = 0.08;
const OVERLAY_STYLE = [
  "position:fixed",
  "inset:0",
  "width:100vw",
  "height:100vh",
  "margin:0",
  "padding:0",
  "border:0",
  "background:#000",
  "pointer-events:none",
  "z-index:2147483000",
].join(";");

/**
 * Shows the time coded pattern full screen for a projector to relay.
 *
 * The pattern that is drawn during one animation frame reaches the screen at the
 * next refresh, so the encoded time is the current clock reading plus one
 * measured refresh interval. Any remaining display or projector delay is the
 * same for every camera and therefore cancels out of the per-camera offsets.
 */
export class FrameSyncPatternDisplay {
  private readonly timeSource: TimeSourcePort;
  private readonly documentRef: Document;
  private readonly panelScale: number;
  private readonly intervals: number[] = [];
  private canvas: HTMLCanvasElement | undefined;
  private context: CanvasRenderingContext2D | undefined;
  private animationHandle: number | undefined;
  private lastFrameUs = 0;

  public constructor(options: PatternDisplayOptions) {
    this.timeSource = options.timeSource;
    this.documentRef = options.documentRef ?? document;
    this.panelScale = options.panelScale ?? DEFAULT_PANEL_SCALE;
  }

  public visible(): boolean {
    return this.canvas !== undefined;
  }

  public show(): void {
    if (this.canvas) return;
    const canvas = this.documentRef.createElement("canvas");
    canvas.style.cssText = OVERLAY_STYLE;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The frame sync pattern needs a 2D canvas.");
    this.documentRef.body.append(canvas);
    this.canvas = canvas;
    this.context = context;
    this.intervals.length = 0;
    this.lastFrameUs = 0;
    this.scheduleFrame();
  }

  public hide(): void {
    if (this.animationHandle !== undefined) {
      cancelAnimationFrame(this.animationHandle);
      this.animationHandle = undefined;
    }
    this.canvas?.remove();
    this.canvas = undefined;
    this.context = undefined;
    this.intervals.length = 0;
    this.lastFrameUs = 0;
  }

  private scheduleFrame(): void {
    if (!this.canvas) return;
    this.animationHandle = requestAnimationFrame(() => {
      this.animationHandle = undefined;
      this.renderFrame();
      this.scheduleFrame();
    });
  }

  private renderFrame(): void {
    const canvas = this.canvas;
    const context = this.context;
    if (!canvas || !context) return;
    const nowUs = this.timeSource.nowUs();
    const refreshUs = this.measureRefresh(nowUs);
    this.resize(canvas);
    const cells = encodePatternCells(
      patternCodeForTimestamp(nowUs + refreshUs),
    );
    drawPattern(context, canvas.width, canvas.height, cells, this.panelScale);
  }

  private measureRefresh(nowUs: number): number {
    if (this.lastFrameUs > 0) {
      const interval = nowUs - this.lastFrameUs;
      if (interval >= MINIMUM_REFRESH_US && interval <= MAXIMUM_REFRESH_US) {
        this.intervals.push(interval);
        while (this.intervals.length > REFRESH_SAMPLES) this.intervals.shift();
      }
    }
    this.lastFrameUs = nowUs;
    if (this.intervals.length === 0) return MINIMUM_REFRESH_US;
    const sorted = [...this.intervals].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? MINIMUM_REFRESH_US;
  }

  private resize(canvas: HTMLCanvasElement): void {
    const ratio = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  }
}

export function drawPattern(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  cells: readonly boolean[],
  panelScale: number,
): void {
  context.fillStyle = "#000000";
  context.fillRect(0, 0, width, height);
  const panel = Math.min(width, height) * panelScale;
  const originX = (width - panel) / 2;
  const originY = (height - panel) / 2;
  const cellWidth = panel / PATTERN_COLUMNS;
  const cellHeight = panel / PATTERN_ROWS;
  const gapX = cellWidth * CELL_GAP_RATIO;
  const gapY = cellHeight * CELL_GAP_RATIO;
  for (let row = 0; row < PATTERN_ROWS; row += 1) {
    for (let column = 0; column < PATTERN_COLUMNS; column += 1) {
      if (cells[row * PATTERN_COLUMNS + column] !== true) continue;
      context.fillStyle = "#ffffff";
      context.fillRect(
        originX + column * cellWidth + gapX / 2,
        originY + row * cellHeight + gapY / 2,
        cellWidth - gapX,
        cellHeight - gapY,
      );
    }
  }
}
