# Changelog

This project follows [Semantic Versioning](https://semver.org/) and the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format. The JSON contract has its own version (`schemaVersion`).

## [Unreleased]

## [0.1.0] - 2026-11-10

### Added

- Commands `init`, `add`, `install`, `list`, `outdated`, `update`, `remove`, `search`, `info`, `scan`, `registry add|list|remove|export`, `version`.
- JSON contract 1.0 (`schemas/cli-output.v1.schema.json`), validated by the tests on every command.
- Two-step installation: `--dry-run`, then `--yes --expect-plan <planHash>`.
- Dependency-free TypeScript client (`@agenteca/cli/client`).
- Interoperability test with `apm` 0.35.0.
- Messages in English, French, Spanish, Chinese and Hindi: `--lang`, `AHUB_LANG`, then `LC_ALL` / `LC_MESSAGES` / `LANG`.
