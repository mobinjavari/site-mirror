# Contributing

We'd be glad to have you contribute to the development of this repository!

## Setup Workflow

| Command             | Description                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| `npm install`       | Install dependencies (also fetches Playwright's Chromium; falls back to system Chrome if blocked) |
| `npm run mirror`    | Run the pipeline: crawl → render → download → rewrite → validate; `--help` lists all flags        |
| `npm run typecheck` | Type-check the project (`tsc --noEmit`)                                                           |
| `npm run lint`      | Lint the project (`eslint .`)                                                                     |
| `npm run format`    | Format the project (`prettier --write .`)                                                         |

## Schema Workflow

- The CLI entry point orchestrates the pipeline: crawl → render → download → rewrite → validate.
- `crawler/` discovers pages and enforces `robots.txt`.
- `renderer/` runs pages through Playwright to capture the JS-rendered DOM and network activity.
- `downloader/` fetches every asset a rendered page references.
- `rewriter/` rewrites HTML/CSS references to point at the local mirrored copies.
- `verifier/` visually compares the mirrored pages against the live site and writes reports.
- `shared/` holds cross-cutting types and utilities (logging, URL/path handling, manifest I/O).

## Contribution Workflow

Commits follow Conventional Commits. Work happens on a branch and lands through a pull request.
