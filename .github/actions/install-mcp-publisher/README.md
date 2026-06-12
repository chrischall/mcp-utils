# install-mcp-publisher — MOVED

This action now lives in [chrischall/workflows](https://github.com/chrischall/workflows):

```yaml
- uses: chrischall/workflows/.github/actions/install-mcp-publisher@main
```

It moved with the fleet pipeline consolidation (2026-06); the fleet's release
workflows reference it there via the `mcp-publish` composite action. Old
`chrischall/mcp-utils/.github/actions/install-mcp-publisher@<tag>` refs keep
working for existing tags but receive no further version/checksum bumps.
