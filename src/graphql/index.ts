/**
 * `@chrischall/mcp-utils/graphql` — a GraphQL-over-HTTP transport and a
 * GraphQL operation-kind lexer.
 *
 * Zero optional peers (it builds on the core `http`, `errors` and `cancel`
 * modules only). It is a subpath rather than part of the core barrel for the
 * same reason `/healthcheck` is: only the handful of GraphQL servers in the
 * fleet need it.
 *
 *  - {@link createGraphqlClient} — POST `{ query, variables, operationName }`,
 *    `errors[]` at any status, auth replay, CDN/WAF detection, timeout and
 *    cancellation, write-aware transport errors (vibo-mcp / thumbtack-mcp,
 *    chrischall/fleet-audit#1138, #1128).
 *  - {@link graphqlOperationKinds} / {@link isReadOnlyGraphqlDocument} — is a
 *    document a query, mutation or subscription (onehome-mcp / hemnet-mcp /
 *    booli-mcp / vibo-mcp, chrischall/fleet-audit#1080, #988, #1020).
 */

export * from './client.js';
export * from './operation-kind.js';
