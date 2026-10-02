import assert from "node:assert/strict";
import test from "node:test";
import {
  MAIN_ADMIN_NAME,
  canonicalProfileName,
  isValidEmail,
  normalizeEmail,
} from "../src/lib/profileIdentity.ts";

test("normalizes email addresses before saving them", () => {
  assert.equal(normalizeEmail("  Lisa@iCloud.COM "), "lisa@icloud.com");
});

test("rejects malformed profile email addresses", () => {
  assert.equal(isValidEmail("lgorewit@icloud.com"), true);
  assert.equal(isValidEmail("not-an-email"), false);
});

test("keeps ordinary users' chosen display names", () => {
  assert.equal(canonicalProfileName("Avery", "avery@example.com"), "Avery");
});

test("uses the canonical main-admin display name", () => {
  assert.equal(
    canonicalProfileName("Lisa", "lgorewit@icloud.com"),
    MAIN_ADMIN_NAME,
  );
});