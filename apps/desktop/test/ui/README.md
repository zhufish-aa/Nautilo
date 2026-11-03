# UI integration and visual QA

These fixtures import the real renderer. They are separate from the production entry and are never bundled into the desktop application.

## DOM behavior regression

With the repository dependencies installed and jsdom available in a separate tools directory, run from the repository root:

```sh
NAUTILO_JSDOM_PATH=/path/to/node_modules/jsdom node apps/desktop/test/ui/navigation-dom.cjs
```

The harness bundles the real App to a temporary directory, seeds clearly artificial data and checks navigation, legacy Code/Work session compatibility, bounded history rows, drafts, search/focus, selected-session deletion, drawer/lightbox keyboard handling and settings routes. The first-send check uses an in-memory bridge to record configuration and rejects the send before any CLI run or polling starts. It does not validate a live provider, desktop IPC, or browser pixel layout. Unexpected errors fail the test.

## Browser visual fixture

From the repository root:

```sh
cd apps/desktop
node_modules/.bin/vite --config test/ui/visual.vite.config.mts
```

Open `http://127.0.0.1:4179/visual.html?scenario=home` in the authorized browser.

Scenarios: `home`, `conversation`, `approval`, `projects`, `team`, `skills`, `settings`, `search`.
Additional parameters: `theme=dark`, `collapsed=1`, and settings `section=general|appearance|agents|accounts|usage|skills|plugins|permissions|notifications|advanced`.

The fixed banner identifies this as sample data with no CLI connection. The isolated read-only transport never accesses the filesystem, spawns commands, or makes network requests. Mutating actions are intentionally unavailable. No production behavior is replaced outside this independent Vite configuration.

Type-check the fixtures with:

```sh
node_modules/.bin/tsc --noEmit -p test/ui/tsconfig.json
```

Optional fixture build: `node_modules/.bin/vite build --config test/ui/visual.vite.config.mts`. Output `.qa/visual-dist` is disposable and must not be included in source deliverables.

Independent provider UI sample: `visual.html?scenario=settings&section=accounts`.
The connection list, revision lookup and model discovery are local synthetic responses with `.invalid` hosts and `/sample/` paths. Example prices and saved-key indicators are metadata only; no real credentials exist. Connection writes/removals remain deliberately blocked in the read-only visual fixture.

Focused connection interaction regression (real UI with a separate in-memory test transport):

```sh
NAUTILO_JSDOM_PATH=/path/to/node_modules/jsdom node apps/desktop/test/ui/connections-dom.cjs
```

## Session connection controls

Run `NAUTILO_JSDOM_PATH=/path/to/jsdom node apps/desktop/test/ui/session-controls-dom.cjs` to test the actual compact model/effort component with an in-memory bridge. Covers fixed Agent identity, connection confirmation/cancel/failure/retry, saved revision adoption, same-ID newer revision action, current-source model choices, active-versus-terminal lifecycle guards and team member resolution. No live provider or credential is used.
