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
Additional parameters: `theme=dark`, `collapsed=1`, and settings `section=general|appearance|agents|skills|plugins|permissions|notifications|advanced`.

The fixed banner identifies this as sample data with no CLI connection. The isolated read-only transport never accesses the filesystem, spawns commands, or makes network requests. Mutating actions are intentionally unavailable. No production behavior is replaced outside this independent Vite configuration.

Type-check the fixtures with:

```sh
node_modules/.bin/tsc --noEmit -p test/ui/tsconfig.json
```

Optional fixture build: `node_modules/.bin/vite build --config test/ui/visual.vite.config.mts`. Output `.qa/visual-dist` is disposable and must not be included in source deliverables.
