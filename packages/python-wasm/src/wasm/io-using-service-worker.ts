/*
Synchronous blocking IO using service workers and XMLHttpRequest,
in cases when can't use atomics.  By "IO", we also include "IO with
the system", e.g., signals.

This is inspired by the sync-message package.

References:

- https://github.com/alexmojaki/sync-message
- https://jasonformat.com/javascript-sleep/
- https://stackoverflow.com/questions/10590213/synchronously-wait-for-message-in-web-worker
- https://github.com/pyodide/pyodide/issues/1503

*/

import type { IOProvider } from "./types";
import { SIGINT } from "./constants";
import debug from "debug";
const log = debug("wasm:io-provider");

interface Options {
  getStdinAsync: () => Promise<Buffer>;
}

export default class IOProviderUsingServiceWorker implements IOProvider {
  private getStdinAsync: () => Promise<Buffer>;
  private waitingForStdin: boolean = false;

  constructor(options: Options) {
    log("IOProviderUsingXMLHttpRequest");
    this.getStdinAsync = options.getStdinAsync;
    this.initServiceWorker();
  }

  async initServiceWorker() {
    log("setting up service worker");
    // @ts-ignore this import.meta.url issue -- actually only consumed by webpack in calling code...
    const url = new URL("./worker/service-worker.js", import.meta.url);
    const registration = await navigator.serviceWorker.register(url, {
      scope: "/python-wasm",
    });
    console.log("registration = ", registration);
  }

  getExtraOptions() {
    return {};
  }

  signal(_sig: number = SIGINT): void {
    throw Error("signal -- not implemented");
  }

  sleep(milliseconds: number): void {
    log("sleep", milliseconds);
    throw Error("sleep -- not implemented");
  }

  private async _getStdin(): Promise<void> {
    log("getStdin: waiting...");
    try {
      this.waitingForStdin = true;
      // TODO

      const data = await this.getStdinAsync();
      log("got data", data);

      // TODO
    } catch (err) {
      // not much to do -- no way to report problem.
      log("failed to get data", err);
    } finally {
      this.waitingForStdin = false;
    }
  }

  getStdin(): void {
    // while this.waitingForStdin is true, stdinLock[0]
    // should be -1 unless something is very wrong.
    if (this.waitingForStdin) {
      log("getStdin: already waiting");
      return;
    }
    this._getStdin();
  }
}
