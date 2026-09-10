import { render } from "@testing-library/react-native";
import React from "react";

import { AppFooter } from "@/components/AppFooter";

jest.mock("@/hooks/useColors", () => ({
  useColors: () => ({ mutedForeground: "#a5b4fc" }),
}));

describe("AppFooter", () => {
  it("shows the JavaScript current year, copyright symbol, and owner name", () => {
    const { getByText } = render(<AppFooter />);

    expect(
      getByText(`© ${new Date().getFullYear()} Lisa M Gorewit-Decker`),
    ).toBeTruthy();
  });
});
