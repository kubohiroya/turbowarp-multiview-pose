import {
  PATTERN_CELL_COUNT,
  PATTERN_COLUMNS,
  PATTERN_ROWS,
  decodePatternCells,
} from "./pattern.js";

export interface LuminanceFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface PanelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PanelDetectionOptions {
  /** Smallest light-to-dark swing a panel pixel must show over the window. */
  minimumRange?: number;
  /** Fraction of the strongest swing a pixel must reach to count as panel. */
  rangeRatio?: number;
  /** Smallest analysis pixels per pattern cell. */
  minimumCellPixels?: number;
  /** Smallest share of the bounding box the detected region must fill. */
  minimumFillRatio?: number;
  /** Largest tolerated width-to-height ratio of the bounding box. */
  maximumAspectSkew?: number;
}

const defaultOptions: Required<PanelDetectionOptions> = {
  minimumRange: 40,
  rangeRatio: 0.5,
  minimumCellPixels: 3,
  minimumFillRatio: 0.5,
  maximumAspectSkew: 2.5,
};

/**
 * Finds the projected panel by watching which pixels change over time.
 *
 * Every pattern cell toggles within a few seconds because the encoded counter
 * runs through all of its bits, so the panel stands out as one connected region
 * of high temporal range while the rest of the room stays comparatively still.
 */
export class PanelRangeAccumulator {
  public readonly width: number;
  public readonly height: number;
  private readonly minimum: Uint8Array;
  private readonly maximum: Uint8Array;
  private frameCount = 0;

  public constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.minimum = new Uint8Array(width * height).fill(255);
    this.maximum = new Uint8Array(width * height);
  }

  public add(frame: LuminanceFrame): void {
    if (frame.width !== this.width || frame.height !== this.height) {
      throw new Error("Frame size does not match the accumulator.");
    }
    for (let index = 0; index < frame.data.length; index += 1) {
      const value = frame.data[index] ?? 0;
      if (value < (this.minimum[index] ?? 255)) this.minimum[index] = value;
      if (value > (this.maximum[index] ?? 0)) this.maximum[index] = value;
    }
    this.frameCount += 1;
  }

  public frames(): number {
    return this.frameCount;
  }

  public detect(options: PanelDetectionOptions = {}): PanelRect | undefined {
    if (this.frameCount < 2) return undefined;
    const settings = { ...defaultOptions, ...options };
    const pixels = this.width * this.height;
    let strongest = 0;
    for (let index = 0; index < pixels; index += 1) {
      const range = (this.maximum[index] ?? 0) - (this.minimum[index] ?? 0);
      if (range > strongest) strongest = range;
    }
    const threshold = Math.max(
      settings.minimumRange,
      strongest * settings.rangeRatio,
    );
    if (strongest < settings.minimumRange) return undefined;

    const mask = new Uint8Array(pixels);
    for (let index = 0; index < pixels; index += 1) {
      const range = (this.maximum[index] ?? 0) - (this.minimum[index] ?? 0);
      mask[index] = range >= threshold ? 1 : 0;
    }
    const region = largestRegion(mask, this.width, this.height);
    if (!region) return undefined;

    const width = region.maxX - region.minX + 1;
    const height = region.maxY - region.minY + 1;
    if (width < PATTERN_COLUMNS * settings.minimumCellPixels) return undefined;
    if (height < PATTERN_ROWS * settings.minimumCellPixels) return undefined;
    const skew = width / height;
    if (skew > settings.maximumAspectSkew) return undefined;
    if (skew < 1 / settings.maximumAspectSkew) return undefined;
    if (region.area / (width * height) < settings.minimumFillRatio) {
      return undefined;
    }
    return { x: region.minX, y: region.minY, width, height };
  }
}

/** Sampling rectangles for each cell, inset to tolerate a small misalignment. */
export function patternCellRects(
  panel: PanelRect,
  insetRatio = 0.25,
): PanelRect[] {
  const cellWidth = panel.width / PATTERN_COLUMNS;
  const cellHeight = panel.height / PATTERN_ROWS;
  const insetX = cellWidth * insetRatio;
  const insetY = cellHeight * insetRatio;
  const rects: PanelRect[] = [];
  for (let row = 0; row < PATTERN_ROWS; row += 1) {
    for (let column = 0; column < PATTERN_COLUMNS; column += 1) {
      const x = Math.floor(panel.x + column * cellWidth + insetX);
      const y = Math.floor(panel.y + row * cellHeight + insetY);
      rects.push({
        x,
        y,
        width: Math.max(1, Math.ceil(cellWidth - insetX * 2)),
        height: Math.max(1, Math.ceil(cellHeight - insetY * 2)),
      });
    }
  }
  return rects;
}

export function sampleCells(
  frame: LuminanceFrame,
  rects: readonly PanelRect[],
): number[] {
  return rects.map((rect) => meanLuminance(frame, rect));
}

/**
 * Light and dark levels learned per cell.
 *
 * Projection is uneven, so one global threshold misreads the dim corners of the
 * panel. Each cell keeps its own extremes and rejects readings that land in the
 * band between them, which is where a mixed exposure shows up.
 */
export class CellLevels {
  private readonly minimum = new Float64Array(PATTERN_CELL_COUNT).fill(
    Number.POSITIVE_INFINITY,
  );
  private readonly maximum = new Float64Array(PATTERN_CELL_COUNT).fill(
    Number.NEGATIVE_INFINITY,
  );

  public add(samples: readonly number[]): void {
    for (let index = 0; index < PATTERN_CELL_COUNT; index += 1) {
      const value = samples[index];
      if (value === undefined || !Number.isFinite(value)) continue;
      if (value < (this.minimum[index] ?? 0)) this.minimum[index] = value;
      if (value > (this.maximum[index] ?? 0)) this.maximum[index] = value;
    }
  }

  public contrast(): number {
    let smallest = Number.POSITIVE_INFINITY;
    for (let index = 0; index < PATTERN_CELL_COUNT; index += 1) {
      const span = (this.maximum[index] ?? 0) - (this.minimum[index] ?? 0);
      if (span < smallest) smallest = span;
    }
    return Number.isFinite(smallest) ? smallest : 0;
  }

  public decodeCells(
    samples: readonly number[],
    marginRatio = 0.25,
  ): (boolean | undefined)[] {
    const cells: (boolean | undefined)[] = [];
    for (let index = 0; index < PATTERN_CELL_COUNT; index += 1) {
      const value = samples[index];
      const low = this.minimum[index] ?? 0;
      const high = this.maximum[index] ?? 0;
      const threshold = (low + high) / 2;
      const margin = (high - low) * marginRatio;
      if (value === undefined || Math.abs(value - threshold) < margin) {
        cells.push(undefined);
      } else {
        cells.push(value > threshold);
      }
    }
    return cells;
  }

  public decode(
    samples: readonly number[],
    marginRatio = 0.25,
  ): number | undefined {
    return decodePatternCells(this.decodeCells(samples, marginRatio));
  }
}

function meanLuminance(frame: LuminanceFrame, rect: PanelRect): number {
  const startX = Math.max(0, Math.min(frame.width - 1, rect.x));
  const startY = Math.max(0, Math.min(frame.height - 1, rect.y));
  const endX = Math.max(startX + 1, Math.min(frame.width, rect.x + rect.width));
  const endY = Math.max(
    startY + 1,
    Math.min(frame.height, rect.y + rect.height),
  );
  let total = 0;
  let count = 0;
  for (let y = startY; y < endY; y += 1) {
    const row = y * frame.width;
    for (let x = startX; x < endX; x += 1) {
      total += frame.data[row + x] ?? 0;
      count += 1;
    }
  }
  return count === 0 ? 0 : total / count;
}

interface Region {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  area: number;
}

function largestRegion(
  mask: Uint8Array,
  width: number,
  height: number,
): Region | undefined {
  const visited = new Uint8Array(mask.length);
  const stack: number[] = [];
  let best: Region | undefined;
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1 || visited[start] === 1) continue;
    visited[start] = 1;
    stack.push(start);
    let area = 0;
    let minX = width;
    let minY = height;
    let maxX = 0;
    let maxY = 0;
    while (stack.length > 0) {
      const index = stack.pop() as number;
      const x = index % width;
      const y = (index - x) / width;
      area += 1;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0) push(index - 1);
      if (x + 1 < width) push(index + 1);
      if (y > 0) push(index - width);
      if (y + 1 < height) push(index + width);
    }
    if (!best || area > best.area) best = { minX, minY, maxX, maxY, area };
  }
  return best;

  function push(index: number): void {
    if (mask[index] === 1 && visited[index] === 0) {
      visited[index] = 1;
      stack.push(index);
    }
  }
}
