# SCOW API contract evidence

Target: the deployed USTC portal identifies itself as `v1.9.11`, build `9sz5wwNLT-ld5o-FCGE5m`, in its [public page](https://107.ustc.edu.cn/). Evidence was collected without authentication or account mutations. Public source was pinned to [OpenSCOW 8de039b22c51f99c06d59f4337a962ceb46f85dd](https://github.com/PKUHPC/OpenSCOW/tree/8de039b22c51f99c06d59f4337a962ceb46f85dd). That commit is not asserted to be the private server version.

## Authentication and setup

- [`GET /api/auth/validateToken`](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/apps/portal-web/src/pages/api/auth/validateToken.ts#L18-L45) takes the raw SCOW_USER value in query `token`; success contains `identityId` and optional `name`; rejection is `403 null`. Identity fields are discarded by this client.
- The public [token implementation](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/apps/portal-web/src/auth/token.ts#L27-L40) can also translate an internal auth-service failure into unsuccessful validation. A rejection is not proof that a token has expired. REST rejection gates new operations and prompts verification; it does not delete stored credentials.
- [`/api/setup`](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/apps/portal-web/src/pages/api/setup.ts#L17-L30) installs WS listeners once per loaded server module and returns plain `Setup complete` or `Already setup`. It is unauthenticated, so its failure cannot establish token validity. The user already supplied a successful live observation; it was not repeated merely to confirm that report.
- [Cookie authentication](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/apps/portal-web/src/auth/server.ts#L24-L57) and file-operation errors differ. `401` is authentication rejection; file `403 PERMISSION_DENIED`/`NOT_ACCESSIBLE` and other authorization failures are permission errors, not automatic cookie-revocation evidence. Only the existing WSS 401/403 path automatically revokes credentials.

## Official file transport

Verified public routes: [download](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/apps/portal-web/src/pages/api/file/download.ts), [upload](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/apps/portal-web/src/pages/api/file/upload.ts), [initMultipartUpload](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/apps/portal-web/src/pages/api/file/initMultipartUpload.ts), [mergeFileChunks](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/apps/portal-web/src/pages/api/file/mergeFileChunks.ts), [fileExist](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/apps/portal-web/src/pages/api/file/fileExist.ts), [list](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/apps/portal-web/src/pages/api/file/list.ts), and [move](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/apps/portal-web/src/pages/api/file/move.ts).

The deployed [upload client](https://107.ustc.edu.cn/_next/static/chunks/1412-96e2620f29ce9563.js), modules 20214/related upload caller, confirms:

- Multipart binary field is `file`. `chunk` and `originPath` are URL query parameters, not multipart text fields.
- Init JSON is `{cluster,path,name}`, with destination directory `path`; response supplies `tempFileDir`, `chunkSizeByte`, `filesInfo`.
- A chunk filename is `<sha256-of-raw-chunk>_<one-based-index>.scowuploadtemp`; chunk size comes from the server, not a client constant. [Deployed SHA-256 helper](https://107.ustc.edu.cn/_next/static/chunks/5448-1599fb54b20e06c1.js), module 25329, hashes raw bytes.
- Merge JSON is `{cluster,path,name,sizeByte}`; `sizeByte` is the complete original file byte length, not the block length/count.
- The production daemon path initializes multipart for every file and uploads sequentially. Its final-block progress approximation can overcount; this client must count exact acknowledged bytes.
- The observed private helper interpolates `originPath` without explicit encoding. This client uses URLSearchParams so reserved characters cannot become extra query parameters; it does not reproduce that unsafe interpolation.
- `PATCH /api/file/move` has JSON `{cluster,fromPath,toPath}` and public success 204. No inspected upload/init/merge/move contract supplies exclusive creation or conditional replacement.

### Explicitly accepted limitations

The user approved official `fileExist` preflight semantics: existing destinations are rejected by default and overwrite requires explicit permission. This is **not atomic remote no-clobber**; another writer can race between checking and publication. Local final-file publication remains separately protected. The previous SSH/Base64 file-transport implementation must be removed, not retained as fallback.

Private temporary-directory ownership, sharing, expiry and safe deletion are not established. Cancellation must retain remote temporary state honestly instead of invoking generic deletion and claiming rollback. No automatic resume or reuse of unrelated existing chunks is implemented.

## Desktop and application connections

The [deployed desktop page](https://107.ustc.edu.cn/_next/static/chunks/pages/loginCluster-560dda8b25976b8c.js) consumes `userDesktops[].desktops[]` discriminated records and reads VNC metadata from `.vnc`. It sends `{cluster,loginNode,displayId,desktopInfo:{desktop:{$case:"vnc",vnc:{displayId}}}}` to launch and consumes `response.vnc`. Public master instead has flat desktop records/responses; no flat mock fallback is inferred for this private target. The user supplied successful live launch evidence for the nested request.

Public routes: [getAppSessions](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/apps/portal-web/src/pages/api/app/getAppSessions.ts), [connectToApp](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/apps/portal-web/src/pages/api/app/connectToApp.ts), [listAvailableApps](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/apps/portal-web/src/pages/api/app/listAvailableApps.ts). The [deployed sessions page](https://107.ustc.edu.cn/_next/static/chunks/pages/apps/%5BclusterId%5D/sessions-d8bfec1e4769a445.js) additionally sends `jobId` in the JSON POST connection request.

- `connectToApp` is POST JSON even when the resulting application connection method is GET.
- [Connection construction](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/apps/portal-web/src/pageComponents/app/ConnectToAppLink.tsx#L55-L98) substitutes HOST/PORT/PASSWORD and customFormData into paths and query values. Custom values are spread last. [The exact parser](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/libs/libconfig/src/parse.ts#L30-L38) matches `{{ HOST }}` with literal spaces and performs one replacement pass. URLSearchParams encodes query names/values afterward.
- Proxy type is `relative` or `absolute`. Only GET web applications and VNC are selected in this round; POST forms, desktop creation/WM selection and ShadowDesk are not selected.
- [VNC construction](https://github.com/PKUHPC/OpenSCOW/blob/8de039b22c51f99c06d59f4337a962ceb46f85dd/apps/portal-web/src/utils/vnc.ts#L17-L32) uses the portal hostname/port and `/api/proxy/{cluster}/absolute/{host}/{port}`. Passwords and complete credential-bearing URLs stay main-process-only; explicit open/copy actions never return them through IPC or persist them.

## Deferred and unexercised evidence

`GET /api/file/compressAndDownload` is registered in the [deployed API runtime](https://107.ustc.edu.cn/_next/static/chunks/pages/_app-3d8f1bcbda04c4f9.js), but its parameters and response/cleanup contract were not recovered. The user explicitly deferred directory archive download for this round. No placeholder or alternative remote compression mutation is presented as that feature.

No authorized private token/HAR was available. Positive live token checks, official binary transfers, native desktop entry and permission/quota behavior have not been verified against the private server. Static-client evidence closes request construction questions, not private-server field optionality or live success. Local fixtures are not substitutes for those acceptance results.
