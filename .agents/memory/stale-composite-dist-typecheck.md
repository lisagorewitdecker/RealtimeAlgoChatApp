---
name: Stale composite TypeScript output breaks typechecks
description: Why an artifact typecheck can report missing columns or properties that plainly exist in the shared library source.
---

Workspace libraries that are TypeScript composite projects publish declarations into an untracked `dist/` directory. Consumers resolve those declarations, not the source, so an artifact typecheck can fail against a definition that no longer matches the library source in the tree.

**Why:** the declarations are build output and are not carried by any branch operation. After a rebase, a branch switch, or a fresh environment, they can be far older than the source; the resulting errors name real, present fields as if they did not exist, which reads like a broken merge and invites pointless conflict re-resolution.

**How to apply:** when a typecheck error contradicts the source you just read, and that source matches the target branch, rebuild the library's declarations (`tsc -b <lib>`, adding `--force` when the build info is also stale) and re-run the typecheck before changing any code. The library may have no `build` script, so drive `tsc -b` directly against its directory.
