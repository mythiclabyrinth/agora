import { previewText } from "../src/lib/previewText";

it("renders readable previews for supported markdown", () => {
  expect(previewText("**SEV3**: fix `TLS` with [the guide](https://example.com)"))
    .toBe("SEV3: fix TLS with the guide");
  expect(previewText("# Plan\n\n```ts\nconst x = 1\n```" )).toBe("Plan const x = 1");
});
it("preserves search highlight markers and mentions", () => {
  expect(previewText("**Find \u0001this\u0002** @maya")).toBe("Find \u0001this\u0002 @maya");
});
it("preserves meaningful punctuation and table content", () => {
  expect(previewText("2 * 3 = 6; snake_case")).toBe("2 * 3 = 6; snake_case");
  expect(previewText("| Name | Status |\n| --- | --- |\n| **Build** | Ready |"))
    .toBe("Name · Status Build · Ready");
});
