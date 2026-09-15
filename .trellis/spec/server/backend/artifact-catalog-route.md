# Artifact Catalog Route (`serverArtifactRoutes.ts`)

## 1. Scope / Trigger

- The workspace `ArtifactCatalogPanel` polls the catalog every 5 s for the selected stage.
- Trigger: Changes driven by Claude Code or Codex never run on the artifact runtime, so a stage has no attempts. The
  route answered `400 缺少合法 stageAttemptId/stageId` for every such stage, and the browser logged a failed request on
  every poll (the panel already rendered an empty state).

## 2. Signatures

```http
GET /api/artifacts/catalog?root=<abs>&change=<name>&stageAttemptId=<id>|stageId=<id>
    [&includeHistory=true][&includeCandidates=true][&maxEntries=<n>][&cursor=<c>][&pinned=true]
```

```ts
resolveArtifactRoute(req, res, path, deps: ArtifactRouteDeps): Promise<boolean>
ArtifactService.attempts?(stageId?: string): Promise<readonly { stageId; stageAttemptId; startedAt }[]>
```

## 3. Contracts

- Ids must match `^[a-zA-Z0-9._:-]{1,160}$`.
- A valid `stageAttemptId` selects that attempt.
- Otherwise a valid `stageId` selects the attempt with the latest `startedAt`.
- A valid `stageId` with no attempts answers
  `200 { "ok": true, "catalog": { "revision": 0, "digest": "", "stageAttemptId": "", "entries": [] } }` — the same
  empty catalog the Dashboard client decoder accepts (`revision` number, `digest` string, `stageAttemptId` string,
  `entries` array).

## 4. Validation & Error Matrix

| Condition | Response |
| --- | --- |
| `root` missing | `400 缺少 root 参数` |
| `root` not an allowed workflow root | `403` / `404` from `workflowRootForRequest` |
| Artifact service cannot open | `404` with the error text |
| Neither a valid `stageAttemptId` nor a valid `stageId` | `400 缺少合法 stageAttemptId/stageId` |
| Valid `stageId`, no attempts | `200` empty catalog, `service.catalog` not called |
| Valid `stageId` with attempts | `200` catalog of the latest attempt |

## 5. Good / Base / Bad Cases

- Good: `stageId=build` with two attempts → catalog of the newer one.
- Base: host-driven Change, `stageId=explore` → `200` empty catalog, no console error.
- Bad: `stageId=bad id!` → still `400`.

## 6. Tests Required

- `server/src/serverArtifactRoutes.test.ts`: empty catalog for a stage without attempts (and `catalog` not called);
  latest attempt served for a stage with runs; `400` without ids and for an invalid `stageId`.

## 7. Wrong vs Correct

### Wrong

```ts
if (!attempt) { deps.sendJson(res, 400, { ok: false, error: '缺少合法 stageAttemptId/stageId' }); return true }
```

### Correct

```ts
if (!attempt && stageId) { deps.sendJson(res, 200, { ok: true, catalog: { revision: 0, digest: '', stageAttemptId: '', entries: [] } }); return true }
if (!attempt) { deps.sendJson(res, 400, { ok: false, error: '缺少合法 stageAttemptId/stageId' }); return true }
```
