import { homedir } from "node:os";
import { render } from "ink";
import { App, type AppOptions } from "../app.ts";
import { Screen } from "./screen.tsx";
import { Store } from "./store.ts";

// `resume` is what --resume was given: a name to reopen, or true to choose from a list.
export async function runTui(opts: AppOptions, version: string, resume?: string | true) {
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
  store.add(" ", `\x1b[1mheyho\x1b[0m \x1b[2mv${version} · ${app.profile.model} on ${app.server} · ${app.contextSize} tokens of context\n${app.root.replace(homedir(), "~")}\x1b[0m`);
  const named = typeof resume === "string" ? app.sessions().find((x) => x.first.toLowerCase().includes(resume.toLowerCase())) : undefined;
  if (named) {
    app.resume(named);
    store.note(`Reopened "${named.first}".`, "dim");
  } else if (typeof resume === "string") store.note(`No session here matches "${resume}". Choose one:`, "warn");
  for (const problem of app.problems) store.note(problem, "warn");
  if (app.resumed) store.note(`Continuing the session from ${app.resumed.when.toLocaleString()}: "${app.resumed.first}"`, "dim");
  const ink = render(<Screen app={app} store={store} version={version} pickSession={resume !== undefined && !named} />, { exitOnCtrlC: false, patchConsole: false });
  await ink.waitUntilExit();
}
