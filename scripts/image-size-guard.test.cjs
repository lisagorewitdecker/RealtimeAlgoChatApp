const assert = require("node:assert/strict");
const test = require("node:test");
const imageSize = require("image-size");

function malformedBox(size) {
  const input = Buffer.alloc(16);
  input.writeUInt32BE(size, 0);
  input.write("meta", 4, "ascii");
  return input;
}

test("rejects zero-length image boxes before parser traversal", () => {
  assert.throws(() => imageSize(malformedBox(0)), /unsupported or unsafe/);
});

test("rejects undersized image boxes before parser traversal", () => {
  assert.throws(() => imageSize(malformedBox(1)), /unsupported or unsafe/);
});

test("rejects ICNS containers instead of entering a parser loop", () => {
  const input = Buffer.alloc(16);
  input.write("icns", 0, "ascii");
  input.writeUInt32BE(input.length, 4);
  input.write("ic07", 8, "ascii");
  input.writeUInt32BE(0, 12);

  assert.throws(() => imageSize(input), /unsupported or unsafe/);
});