const assert = require("node:assert/strict");
const test = require("node:test");
const { imageSize } = require("image-size");

function malformedBuffer(size) {
  const input = Buffer.alloc(16);
  input.writeUInt32BE(size, 0);
  input.write("meta", 4, "ascii");
  return input;
}

test("rejects zero-length malformed image buffer", () => {
  assert.throws(() => imageSize(malformedBuffer(0)));
});

test("rejects undersized malformed image buffer", () => {
  assert.throws(() => imageSize(malformedBuffer(1)));
});