# Changelog

## [0.5.3](https://github.com/chrischall/mcp-utils/compare/v0.5.2...v0.5.3) (2026-06-07)


### Documentation

* **skill:** add allow_auto_merge repo setting + neutral-description convention ([#23](https://github.com/chrischall/mcp-utils/issues/23)) ([0b92e75](https://github.com/chrischall/mcp-utils/commit/0b92e753702cc8702a7966f653f6c40d55fddded))

## [0.5.2](https://github.com/chrischall/mcp-utils/compare/v0.5.1...v0.5.2) (2026-06-06)


### Documentation

* **fleet-skill:** codify auth preference order (minimize fetchproxy) ([#21](https://github.com/chrischall/mcp-utils/issues/21)) ([f8b611e](https://github.com/chrischall/mcp-utils/commit/f8b611efbed6658624e905f3fb2ae95a8f0ff29c))

## [0.5.1](https://github.com/chrischall/mcp-utils/compare/v0.5.0...v0.5.1) (2026-06-06)


### Documentation

* **fleet-skill:** add cookie-session archetype + lessons from artsonia-mcp ([#19](https://github.com/chrischall/mcp-utils/issues/19)) ([3bcee90](https://github.com/chrischall/mcp-utils/commit/3bcee90ea1c9ba8fd93c59c6019d0b1223e17178))

## [0.5.0](https://github.com/chrischall/mcp-utils/compare/v0.4.0...v0.5.0) (2026-06-04)


### Features

* adopt [@fetchproxy](https://github.com/fetchproxy) 1.0.0 (captureHeaders { host, path?, headerName }) ([#18](https://github.com/chrischall/mcp-utils/issues/18)) ([45f6c4c](https://github.com/chrischall/mcp-utils/commit/45f6c4cd1ae80a6778b3d819b48ff235113e39be))


### Documentation

* **skill:** add auto-merge orphan gotcha + recover the private-repo provenance one ([#16](https://github.com/chrischall/mcp-utils/issues/16)) ([79fe6e8](https://github.com/chrischall/mcp-utils/commit/79fe6e81ad9e1634b30e6f3ba7eab2691f45f793))
* **skill:** capture fetchproxy lessons from the musescore-mcp build ([#15](https://github.com/chrischall/mcp-utils/issues/15)) ([66094d0](https://github.com/chrischall/mcp-utils/commit/66094d0ff6e548509edcafa6f5a29baf5f92aa52))
* **skill:** teach conventions + full git/release-please bootstrap ([#12](https://github.com/chrischall/mcp-utils/issues/12)) ([d0235c5](https://github.com/chrischall/mcp-utils/commit/d0235c514efb69101a94fc286edfa710221e2158))

## [0.4.0](https://github.com/chrischall/mcp-utils/compare/v0.3.0...v0.4.0) (2026-06-02)


### Features

* **fs:** fileBlob + readFileHead — stream uploads instead of buffering ([#9](https://github.com/chrischall/mcp-utils/issues/9)) ([df797bd](https://github.com/chrischall/mcp-utils/commit/df797bdcdc850a8a762551772db9d3eac2b9b0c6))

## [0.3.0](https://github.com/chrischall/mcp-utils/compare/v0.2.1...v0.3.0) (2026-06-02)


### Features

* **http:** multipart, reactive tokenManager, and baseHeaders in createApiClient ([#6](https://github.com/chrischall/mcp-utils/issues/6)) ([86ee3f6](https://github.com/chrischall/mcp-utils/commit/86ee3f6e799ed83f7076d66f5f092e7533a50b74))

## [0.2.1](https://github.com/chrischall/mcp-utils/compare/v0.2.0...v0.2.1) (2026-06-01)


### Documentation

* document the shared install-mcp-publisher action ([#4](https://github.com/chrischall/mcp-utils/issues/4)) ([b3d0444](https://github.com/chrischall/mcp-utils/commit/b3d0444ec8c882d4d28f5131a8f9feb90d053db5))

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
