"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const imageSize = require("./index.js");

test("reads a PNG dimension", () => {
  const png = Buffer.alloc(24);
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  png.writeUInt32BE(320, 16);
  png.writeUInt32BE(240, 20);
  assert.deepEqual(imageSize(png), { width: 320, height: 240, type: "png" });
});

test("rejects the ICNS container rather than entering a parser loop", () => {
  assert.throws(() => imageSize(Buffer.from("icns\u0000\u0000\u0000\u0010ic07\u0000\u0000\u0000\u0000")), /unsupported or unsafe/);
});