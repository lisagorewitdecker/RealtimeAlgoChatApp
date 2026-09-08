---
name: Image-size remediation
description: Why Metro uses a local image-size replacement rather than an upstream package release.
---

`image-size` had no published fix for the ICNS, HEIF, and JXL parser-loop advisories. Use the local compatibility replacement until upstream publishes a fixed release that clears the advisory database.

**Why:** Metro only needs image dimensions for standard app assets, while the affected container formats are not needed for its asset pipeline. Rejecting those formats avoids the unsafe parser paths and permits a zero-vulnerability audit.

**How to apply:** Keep the package-manager override pointed at the local implementation with the `link:` protocol during routine upgrades. A `file:` dependency is safe at runtime but can be misclassified by OSV scanners as a vulnerable package version. Before removing the override, verify the upstream release fixes both image-size advisories with the dependency scanner and confirm Metro can still bundle a web preview.
