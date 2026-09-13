// Keep this Replit Nix package-name contract in sync with .replit whenever
// Playwright's pinned Chromium revision changes.
export const requiredChromiumRuntimePackages = [
  "glib",
  "nss",
  "nspr",
  "atk",
  "at-spi2-atk",
  "dbus",
  "xorg.libX11",
  "xorg.libXcomposite",
  "xorg.libXdamage",
  "xorg.libXext",
  "xorg.libXfixes",
  "xorg.libXrandr",
  "mesa",
  "xorg.libxcb",
  "libxkbcommon",
  "alsa-lib",
  "at-spi2-core",
  "libgbm",
  "cups",
  "expat",
  "libdrm",
  "pango",
  "cairo",
  "fontconfig",
  "freetype",
  "systemd",
];

// Map Chromium's actual ELF dependencies to Replit-compatible nixpkgs names.
// When a Playwright upgrade introduces an unknown SONAME, the upgrade check
// fails and asks the maintainer to add its Nix mapping here.
export const chromiumLibraryNixPackages = new Map([
  [/^lib(?:gio|glib|gobject)-2\.0\.so\./, "glib"],
  [/^libnss(?:3|util3)\.so$/, "nss"],
  [/^libsmime3\.so$/, "nss"],
  [/^libnspr4\.so$/, "nspr"],
  [/^libatk-1\.0\.so\./, "atk"],
  [/^libatk-bridge-2\.0\.so\./, "at-spi2-atk"],
  [/^libatspi\.so\./, "at-spi2-core"],
  [/^libdbus-1\.so\./, "dbus"],
  [/^libX11\.so\./, "xorg.libX11"],
  [/^libXcomposite\.so\./, "xorg.libXcomposite"],
  [/^libXdamage\.so\./, "xorg.libXdamage"],
  [/^libXext\.so\./, "xorg.libXext"],
  [/^libXfixes\.so\./, "xorg.libXfixes"],
  [/^libXrandr\.so\./, "xorg.libXrandr"],
  [/^libxcb\.so\./, "xorg.libxcb"],
  [/^libxkbcommon\.so\./, "libxkbcommon"],
  [/^libasound\.so\./, "alsa-lib"],
  [/^libgbm\.so\./, "libgbm"],
  [/^libcups\.so\./, "cups"],
  [/^libexpat\.so\./, "expat"],
  [/^libpango-1\.0\.so\./, "pango"],
  [/^libcairo\.so\./, "cairo"],
  [/^libudev\.so\./, "systemd"],
]);

export const chromiumSystemLibraries = [
  /^ld-linux-.+\.so\./,
  /^libc\.so\./,
  /^libdl\.so\./,
  /^libgcc_s\.so\./,
  /^libm\.so\./,
  /^libpthread\.so\./,
];
