const assert = require("node:assert/strict");
const test = require("node:test");
const { imageSize } = require("image-size");

function malformedBuffer(size) {
const { findBox } = require("image-size/dist/types/utils");

function malformedBox(size) {
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
test("rejects zero-length image boxes before parser traversal", () => {
  assert.equal(findBox(malformedBox(0), "meta", 0), undefined);
});

test("rejects undersized image boxes before parser traversal", () => {
  assert.equal(findBox(malformedBox(1), "meta", 0), undefined);
});