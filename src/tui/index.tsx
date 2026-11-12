import { render } from "ink";
import { App, type AppOptions } from "../app.ts";
import { Screen } from "./screen.tsx";
import { Store } from "./store.ts";

export async function runTui(opts: AppOptions, version: string) {
  const store = new Store();
  const app = new App(opts, {
    onEvent: store.onEvent,
    ask: store.ask,
    note: (text, tone) => store.note(text, tone),
    changed: store.changed,
    output: store.output,
  });
  store.root = app.root;
  await app.start();
  store.add(" ", `\x1b[1mheyho\x1b[0m \x1b[2mv${version} · ${app.profile.model} on ${app.server} · ${app.contextSize} tokens of context\n${app.root}\x1b[0m`);
  if (app.resumed) store.note(`Continuing the session from ${app.resumed.when.toLocaleString()}: "${app.resumed.first}"`, "dim");
  const ink = render(<Screen app={app} store={store} version={version} />, { exitOnCtrlC: false, patchConsole: false });
  await ink.waitUntilExit();
}
