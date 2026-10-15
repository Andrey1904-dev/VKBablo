import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasVkPublicationImageExtension,
  isVkPublicationImage,
  isVkPublicationImageMime,
  resolveImageMime,
  sniffImageMime,
} from "../../shared/image-format.ts";
import { assertImage } from "../storage.ts";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const GIF = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const SVG = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"></svg>');

test("signature sniffing detects raster/vector types without trusting file names", () => {
  assert.equal(sniffImageMime(PNG), "image/png");
  assert.equal(sniffImageMime(JPEG), "image/jpeg");
  assert.equal(sniffImageMime(WEBP), "image/webp");
  assert.equal(sniffImageMime(GIF), "image/gif");
  assert.equal(sniffImageMime(SVG), "image/svg+xml");
  assert.equal(sniffImageMime(new TextEncoder().encode("not an image")), null);
});

test("MIME spoofing is rejected and an empty browser MIME is inferred from bytes", () => {
  assert.equal(resolveImageMime("", PNG), "image/png");
  assert.equal(resolveImageMime("IMAGE/JPEG; charset=binary", JPEG), "image/jpeg");
  assert.throws(() => resolveImageMime("image/jpeg", PNG), /не совпадает/);
  assert.throws(() => resolveImageMime("image/png", new Uint8Array([1, 2, 3])), /не распознано/);
});

test("VK publication allowlist is restricted to PNG and JPEG content plus matching path extension", () => {
  assert.equal(isVkPublicationImageMime("image/png"), true);
  assert.equal(isVkPublicationImageMime("image/jpeg"), true);
  assert.equal(isVkPublicationImageMime("image/webp"), false);
  assert.equal(isVkPublicationImageMime("image/gif"), false);
  assert.equal(isVkPublicationImageMime("image/svg+xml"), false);
  assert.equal(isVkPublicationImage("image/png", PNG), true);
  assert.equal(isVkPublicationImage("image/jpeg", JPEG), true);
  assert.equal(isVkPublicationImage("image/png", JPEG), false);
  assert.equal(hasVkPublicationImageExtension("posts/photo.png"), true);
  assert.equal(hasVkPublicationImageExtension("posts/photo.jpeg?download=1"), true);
  assert.equal(hasVkPublicationImageExtension("posts/photo.webp"), false);
  assert.equal(hasVkPublicationImageExtension("posts/photo.png.exe"), false);
});

test("local upload route allows only sniffed PNG/JPEG in posts while keeping other folders broad", () => {
  assert.doesNotThrow(() => assertImage("image/png", PNG.byteLength, "posts", PNG));
  assert.doesNotThrow(() => assertImage("image/jpeg", JPEG.byteLength, "posts", JPEG));
  assert.throws(() => assertImage("image/webp", WEBP.byteLength, "posts", WEBP), /PNG или JPEG/);
  assert.throws(() => assertImage("image/png", JPEG.byteLength, "posts", JPEG), /фактическим форматом/);
  assert.doesNotThrow(() => assertImage("image/svg+xml", SVG.byteLength, "characters", SVG));
  assert.throws(() => assertImage("image/svg+xml", SVG.byteLength, "posts", SVG), /PNG или JPEG/);
});
