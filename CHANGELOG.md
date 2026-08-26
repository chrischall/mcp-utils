# Changelog

## [0.16.0](https://github.com/chrischall/mcp-utils/compare/v0.15.0...v0.16.0) (2026-08-26)


### Features

* **session:** persist tokens and cookie sessions across process restarts ([#137](https://github.com/chrischall/mcp-utils/issues/137)) ([c873afa](https://github.com/chrischall/mcp-utils/commit/c873afa34ec650433fd8bb16cf5ea7e9888ca781))


### Bug Fixes

* **session:** don't destroy a valid refresh token on a transient failure ([#139](https://github.com/chrischall/mcp-utils/issues/139)) ([6b49fac](https://github.com/chrischall/mcp-utils/commit/6b49fac71f4ad3ffc3f6da8fa699740ad0bd03d2)), closes [#138](https://github.com/chrischall/mcp-utils/issues/138)


### Documentation

* **mcp-fleet-builder:** correct two egress rules the rollout disproved ([#132](https://github.com/chrischall/mcp-utils/issues/132)) ([30439a8](https://github.com/chrischall/mcp-utils/commit/30439a830d00921a04d305fa2a49061867b238f6))
* **mcp-fleet-builder:** don't fix a doc inaccuracy by inverting it ([#134](https://github.com/chrischall/mcp-utils/issues/134)) ([141b59a](https://github.com/chrischall/mcp-utils/commit/141b59ae186d70eb585c8e9b101e4f7c9e12d493))
* **mcp-fleet-builder:** how to derive mint.yaml egress, and package shape ([#131](https://github.com/chrischall/mcp-utils/issues/131)) ([179a96a](https://github.com/chrischall/mcp-utils/commit/179a96ae26077bd60074856cd3425c17d005aaa1))
* **mcp-fleet-builder:** mint.yaml must ship in npm files; receiver-safe fetch ([#128](https://github.com/chrischall/mcp-utils/issues/128)) ([5a7d650](https://github.com/chrischall/mcp-utils/commit/5a7d650dd7098b1c8bf5af768e2a32765c95b9a2))
* **mcp-fleet-builder:** nit patterns from the mint.yaml follow-up sweep ([#133](https://github.com/chrischall/mcp-utils/issues/133)) ([3bfbf5d](https://github.com/chrischall/mcp-utils/commit/3bfbf5d18d4655c7cd44c289e70cee65d062d153))
* **mcp-fleet-builder:** npm test is not the CI command everywhere ([#135](https://github.com/chrischall/mcp-utils/issues/135)) ([96ca600](https://github.com/chrischall/mcp-utils/commit/96ca600c81b2b56f3c22e2bfa6b668282b92ac6a))
* **mcp-fleet-builder:** verify against origin/main, not a local clone ([#130](https://github.com/chrischall/mcp-utils/issues/130)) ([678434d](https://github.com/chrischall/mcp-utils/commit/678434d2ad541584bca89502c25253dc88246f6f))

## [0.15.0](https://github.com/chrischall/mcp-utils/compare/v0.14.2...v0.15.0) (2026-08-16)


### Features

* **server:** render a tool error's hint into the text callers see ([#126](https://github.com/chrischall/mcp-utils/issues/126)) ([563490f](https://github.com/chrischall/mcp-utils/commit/563490f7d79fcdd896b04527bab271ed7535d949))

## [0.14.2](https://github.com/chrischall/mcp-utils/compare/v0.14.1...v0.14.2) (2026-08-11)


### Documentation

* correct the stale fleet size in CLAUDE.md and README ([#124](https://github.com/chrischall/mcp-utils/issues/124)) ([8cdc7a3](https://github.com/chrischall/mcp-utils/commit/8cdc7a35f1d044d951c3a0ca990025fea5ea48c2)), closes [#123](https://github.com/chrischall/mcp-utils/issues/123)
* **fleet:** correct the hosting claim in the skill description ([#119](https://github.com/chrischall/mcp-utils/issues/119)) ([e5a1cb9](https://github.com/chrischall/mcp-utils/commit/e5a1cb9b615101fc40c5a04cae8c591c70418355))
* **fleet:** correct the stale fleet size in mcp-fleet-builder ([#122](https://github.com/chrischall/mcp-utils/issues/122)) ([397c3ca](https://github.com/chrischall/mcp-utils/commit/397c3ca65358632628de59150d6b58268e3a2b78)), closes [#121](https://github.com/chrischall/mcp-utils/issues/121)
* **fleet:** explain why stale capability claims keep getting repeated ([#120](https://github.com/chrischall/mcp-utils/issues/120)) ([052dcbd](https://github.com/chrischall/mcp-utils/commit/052dcbd081ffc78b9be5b56bae26b3633fae9862))
* **fleet:** record the fetchproxy scope-grant and auth-hardening lessons ([#117](https://github.com/chrischall/mcp-utils/issues/117)) ([d829b52](https://github.com/chrischall/mcp-utils/commit/d829b5217470cdc00148de3dd4510d724f16b29e))
* **fleet:** record the thumbtack-mcp build's corrections and new traps ([#118](https://github.com/chrischall/mcp-utils/issues/118)) ([db4368f](https://github.com/chrischall/mcp-utils/commit/db4368f77287dca53626cdfe807b6efb18cb419a))
* host on mcp-host instead of a per-repo Cloudflare Worker ([#114](https://github.com/chrischall/mcp-utils/issues/114)) ([d144ca3](https://github.com/chrischall/mcp-utils/commit/d144ca392b0e8d8c6d5977af4027824d62d27d19))

## [0.14.1](https://github.com/chrischall/mcp-utils/compare/v0.14.0...v0.14.1) (2026-08-06)


### Documentation

* **skills:** two fpx lessons from the eventbrite build ([#111](https://github.com/chrischall/mcp-utils/issues/111)) ([06cf4fe](https://github.com/chrischall/mcp-utils/commit/06cf4feee98093bded956dbbdd394e43ea82538e))

## [0.14.0](https://github.com/chrischall/mcp-utils/compare/v0.13.5...v0.14.0) (2026-07-29)


### Features

* **fetchproxy:** bump @fetchproxy/server to ^1.7.0 for the graphql capability ([#106](https://github.com/chrischall/mcp-utils/issues/106)) ([9aeb1dd](https://github.com/chrischall/mcp-utils/commit/9aeb1ddf844716573eb391107448ebc83f47f7cf))

## [0.13.5](https://github.com/chrischall/mcp-utils/compare/v0.13.4...v0.13.5) (2026-07-28)


### Documentation

* **skill:** CLOUDFLARE_ACCOUNT_ID is optional; don't paste wrangler's KV binding ([#105](https://github.com/chrischall/mcp-utils/issues/105)) ([fe52a99](https://github.com/chrischall/mcp-utils/commit/fe52a99002558d6b43356a6b8d66e8d73e5ccd40))
* **skill:** fold the kiaaccess-mcp lessons into mcp-fleet-builder ([#102](https://github.com/chrischall/mcp-utils/issues/102)) ([89bcabf](https://github.com/chrischall/mcp-utils/commit/89bcabf40aac6f176b92d490c8292367ab0b6559))
* **skill:** shape-based redactors miss passwords; assert outcomes not mechanisms ([#104](https://github.com/chrischall/mcp-utils/issues/104)) ([91788b2](https://github.com/chrischall/mcp-utils/commit/91788b2c2523491939dcbc1fceb80840e25741b5))

## [0.13.4](https://github.com/chrischall/mcp-utils/compare/v0.13.3...v0.13.4) (2026-07-25)


### Documentation

* **mcp-fleet-builder:** add the detached-fetch connector trap ([#96](https://github.com/chrischall/mcp-utils/issues/96)) ([c12bc67](https://github.com/chrischall/mcp-utils/commit/c12bc67dc424f0dc431fc7371dea3d441b96a148))

## [0.13.3](https://github.com/chrischall/mcp-utils/compare/v0.13.2...v0.13.3) (2026-07-19)


### Documentation

* **mcp-fleet-builder:** correct the CI gate, ruleset script and first-release version ([#94](https://github.com/chrischall/mcp-utils/issues/94)) ([c6fcb6f](https://github.com/chrischall/mcp-utils/commit/c6fcb6f3b7ef874876a5ba902bcf0e3275ada694))

## [0.13.2](https://github.com/chrischall/mcp-utils/compare/v0.13.1...v0.13.2) (2026-07-19)


### Documentation

* replace duplicated fleet policy with a pointer ([#93](https://github.com/chrischall/mcp-utils/issues/93)) ([a7a7bca](https://github.com/chrischall/mcp-utils/commit/a7a7bca68a577c42cfc5848ea896dbe35d20f473))
* **skill:** add hosted Cloudflare Worker connector to mcp-fleet-builder ([#89](https://github.com/chrischall/mcp-utils/issues/89)) ([1228d13](https://github.com/chrischall/mcp-utils/commit/1228d13c8faaa0f6dd343ac0f0069252f303b8bf))
* **skill:** add the global-scope-constructor Worker-startup gotcha ([#91](https://github.com/chrischall/mcp-utils/issues/91)) ([e056cad](https://github.com/chrischall/mcp-utils/commit/e056cad24ce64fc4f165e81471466d632d2f0cec))
* **skill:** add the per-session inline-IO Worker gotchas ([#92](https://github.com/chrischall/mcp-utils/issues/92)) ([ab5f9a6](https://github.com/chrischall/mcp-utils/commit/ab5f9a6a4025805991cf8b7e1384d3cb28d1a6f9))

## [0.13.1](https://github.com/chrischall/mcp-utils/compare/v0.13.0...v0.13.1) (2026-07-13)


### Documentation

* **fleet-builder:** curl-vs-fpx by reachability; claude.ai reach as the MCP trigger ([#87](https://github.com/chrischall/mcp-utils/issues/87)) ([9577f66](https://github.com/chrischall/mcp-utils/commit/9577f661d5793a8f9306350a6d61a116138a2f97))
* **fleet-builder:** fpx-skill authoring gotchas from the 25-skill build ([#88](https://github.com/chrischall/mcp-utils/issues/88)) ([eec0e10](https://github.com/chrischall/mcp-utils/commit/eec0e10e589305e3276a42397ee56033688c7c26))
* **fleet-builder:** lead with fpx-skill-first, full MCP only on request ([#84](https://github.com/chrischall/mcp-utils/issues/84)) ([1e513ee](https://github.com/chrischall/mcp-utils/commit/1e513eefa8bc8fba91af6402a38823ee527eb212))

## [0.13.0](https://github.com/chrischall/mcp-utils/compare/v0.12.0...v0.13.0) (2026-07-09)


### Features

* **fetchproxy:** pass domSelectors through for read_dom ([#82](https://github.com/chrischall/mcp-utils/issues/82)) ([ae00877](https://github.com/chrischall/mcp-utils/commit/ae008779c0ac5504d70b55908966d3f6a814c229))

## [0.12.0](https://github.com/chrischall/mcp-utils/compare/v0.11.0...v0.12.0) (2026-07-07)


### Features

* **fetchproxy:** classifyThrown detail hook; add ./scrape subpath export ([#78](https://github.com/chrischall/mcp-utils/issues/78)) ([d9d1bc9](https://github.com/chrischall/mcp-utils/commit/d9d1bc93e9a9148d72eabc92cdca419cd8f9b700))

## [0.11.0](https://github.com/chrischall/mcp-utils/compare/v0.10.5...v0.11.0) (2026-07-06)


### Features

* **session:** CookieSessionManager maxAgeMs, seed(), and onReplayLoginError hooks ([#69](https://github.com/chrischall/mcp-utils/issues/69)) ([453e1c6](https://github.com/chrischall/mcp-utils/commit/453e1c6c78c3009b16924bdaad9cfc64313757b6))
* wave-2 shared helpers — response cache, scrape module, Retry-After, binary output, cached tokens ([#66](https://github.com/chrischall/mcp-utils/issues/66)) ([7ddcedc](https://github.com/chrischall/mcp-utils/commit/7ddcedc1e60a0118bd22e6a9b0f4520a05926f58))


### Bug Fixes

* address wave-2 + session-hooks review follow-ups (Retry-After fallback cap, cache.get tier param, seed() tests) ([#71](https://github.com/chrischall/mcp-utils/issues/71)) ([b6d4f78](https://github.com/chrischall/mcp-utils/commit/b6d4f784c013baa0cc6eac88bffe04af3a2502d3))
* **errors,fs:** redact JSON-body secrets and guard writeBinaryOutput baseName traversal ([#76](https://github.com/chrischall/mcp-utils/issues/76)) ([e36652a](https://github.com/chrischall/mcp-utils/commit/e36652a87678d87996d9322e2f6c777833c7eeb5))
* **scrape,html:** eliminate ReDoS in JSON-LD/OpenGraph/plain-text extractors ([#74](https://github.com/chrischall/mcp-utils/issues/74)) ([32a7a76](https://github.com/chrischall/mcp-utils/commit/32a7a762f4ea6f211a12cc4a4ab870a1a6cfa559))

## [0.10.5](https://github.com/chrischall/mcp-utils/compare/v0.10.4...v0.10.5) (2026-07-02)


### Documentation

* fold alltrails-mcp learnings into mcp-fleet-builder ([#65](https://github.com/chrischall/mcp-utils/issues/65)) ([d6bddbb](https://github.com/chrischall/mcp-utils/commit/d6bddbb34b6261b196ad02f9c83ace7df6489856))
* **skill:** fold alltrails-mcp lessons into mcp-fleet-builder ([#64](https://github.com/chrischall/mcp-utils/issues/64)) ([466d213](https://github.com/chrischall/mcp-utils/commit/466d21325fb353bcedbbe8761e4a6ac7ff04b99e))
* **skill:** fold flightaware-mcp lessons into mcp-fleet-builder ([#62](https://github.com/chrischall/mcp-utils/issues/62)) ([27fbd31](https://github.com/chrischall/mcp-utils/commit/27fbd31ebcf822c859736a77cb55cc7b507ad3f9))

## [0.10.4](https://github.com/chrischall/mcp-utils/compare/v0.10.3...v0.10.4) (2026-06-15)


### Documentation

* add CLAUDE.md with project context and auto-review follow-up convention ([#58](https://github.com/chrischall/mcp-utils/issues/58)) ([4d1ec4e](https://github.com/chrischall/mcp-utils/commit/4d1ec4edccc03e45a60358512e147ba4431d79ab))

## [0.10.3](https://github.com/chrischall/mcp-utils/compare/v0.10.2...v0.10.3) (2026-06-12)


### Documentation

* **skill:** capture shared-workflow adoption + bootstrap learnings ([#56](https://github.com/chrischall/mcp-utils/issues/56)) ([530bfa1](https://github.com/chrischall/mcp-utils/commit/530bfa1165a9458b54f1d5283489457ec72fa81b))

## [0.10.2](https://github.com/chrischall/mcp-utils/compare/v0.10.1...v0.10.2) (2026-06-12)


### Bug Fixes

* bot PRs bypass the CI gate unconditionally ([#52](https://github.com/chrischall/mcp-utils/issues/52)) ([3b8f692](https://github.com/chrischall/mcp-utils/commit/3b8f692e3cf3f05737729bbbca1363718f3edefb))


### Documentation

* add MIT LICENSE file and README badges ([#49](https://github.com/chrischall/mcp-utils/issues/49)) ([aab0e5a](https://github.com/chrischall/mcp-utils/commit/aab0e5adb0e18fc6d7b64f34d7e246be134ce8ea))

## [0.10.1](https://github.com/chrischall/mcp-utils/compare/v0.10.0...v0.10.1) (2026-06-10)


### Documentation

* correct SafePathSegment's JSDoc — it's a denylist, not an allowlist ([#46](https://github.com/chrischall/mcp-utils/issues/46)) ([598db82](https://github.com/chrischall/mcp-utils/commit/598db82caf1ad2f96dde89e16636652ca52c8784))
* **skill:** refresh mcp-fleet-builder surface for 0.7–0.10 ([#48](https://github.com/chrischall/mcp-utils/issues/48)) ([5223523](https://github.com/chrischall/mcp-utils/commit/52235237b5fd92a3a54e663ef9db1580144380e2))

## [0.10.0](https://github.com/chrischall/mcp-utils/compare/v0.9.0...v0.10.0) (2026-06-10)


### Features

* **concurrency:** add zero-dep mapWithConcurrency core helper ([#43](https://github.com/chrischall/mcp-utils/issues/43)) ([9e1e3de](https://github.com/chrischall/mcp-utils/commit/9e1e3de1d24448c0f1e9cb4d8c3932b4d7f183c7))
* **fetchproxy:** opt-in banner, serverVersion in status(), mock-injectable server ([#44](https://github.com/chrischall/mcp-utils/issues/44)) ([8b76761](https://github.com/chrischall/mcp-utils/commit/8b7676125efb46ecf4f971914da3048f423be020))

## [0.9.0](https://github.com/chrischall/mcp-utils/compare/v0.8.0...v0.9.0) (2026-06-10)


### Features

* **session:** add optional mark_active to registerSessionTools register tool ([#41](https://github.com/chrischall/mcp-utils/issues/41)) ([a78ed37](https://github.com/chrischall/mcp-utils/commit/a78ed37446f40d0e56583e6d46048b83338a4e14))
* **session:** CookieSessionManager — optional isExpired + generic response type ([#40](https://github.com/chrischall/mcp-utils/issues/40)) ([7f8d87f](https://github.com/chrischall/mcp-utils/commit/7f8d87ffe401d1d7a776ada3216efd2c0e8b609c))

## [0.8.0](https://github.com/chrischall/mcp-utils/compare/v0.7.0...v0.8.0) (2026-06-09)


### Features

* config/zod helpers for the fleet (cached JSON loader, readPortEnv, path-segment atoms, decodeJwtClaim) ([#37](https://github.com/chrischall/mcp-utils/issues/37)) ([fdbaecd](https://github.com/chrischall/mcp-utils/commit/fdbaecd6782c0474b3b9ffa1e41076fa551638a0))
* **fetchproxy:** transport verb adapters + bridge-healthcheck tool factory ([#38](https://github.com/chrischall/mcp-utils/issues/38)) ([624f45e](https://github.com/chrischall/mcp-utils/commit/624f45e20ee19e2aee811216a4cb44a2ce4e7b68))
* **http:** add parseCookieHeader, UpstreamHttpError, runBoundedBatch ([#35](https://github.com/chrischall/mcp-utils/issues/35)) ([60c9680](https://github.com/chrischall/mcp-utils/commit/60c96803c637e39d47e73376e48266dbd17973f0))
* **session:** add CookieSessionManager (cookie-session analog of TokenManager) ([#36](https://github.com/chrischall/mcp-utils/issues/36)) ([6a17874](https://github.com/chrischall/mcp-utils/commit/6a178746b08497d1d64f51db79628aeb7577dd81))

## [0.7.0](https://github.com/chrischall/mcp-utils/compare/v0.6.0...v0.7.0) (2026-06-09)


### Features

* **auth:** preserve fetchproxy bridge-down hints in createAuthResolver ([#33](https://github.com/chrischall/mcp-utils/issues/33)) ([2dc77cc](https://github.com/chrischall/mcp-utils/commit/2dc77cc62cf9439157ca1314e3da5a6add63e052))


### Documentation

* **skill:** add rate-limited-public-API + OAuth-writes archetype ([#30](https://github.com/chrischall/mcp-utils/issues/30)) ([85dc246](https://github.com/chrischall/mcp-utils/commit/85dc246e967b7c805cb6ff30ae1305b0d1a4df25))
* **skill:** fleet-builder learnings from gemini-mcp build ([#27](https://github.com/chrischall/mcp-utils/issues/27)) ([1279fa9](https://github.com/chrischall/mcp-utils/commit/1279fa9e2b14bc64ed6b778b53f720636db69b8b))
* **skill:** verify new knobs/Beta endpoints live; squash-merge stale-branch recovery ([#29](https://github.com/chrischall/mcp-utils/issues/29)) ([246f7d3](https://github.com/chrischall/mcp-utils/commit/246f7d3552948d0b8ba69a77de3bec2b2627ba40))

## [0.6.0](https://github.com/chrischall/mcp-utils/compare/v0.5.3...v0.6.0) (2026-06-07)


### Features

* add request timeout to createApiClient and date-format helpers ([#25](https://github.com/chrischall/mcp-utils/issues/25)) ([ae0ec11](https://github.com/chrischall/mcp-utils/commit/ae0ec113b01269517de32ae4fde053b3703f232f))

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
