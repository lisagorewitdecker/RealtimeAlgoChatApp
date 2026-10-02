"use strict";

const fs = require("node:fs");
const path = require("node:path");

const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
  0xcf,
]);

function asBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof Uint8Array) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new TypeError("invalid invocation. input should be a Uint8Array");
}

function dimensions(width, height, type) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new TypeError(`invalid ${type} dimensions`);
  }
  return { width, height, type };
}

function readPng(input) {
  if (input.length < 24 || input.toString("ascii", 1, 4) !== "PNG") return;
  return dimensions(input.readUInt32BE(16), input.readUInt32BE(20), "png");
}

function readGif(input) {
  if (input.length < 10 || (input.toString("ascii", 0, 6) !== "GIF87a" && input.toString("ascii", 0, 6) !== "GIF89a")) return;
  return dimensions(input.readUInt16LE(6), input.readUInt16LE(8), "gif");
}

function readBmp(input) {
  if (input.length < 26 || input.toString("ascii", 0, 2) !== "BM") return;
  const dibLength = input.readUInt32LE(14);
  if (dibLength === 12 && input.length >= 26) {
    return dimensions(input.readUInt16LE(18), input.readUInt16LE(20), "bmp");
  }
  if (dibLength >= 40 && input.length >= 26) {
    return dimensions(input.readInt32LE(18), Math.abs(input.readInt32LE(22)), "bmp");
  }
}

function readJpeg(input) {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return;
  let offset = 2;
  while (offset + 4 <= input.length) {
    if (input[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (offset < input.length && input[offset] === 0xff) offset += 1;
    const marker = input[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > input.length) break;
    const segmentLength = input.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > input.length) break;
    if (JPEG_SOF_MARKERS.has(marker) && segmentLength >= 7) {
      return dimensions(input.readUInt16BE(offset + 5), input.readUInt16BE(offset + 3), "jpg");
    }
    offset += segmentLength;
  }
}

function readWebp(input) {
  if (input.length < 30 || input.toString("ascii", 0, 4) !== "RIFF" || input.toString("ascii", 8, 12) !== "WEBP") return;
  const subtype = input.toString("ascii", 12, 16);
  if (subtype === "VP8X" && input.length >= 30) {
    return dimensions(1 + input.readUIntLE(24, 3), 1 + input.readUIntLE(27, 3), "webp");
  }
  if (subtype === "VP8 " && input.length >= 30 && input[23] === 0x9d && input[24] === 0x01 && input[25] === 0x2a) {
    return dimensions(input.readUInt16LE(26) & 0x3fff, input.readUInt16LE(28) & 0x3fff, "webp");
  }
  if (subtype === "VP8L" && input.length >= 25 && input[20] === 0x2f) {
    const bits = input.readUInt32LE(21);
    return dimensions((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, "webp");
  }
}

function readPsd(input) {
  if (input.length < 26 || input.toString("ascii", 0, 4) !== "8BPS") return;
  return dimensions(input.readUInt32BE(18), input.readUInt32BE(14), "psd");
}

function readSvg(input) {
  const source = input.toString("utf8", 0, Math.min(input.length, 64 * 1024));
  const tag = source.match(/<svg\b[^>]*>/i);
  if (!tag) return;
  const width = tag[0].match(/\bwidth=["']?\s*([0-9]+(?:\.[0-9]+)?)/i);
  const height = tag[0].match(/\bheight=["']?\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (width && height) return dimensions(Math.round(Number(width[1])), Math.round(Number(height[1])), "svg");
  const viewBox = tag[0].match(/\bviewBox=["']?\s*[-\d.]+\s+[-\d.]+\s+([0-9.]+)\s+([0-9.]+)/i);
  if (viewBox) return dimensions(Math.round(Number(viewBox[1])), Math.round(Number(viewBox[2])), "svg");
}

function readTiff(input) {
  if (input.length < 8) return;
  const littleEndian = input.toString("ascii", 0, 2) === "II";
  const bigEndian = input.toString("ascii", 0, 2) === "MM";
  if (!littleEndian && !bigEndian) return;
  const read16 = littleEndian ? Buffer.prototype.readUInt16LE : Buffer.prototype.readUInt16BE;
  const read32 = littleEndian ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
  if (read16.call(input, 2) !== 42) return;
  const directory = read32.call(input, 4);
  if (directory + 2 > input.length) return;
  const entries = read16.call(input, directory);
  let width;
  let height;
  for (let i = 0; i < entries; i += 1) {
    const entry = directory + 2 + i * 12;
    if (entry + 12 > input.length) break;
    const tag = read16.call(input, entry);
    if (tag !== 256 && tag !== 257) continue;
    const valueType = read16.call(input, entry + 2);
    const count = read32.call(input, entry + 4);
    if (count !== 1 || (valueType !== 3 && valueType !== 4)) continue;
    const value = valueType === 3 ? read16.call(input, entry + 8) : read32.call(input, entry + 8);
    if (tag === 256) width = value;
    else height = value;
  }
  if (width && height) return dimensions(width, height, "tiff");
}

function readKtx(input) {
  const signature = "«KTX 11»\r\n\u001a\n";
  if (input.length < 44 || input.toString("latin1", 0, 12) !== signature) return;
  const endianness = input.readUInt32LE(12);
  if (endianness !== 0x04030201) return;
  return dimensions(input.readUInt32LE(36), input.readUInt32LE(40), "ktx");
}

function imageSize(input, callback) {
  if (typeof input === "string") {
    const filePath = path.resolve(input);
    if (typeof callback === "function") {
      fs.readFile(filePath, (error, content) => {
        if (error) callback(error);
        else {
          try {
            callback(null, imageSize(content));
          } catch (parseError) {
            callback(parseError);
          }
        }
      });
      return;
    }
    return imageSize(fs.readFileSync(filePath));
  }

  const buffer = asBuffer(input);
  const parsers = [readPng, readGif, readBmp, readJpeg, readWebp, readPsd, readSvg, readTiff, readKtx];
  for (const parser of parsers) {
    const result = parser(buffer);
    if (result) return result;
  }
  throw new TypeError("unsupported or unsafe image type");
}

module.exports = imageSize;
module.exports.default = imageSize;
module.exports.imageSize = imageSize;
module.exports.disableFS = () => {};
module.exports.disableTypes = () => {};
module.exports.setConcurrency = () => {};
module.exports.types = ["bmp", "gif", "jpg", "ktx", "png", "psd", "svg", "tiff", "webp"];