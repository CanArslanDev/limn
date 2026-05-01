# Migration guide

This document walks you through upgrading between major Traceworks milestones. Format: each section lists the breaking changes from the previous anchor version, the rationale, and the concrete before/after diff for user code.

If you find a breaking change that isn't listed, open an issue with the bug-report template and we'll document it here.

## Pre-1.0

Traceworks is in active design. Every 0.x minor may introduce breaking changes. Pin a version (`traceworks: 0.x.y`, not `^0.x.y`) until v1.0.0 ships if you cannot tolerate breaks.

The CHANGELOG records every breaking change under `### Breaking changes` for the relevant version.

## What stays stable across 0.x

The package name (`traceworks`), the import path (`import { ai } from "traceworks"`), the names of the four Layer 1 functions (`ask`, `chat`, `extract`, `stream`), and the philosophy (single import, local-first observability, typed errors). Argument shapes and return shapes inside those functions may evolve.

## After v1.0.0

Once v1.0.0 ships, semantic versioning takes over: minor releases stay source-compatible with their predecessor; major releases get a dedicated section here documenting every breaking change with before/after code.

## Opening an issue

Found a migration you can't resolve from this guide? Open an issue with the bug-report template and include:

- The old and new Traceworks versions.
- The exact code that broke.
- The error message or unexpected behavior.

We'll answer, fix the bug if there is one, and document the fix here.
