import { describe, expect, it } from "vitest";
import {
  CellLevels,
  PanelRangeAccumulator,
  patternCellRects,
  sampleCells,
  type LuminanceFrame,
  type PanelRect,
} from "../src/frame-sync/detector.js";
import {
  PATTERN_COLUMNS,
  PATTERN_ROWS,
  encodePatternCells,
} from "../src/frame-sync/pattern.js";

const WIDTH = 96;
const HEIGHT = 72;
const PANEL: PanelRect = { x: 24, y: 12, width: 48, height: 48 };
const BACKGROUND = 12;
const DARK = 18;
const LIGHT = 220;
/** Two codes whose data and check cells are exact opposites. */
const CALIBRATION_CODES = [0, 4095];

function renderFrame(code: number, panel: PanelRect = PANEL): LuminanceFrame {
  const data = new Uint8Array(WIDTH * HEIGHT).fill(BACKGROUND);
  const cells = encodePatternCells(code);
  const cellWidth = panel.width / PATTERN_COLUMNS;
  const cellHeight = panel.height / PATTERN_ROWS;
  for (let row = 0; row < PATTERN_ROWS; row += 1) {
    for (let column = 0; column < PATTERN_COLUMNS; column += 1) {
      const value = cells[row * PATTERN_COLUMNS + column] ? LIGHT : DARK;
      fill(
        data,
        {
          x: Math.round(panel.x + column * cellWidth),
          y: Math.round(panel.y + row * cellHeight),
          width: Math.round(cellWidth),
          height: Math.round(cellHeight),
        },
        value,
      );
    }
  }
  return { width: WIDTH, height: HEIGHT, data };
}

function fill(data: Uint8Array, rect: PanelRect, value: number): void {
  for (let y = rect.y; y < rect.y + rect.height; y += 1) {
    for (let x = rect.x; x < rect.x + rect.width; x += 1) {
      data[y * WIDTH + x] = value;
    }
  }
}

function calibrate(frames: readonly LuminanceFrame[]): {
  panel: PanelRect | undefined;
  levels: CellLevels;
} {
  const accumulator = new PanelRangeAccumulator(WIDTH, HEIGHT);
  for (const frame of frames) accumulator.add(frame);
  const panel = accumulator.detect();
  const levels = new CellLevels();
  if (panel) {
    const rects = patternCellRects(panel);
    for (const frame of frames) levels.add(sampleCells(frame, rects));
  }
  return { panel, levels };
}

describe("panel detection", () => {
  it("finds the projected panel from the pixels that change", () => {
    const frames = CALIBRATION_CODES.map((code) => renderFrame(code));
    expect(calibrate(frames).panel).toEqual(PANEL);
  });

  it("ignores a smaller moving highlight elsewhere in the room", () => {
    const frames = CALIBRATION_CODES.map((code) => renderFrame(code));
    fill(frames[1]!.data, { x: 2, y: 2, width: 6, height: 6 }, 240);
    expect(calibrate(frames).panel).toEqual(PANEL);
  });

  it("refuses a changing region that is not panel shaped", () => {
    const frames = CALIBRATION_CODES.map(() => blankFrame());
    fill(frames[1]!.data, { x: 4, y: 4, width: 80, height: 4 }, 240);
    expect(calibrate(frames).panel).toBeUndefined();
  });

  it("refuses a still scene", () => {
    expect(calibrate([blankFrame(), blankFrame()]).panel).toBeUndefined();
  });
});

describe("cell decoding", () => {
  it("reads the displayed code back out of a camera frame", () => {
    const { panel, levels } = calibrate(
      CALIBRATION_CODES.map((code) => renderFrame(code)),
    );
    expect(panel).toBeDefined();
    expect(levels.contrast()).toBeGreaterThan(100);
    const rects = patternCellRects(panel as PanelRect);
    for (const code of [0, 1, 2024, 4094, 4095]) {
      expect(levels.decode(sampleCells(renderFrame(code), rects))).toBe(code);
    }
  });

  it("rejects a cell whose brightness sits between the learned levels", () => {
    const { panel, levels } = calibrate(
      CALIBRATION_CODES.map((code) => renderFrame(code)),
    );
    const rects = patternCellRects(panel as PanelRect);
    const samples = sampleCells(renderFrame(2024), rects);
    samples[3] = (DARK + LIGHT) / 2;
    expect(levels.decodeCells(samples)[3]).toBeUndefined();
    expect(levels.decode(samples)).toBeUndefined();
  });

  it("keeps a decoder that never saw both levels from reading cells", () => {
    const levels = new CellLevels();
    levels.add(sampleCells(renderFrame(0), patternCellRects(PANEL)));
    expect(levels.contrast()).toBe(0);
  });
});

function blankFrame(): LuminanceFrame {
  return {
    width: WIDTH,
    height: HEIGHT,
    data: new Uint8Array(WIDTH * HEIGHT).fill(BACKGROUND),
  };
}
