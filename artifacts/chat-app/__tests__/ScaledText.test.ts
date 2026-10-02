import {
  MIN_LEGIBLE_FONT_SIZE,
  scaleTextStyle,
} from "../components/ScaledText";

describe("scaleTextStyle", () => {
  it("keeps very small labels at a legible rendered size", () => {
    expect(scaleTextStyle({ fontSize: 10, lineHeight: 14 }, 1)).toEqual(
      expect.objectContaining({
        fontSize: MIN_LEGIBLE_FONT_SIZE,
        lineHeight: 14,
      }),
    );
  });

  it("preserves larger accessibility-scaled sizes", () => {
    const style = scaleTextStyle({ fontSize: 11, lineHeight: 16 }, 1.4);

    expect(style?.fontSize).toBeCloseTo(15.4);
    expect(style?.lineHeight).toBeCloseTo(22.4);
  });

  it("does not invent a font size when the style does not define one", () => {
    expect(scaleTextStyle({ fontWeight: "700" }, 1.4)).toEqual({
      fontWeight: "700",
    });
  });
});