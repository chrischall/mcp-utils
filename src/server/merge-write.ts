/**
 * Read-modify-write for full-replace update endpoints, built to feed
 * {@link confirmWrite}.
 *
 * Some APIs' update verb REPLACES the whole resource: Tempo v4's PUTs reset
 * "any fields not specified in the request ... to their default values or
 * removed". A body built from only the caller's arguments then silently wipes
 * every field the caller did not mention. The safe shape is: GET the current
 * resource, map it to the update input, lay the caller's defined fields over
 * it, and bind the resource's revision into the confirm token so an edit made
 * between the preview and the confirmed call is refused (DRAFT_CHANGED)
 * instead of overwritten.
 *
 * Hoisted from tempo-api-mcp `src/tools/_merge.ts` (`mergeOverCurrent`,
 * `revisionOf`, `UPDATE_MERGE_NOTE`), which its worklog / plan / team /
 * account update tools share — chrischall/fleet-audit#1180.
 *
 * ```ts
 * const { body, revision } = await prepareMergedUpdate({
 *   read: () => client.request('GET', `/4/worklogs/${id}`),
 *   toInput: worklogToUpdateInput,
 *   patch, // the tool's args minus id/confirmToken
 * });
 * const gate = await confirmWrite(ctx, {
 *   tool: 'tempo_update_worklog', action: 'worklog.update', account: undefined, target: id,
 *   revision, request: { method: 'PUT', path: `/4/worklogs/${id}`, body }, confirmToken,
 * });
 * if (gate) return gate;
 * await client.request('PUT', `/4/worklogs/${id}`, body);
 * ```
 *
 * Call it on EVERY invocation (phase 1 and the confirmed call) so the preview
 * shows the full merged body and phase 2 re-reads the revision.
 */

/** A plain JSON-ish object. */
type Obj = Record<string, unknown>;

function asObj(v: unknown): Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
}

/**
 * The tool-description sentence for a merged update — the generic form of
 * tempo's `UPDATE_MERGE_NOTE`. No leading space.
 */
export const MERGED_UPDATE_NOTE =
  'Fields you omit keep their current values: the tool reads the current resource and merges your fields over it '
  + '(the update replaces the whole resource, so one built from only the changed fields would wipe the rest). That '
  + 'read runs on every call, so the preview shows the full merged body, and a resource that changes between the '
  + 'preview and the confirmed call is refused rather than overwritten.';

/**
 * The current resource (already mapped to the update's input shape) with the
 * caller's fields on top. A patch field that is `undefined` or `null` keeps
 * the current value — so `null` cannot clear a field; send the API's own
 * "empty" value for that. Shallow: a patched nested object or array replaces
 * the current one whole. Neither input is mutated.
 */
export function mergeOverCurrent(current: Obj, patch: Obj): Obj {
  const out: Obj = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null) continue;
    // defineProperty, not assignment: a JSON-parsed "__proto__" key must land
    // as an own field, never as the result's prototype.
    Object.defineProperty(out, k, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * A resource's revision — a field the API rotates on every edit — for
 * {@link ConfirmWriteOptions.revision}. Reads `updatedAt` by default (Tempo);
 * pass another field name for an `etag` / `version`. A non-empty string is
 * returned as is and a finite number as its string form; anything else
 * (absent, empty, an object, a non-object resource) is `undefined`.
 */
export function revisionOf(raw: unknown, field = 'updatedAt'): string | undefined {
  const value = asObj(raw)[field];
  if (typeof value === 'string') return value === '' ? undefined : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Options for {@link prepareMergedUpdate}. */
export interface MergedUpdateOptions<R = unknown> {
  /** Fetch the current resource (a GET, or a search when the update key is not the read key). */
  read: () => Promise<R>;
  /**
   * Map the resource to the update's input shape — read-only and server-set
   * fields dropped, nested refs flattened to the ids the update takes.
   * Defaults to the resource itself (a non-object becomes `{}`).
   */
  toInput?: (raw: R) => Obj;
  /** The caller's fields; `undefined`/`null` ones keep the current value. */
  patch: Obj;
  /**
   * Edit the mapped current resource before the merge — e.g. drop a field
   * that only mirrored one the patch changes (tempo's `billableSeconds`), or
   * one that is mutually exclusive with a patched field. Gets a copy.
   */
  adjust?: (current: Obj, patch: Obj) => void;
  /**
   * Where the revision comes from: a field name (default `'updatedAt'`), a
   * function of the resource, or `false` when the API exposes none.
   */
  revision?: string | ((raw: R) => string | undefined) | false;
}

/** Result of {@link prepareMergedUpdate}. */
export interface MergedUpdate<R = unknown> {
  /** The full body to send (and to pass to `confirmWrite` as `request.body`). */
  body: Obj;
  /** The resource's revision, for `confirmWrite`'s `revision`; `undefined` when none. */
  revision: string | undefined;
  /** The resource as read. */
  raw: R;
  /** The mapped current resource after `adjust`, before the merge. */
  current: Obj;
}

/**
 * Read the current resource and build the full-replace body: `toInput(read())`,
 * then `adjust`, then {@link mergeOverCurrent} with `patch`; plus the
 * resource's revision. Sends nothing — pass `body`/`revision` to
 * {@link confirmWrite}, then write `body`. A failed read rejects as is.
 */
export async function prepareMergedUpdate<R = unknown>(options: MergedUpdateOptions<R>): Promise<MergedUpdate<R>> {
  const raw = await options.read();
  const current: Obj = { ...(options.toInput ? options.toInput(raw) : asObj(raw)) };
  options.adjust?.(current, options.patch);
  const body = mergeOverCurrent(current, options.patch);
  const source = options.revision ?? 'updatedAt';
  const revision = source === false ? undefined : typeof source === 'function' ? source(raw) : revisionOf(raw, source);
  return { body, revision, raw, current };
}
