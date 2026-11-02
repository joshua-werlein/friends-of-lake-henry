# Raffle video layout

The public player has no orientation selector. It uses validated dimensions,
then a portrait-safe fallback. Landscape is 16:9; portrait is 9:16 with a 440px
maximum video width. A dark padded frame centers either layout.

Graph v26.0 `GET /VIDEO_ID?fields=id,format` was verified by the administrator
for videos 39756815320632328 and 1706736221227932 on November 1, 2026.
Both returned 130x231, 480x853 and native 720x1280. Only native numeric
dimensions are retained as verified defaults. No embed HTML or temporary URLs
are used. Format support on other videos remains subject to permissions.

The shared parser chooses the largest valid format when all formats agree on
orientation. It can fall back to a matching post attachment's `media.image`
dimensions. Square, tiny, extreme, string-valued or conflicting dimensions are
ambiguous and fall back safely. Thumbnails may be cropped: admin override wins.

Admin > Raffle has an independent per-video layout control and optional sanitized
metadata input. This saves only `raffle_video_presentation:VIDEO_ID` in CONFIG;
it never changes raffle_live, winners, posters or selection timestamps. Existing
session and same-origin CSRF middleware protect the endpoint. Overrides can be
reversed by choosing Automatic. The public 15-second check updates CSS without
replacing an unchanged iframe.

This isolated UI release does not fetch Graph from the browser or access the
Worker secret. Future automatic discoveries can supply validated dimensions via
the same resolver; fetching metadata for arbitrary manual URLs needs a reviewed
private server-side integration. Until then unknown URLs use portrait or the
admin override. No Worker, Cron, binding or database changes are part of this release.

Rollback: restore the previous successful Pages deployment b7f33bb (deployment
80c3c81f-4bbc-4dc0-80c3-9da89d7119c4). Layout keys are harmless to that version.

Automation branch integration: eligible staged videos can provide validated numeric
dimensions to the shared presentation resolver. This is not deployed with the UI.
Per-video admin overrides still take priority. Thumbnail fallback is simulated;
Graph format was verified on the two real videos.
