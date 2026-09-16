---
name: Worktree-local state vs shared Git config
description: git worktrees share the repository's local git config; per-worktree state cannot live in shared single-valued config keys
---

Git worktrees of one repository share `.git/config` (unless `extensions.worktreeConfig` is enabled). State that differs per worktree cannot be represented by shared single-valued config: one worktree's value silently speaks for all siblings. The same applies to identities derived from the shared Git common directory, which equals the primary worktree's own Git directory.

**Why:** per-worktree registrations keyed by a single shared config value, or named from the shared common directory, let unregistered worktrees inherit a sibling's state and collide with the primary worktree.

**How to apply:** when tracking per-worktree state, use multi-valued config keys or records named from the per-worktree `git rev-parse --git-dir`, and validate that an inherited record actually targets the current worktree before trusting it.
