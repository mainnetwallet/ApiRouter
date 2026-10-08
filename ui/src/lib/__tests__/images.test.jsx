import { describe, expect, it } from "vitest";
import { MAX_IMAGES, MAX_IMAGE_BYTES, imageProblem, parseDataUrl } from "../images.js";

describe("image attachments", () => {
  it("parses a base64 data URL", () => {
    expect(parseDataUrl("data:image/PNG;base64,AAAA")).toEqual({ mimeType: "image/png", data: "AAAA" });
    expect(parseDataUrl("not a data url")).toBeNull();
    expect(parseDataUrl(null)).toBeNull();
  });

  it("accepts a small supported image", () => {
    expect(imageProblem({ name: "a.png", type: "image/png", size: 1000 }, 0)).toBeNull();
  });

  it("rejects unsupported types, oversize files and too many images", () => {
    expect(imageProblem({ name: "a.pdf", type: "application/pdf", size: 10 }, 0)).toMatch(/not a PNG/);
    expect(imageProblem({ name: "big.png", type: "image/png", size: MAX_IMAGE_BYTES + 1 }, 0)).toMatch(/larger than/);
    expect(imageProblem({ name: "a.png", type: "image/png", size: 10 }, MAX_IMAGES)).toMatch(/At most/);
    expect(imageProblem(null, 0)).toBeTruthy();
  });
});
