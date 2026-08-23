import type { ApiSnapshotRecord } from '../shared/types.js';

/**
 * Builds a `<script>` that monkey-patches `window.fetch` so any same-origin JSON call the page's
 * own JS makes at runtime transparently resolves to the captured snapshot instead of the network —
 * the page's code is untouched, only the network layer underneath it is redirected. Snapshot bodies
 * are embedded directly in the map (not fetched from a sibling file): browsers refuse to let `fetch`
 * load anything under the `file://` scheme, so redirecting to a local file would still break the
 * moment the mirror is opened without a server; constructing the `Response` in memory needs no
 * network access at all, so it works identically served or opened directly.
 */
export function buildApiSnapshotShim(apiSnapshots: ApiSnapshotRecord[]): string | null {
  if (apiSnapshots.length === 0) return null;

  const snapshotMap = Object.fromEntries(
    apiSnapshots.map((snapshot) => [
      snapshot.endpoint,
      { body: snapshot.body, contentType: snapshot.contentType },
    ]),
  );
  const mapLiteral = JSON.stringify(snapshotMap);

  return `<script>(function(){
    var snapshotMap = ${mapLiteral};
    var originalFetch = window.fetch ? window.fetch.bind(window) : null;
    if (!originalFetch) return;
    window.fetch = function (input, init) {
      var requestedUrl = typeof input === 'string' ? input : (input && input.url);
      var absoluteUrl = null;
      // A malformed requested URL just means it can't match a snapshot; fall through to the original fetch.
      try { absoluteUrl = requestedUrl ? new URL(requestedUrl, location.href).toString() : null; } catch {}
      var hasSnapshot = absoluteUrl && Object.prototype.hasOwnProperty.call(snapshotMap, absoluteUrl);
      if (hasSnapshot) {
        var snapshot = snapshotMap[absoluteUrl];
        return Promise.resolve(new Response(snapshot.body, { status: 200, headers: { 'content-type': snapshot.contentType } }));
      }
      return originalFetch(input, init);
    };
  })();</script>`;
}
