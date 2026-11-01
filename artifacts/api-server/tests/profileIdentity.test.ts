import assert from "node:assert/strict";
import test from "node:test";
import {
  MAIN_ADMIN_NAME,
  canonicalProfileName,
  getMainAdminEmail,
  isMainAdminEmail,
  isReservedDisplayName,
  isValidEmail,
  normalizeEmail,
} from "../src/lib/profileIdentity.ts";

function withMainAdminEmail(value: string | undefined, run: () => void) {
  const previous = process.env["MAIN_ADMIN_EMAIL"];
  if (value === undefined) delete process.env["MAIN_ADMIN_EMAIL"];
  else process.env["MAIN_ADMIN_EMAIL"] = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env["MAIN_ADMIN_EMAIL"];
    else process.env["MAIN_ADMIN_EMAIL"] = previous;
  }
}

test("normalizes email addresses before saving them", () => {
  assert.equal(normalizeEmail("  Owner@Example.COM "), "owner@example.com");
});

test("rejects malformed profile email addresses", () => {
  assert.equal(isValidEmail("owner@example.com"), true);
  assert.equal(isValidEmail("not-an-email"), false);
});

test("keeps ordinary users' chosen display names", () => {
  withMainAdminEmail("owner@example.com", () => {
    assert.equal(canonicalProfileName("Avery", "avery@example.com"), "Avery");
  });
});

test("uses the canonical main-admin display name for the configured email", () => {
  withMainAdminEmail("  Owner@Example.com ", () => {
    assert.equal(getMainAdminEmail(), "owner@example.com");
    assert.equal(canonicalProfileName("Owner", "owner@example.com"), MAIN_ADMIN_NAME);
    assert.equal(canonicalProfileName("Owner", "OWNER@example.com "), MAIN_ADMIN_NAME);
  });
});

test("gives nobody main-admin treatment when MAIN_ADMIN_EMAIL is unset or malformed", () => {
  for (const value of [undefined, "", "   ", "not-an-email"]) {
    withMainAdminEmail(value, () => {
      assert.equal(getMainAdminEmail(), null);
      assert.equal(isMainAdminEmail("owner@example.com"), false);
      assert.equal(isMainAdminEmail(""), false);
      assert.equal(isMainAdminEmail(null), false);
      assert.equal(canonicalProfileName("Owner", "owner@example.com"), "Owner");
    });
  }
});

test("reserves system and administrator display names, including look-alikes", () => {
  for (const name of [
    "System",
    " system ",
    "S y s t e m",
    "Sys\u200Btem",
    "Ｓｙｓｔｅｍ",
    "\u{1D412}ystem",
    "Systém",
    "Sуstem",
    "Admin",
    "Adm1n",
    "Administrator",
    "Moderat0r",
    "\u039Coderator",
    MAIN_ADMIN_NAME,
    "lisa gorewit decker",
    "L1sa  Gorewit\u2011Decker",
  ]) {
    assert.equal(isReservedDisplayName(name), true, JSON.stringify(name));
  }
});

test("allows ordinary display names that only resemble reserved ones", () => {
  for (const name of ["Ada", "Lisa", "Systems", "System32", "Admin Fan", "Mod"]) {
    assert.equal(isReservedDisplayName(name), false, name);
  }
});
