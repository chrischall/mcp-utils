# Changelog

## [0.2.0](https://github.com/chrischall/mcp-utils/compare/v0.1.1...v0.2.0) (2026-06-01)


### ⚠ BREAKING CHANGES

* **zod:** toolAnnotations no longer emits idempotentHint/openWorldHint by default.

### Features

* **fetchproxy:** re-export the full @fetchproxy/server surface ([5e34cd1](https://github.com/chrischall/mcp-utils/commit/5e34cd1ab1e87be39c05cea35d7931d4fa3e18fb))
* **http:** add onUnauthorized/onRateLimited custom-error factories to createApiClient ([1e05ef5](https://github.com/chrischall/mcp-utils/commit/1e05ef5b95640872a7f5160fdf5e600da2ab2829))
* **zod:** make toolAnnotations hints opt-in and title optional ([80743e7](https://github.com/chrischall/mcp-utils/commit/80743e732759cf8f72f8c93b5a2b39dc183428f3))

## [0.1.1](https://github.com/chrischall/mcp-utils/compare/v0.1.0...v0.1.1) (2026-06-01)


### Bug Fixes

* **fetchproxy:** re-export raw classifyBridgeError + classifyRowError; rename envelope to bridgeErrorInfo ([45c238e](https://github.com/chrischall/mcp-utils/commit/45c238e9f7fd1460cbe3f11baa62a0d6a5b0f2c8))

## 0.1.0 (2026-05-31)

Initial release. Shared scaffolding for the chrischall MCP fleet — `server`
bootstrap, `response` tool-result formatting, helpful `errors`, hardened
`config`, a bearer `http` client kit, `zod` atoms, plus subpath modules
`/session`, `/fetchproxy`, `/html`, and `/test`. Zero-runtime-dep core; optional
peers kept behind subpaths.
