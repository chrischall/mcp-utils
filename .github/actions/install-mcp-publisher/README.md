# install-mcp-publisher

Shared composite action that downloads a **pinned, SHA-256-verified** `mcp-publisher`
binary (linux/amd64) and puts it on `PATH`. Used by the chrischall MCP fleet so the
version + checksum live in **one place** instead of in every repo's release workflow.

## Usage

In a `release-please.yml` (or publish) workflow's `publish` job, replace the inline
`curl …/releases/latest | tar xz` step with:

```yaml
      - name: Install mcp-publisher
        uses: chrischall/mcp-utils/.github/actions/install-mcp-publisher@main

      - name: Authenticate to MCP Registry (OIDC)
        run: mcp-publisher login github-oidc

      - name: Publish to MCP Registry
        run: mcp-publisher publish
```

The binary is on `PATH`, so call it as `mcp-publisher` (not `./mcp-publisher`).

## Bumping the pinned version

Edit `default-version` and `default-sha256` in [`action.yml`](./action.yml). Get the
SHA from the release's `registry_<version>_checksums.txt`
(`mcp-publisher_linux_amd64.tar.gz` line). Every repo referencing the action picks it
up on the next run — no per-repo change.

A caller can also override per-run: `with: { version: "1.8.0", sha256: "…" }`.

## Why pinned

Upstream MCP docs install via `releases/latest` with no verification. That binary runs
in the publish job with the OIDC token + `RELEASE_PAT` + `CLAWHUB_TOKEN`, so a mutated
`latest` asset would execute with real privileges. Pinning + `sha256sum -c` fails closed.
