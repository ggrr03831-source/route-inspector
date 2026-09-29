# Route Inspector

A userscript that shows, in the bottom-right corner of `chatgpt.com`, the **model-routing
metadata the server exposes to the client** for the current turn.

[中文说明](README.zh-CN.md)

## What it shows

| Row | Source field | Meaning |
|---|---|---|
| Request model | request body `model` | the model the client actually submitted |
| Routed model | `server_ste_metadata.metadata.model_slug` | the internal model the scheduler assigned |
| Answering model | `message.metadata.model_slug` | the model that produced the reply |
| Region / plan | `cluster_region` / `plan_type` | e.g. `us-east / plus` |

A grey "waiting…" means the server did **not** expose that field for this turn. The script
never guesses.

## What it does not do

- It does not read, store, or upload your prompts, replies, or chat history.
- It makes no network requests of its own.
- It does not modify any request.

It only pulls those four fields out of the one real turn stream at
`/backend-api/f/conversation`.

## Important boundary

**This is a faithful copy of the routing metadata the server exposed to your browser — not
proof of which weights a particular GPU loaded.**

If the server reports something wrong, this tool will faithfully show that wrong value. All
it demonstrates is what the server claims about itself.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Edge or Chrome).
2. Open `route-inspector.user.js`; Tampermonkey offers to install it.
3. Open `https://chatgpt.com/` and send a message.

The panel is hidden by default and appears only once you send a message, so it never covers
the interface. Drag it by the title bar; `—` hides it until your next message; `×` closes it
until you reload the page.

> If the script seems dead, check Tampermonkey's **global switch** first — right-click the
> toolbar icon, and make sure `Enabled` is not greyed out. That is by far the most common
> cause.

## Accuracy

Measured over 339 captured snapshots:

| Dimension | Result |
|---|---|
| Parsing | `parseErrors = 0`; chunked SSE, `[DONE]` markers and double-escaped JSON are all handled |
| Field recall | On current builds every tested page reported 4/4 fields; lower numbers on earlier builds were script bugs, not missing server data |
| Attribution | The panel only ever shows values that came from the current turn's own response stream |

## Known limitations

1. It depends on an **undocumented endpoint** (`/backend-api/f/conversation`). If the path or
   the payload shape changes, the script needs an update.
2. It fails safe: it shows "waiting…" and leaves ChatGPT working normally.
3. Web only. The **desktop app and CLI use a different transport (WebSocket)** and are out of
   scope.

## Self-test

```bash
node --check route-inspector.user.js
node test/ri-harness.mjs route-inspector.user.js   # 43 assertions, all should PASS
```

The harness builds a minimal DOM plus a fake streaming `Response` in Node and runs the
**unmodified shipped file**, covering the panel contract, the fetch/XHR hooks, `res.clone()`,
chunked SSE, multi-turn isolation, side-endpoint pollution and the window controls.

## License

MIT
