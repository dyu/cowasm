import WASI, { createFileSystem } from "@wapython/wasi";

import type { WASIConfig, FileSystemSpec, WASIBindings } from "@wapython/wasi";
import reuseInFlight from "../reuseInFlight";
import WasmInstance from "./instance";

const textDecoder = new TextDecoder();

export function strlen(charPtr: number, memory: WebAssembly.Memory): number {
  const mem = new Uint8Array(memory.buffer);
  let i = charPtr;
  while (mem[i]) {
    i += 1;
  }
  return i - charPtr;
}

export interface Options {
  noWasi?: boolean; // if false, include wasi
  wasmEnv?: object; // functions to include in the environment
  env?: { [name: string]: string }; // environment variables
  fs?: FileSystemSpec[]; // if not given, code has full native access to /
  time?: boolean;
  // init = initialization function that gets called when module first loaded.
  init?: (wasm: WasmInstance) => void | Promise<void>;
  traceSyscalls?: boolean;
  traceStubcalls?: "first" | true;
  spinLock?: (time: number) => void;
  stdinBuffer?: SharedArrayBuffer;
  signalBuffer?: SharedArrayBuffer;
  waitForStdin?: () => Buffer;
  sendStdout?: (Buffer) => void;
  sendStderr?: (Buffer) => void;
}

const cache: { [name: string]: any } = {};

type WasmImportFunction = (
  name: string,
  source,
  bindings: WASIBindings,
  options?: Options,
  log?: (...args) => void
) => Promise<WasmInstance>;

async function doWasmImport(
  name: string, // this is only used for caching and printing
  source: Buffer | Promise<any>, // contents of the .wasm file or promise returned by fetch (in browser).
  bindings: WASIBindings,
  options: Options = {},
  log?: (...args) => void
): Promise<WasmInstance> {
  log?.("doWasmImport", name);
  if (cache[name] != null) {
    return cache[name];
  }
  const t = new Date().valueOf();

  const memory = new WebAssembly.Memory({ initial: 10000 });
  const table = new WebAssembly.Table({ initial: 10000, element: "anyfunc" });

  function recvString(ptr: number, len?: number) {
    if (len == null) {
      // no len given, so assume it is a null terminated string.
      if (wasm.exports.stringLength != null) {
        // probably faster in WASM?  TODO: benchmark
        len = wasm.exports.stringLength(ptr);
      } else {
        len = strlen(ptr, memory);
      }
      if (len == null) throw Error("bug - stringLength must return len");
    }
    const slice = memory.buffer.slice(ptr, ptr + len);
    return textDecoder.decode(slice);
  }

  const wasmEnv = {
    reportError: (ptr, len: number) => {
      // @ts-ignore
      const slice = memory.buffer.slice(ptr, ptr + len);
      const textDecoder = new TextDecoder();
      throw Error(textDecoder.decode(slice));
    },
  };

  // NOTE: if we want to try to use WebAssembly.Table for something,
  // then set env.__indirect_function_table to it.  The name
  // __indirect_function_table is the arbitrary hardcoded name that zig
  // just happens to use for the table it imports when you compile
  // with --import-table. I only figured this out by decompiling and reading. See
  // https://github.com/ziglang/zig/pull/10382/files#diff-e2879374d581d6e9422f4f6f09ae3c8ee5f429f7581d7b899f3863319afff4e0R648
  const wasmOpts: any = {
    env: {
      ...wasmEnv,
      ...options.wasmEnv,
      memory,
      __indirect_function_table: table,
    },
  };

  let wasm;

  if (wasmOpts.env.wasmGetSignalState == null) {
    wasmOpts.env.wasmGetSignalState = () => {
      return 0;
    };
  }
  if (wasmOpts.env.wasmSendString == null) {
    wasmOpts.env.wasmSendString = (ptr: number, len: number) => {
      wasm.result = recvString(ptr, len);
    };
  }
  if (wasmOpts.env.wasmSetException == null) {
    wasmOpts.env.wasmSetException = () => {
      wasm.resultException = true;
    };
  }
  if (wasmOpts.env.getrandom == null) {
    wasmOpts.env.getrandom = (bufPtr, bufLen, _flags) => {
      // NOTE: returning 0 here (our default stub behavior)
      // would result in Python hanging on startup!
      bindings.randomFillSync(
        // @ts-ignore
        new Uint8Array(memory.buffer),
        bufPtr,
        bufLen
      );
      return bufLen;
    };
  }
  if (wasmOpts.env.getpid == null) {
    wasmOpts.env.getpid = () => {
      if (options.traceStubcalls) {
        stub(
          "getpid",
          "returning 1",
          [],
          options.traceStubcalls == "first",
          log
        );
      }
      return 1;
    };
  }
  if (wasmOpts.env.main == null) {
    wasmOpts.env.main = () => {
      return 0;
    };
  }

  // dlopen implementation -- will move to dlopen/ subdirectory once I figure out how this works!
  // OK, I explained to myself how to actually fully solve all this here:
  //    https://cocalc.com/projects/369491f1-9b8a-431c-8cd0-150dd15f7b11/files/work/2022-07-18-ws-diary.board#id=55096f05
  // I think, and this is obviously by far my top priority now.
  if (wasmOpts.env.dlopen == null) {
    const log = console.log;

    wasmOpts.env._PyImport_InitFunc_TrampolineCall = (ptr: number): number => {
      log?.(`dlopen - _PyImport_InitFunc_TrampolineCall - ptr=${ptr}`);
      // TODO
      throw Error("not implemented");
      return 0;
    };

    wasmOpts.env._PyCFunctionWithKeywords_TrampolineCall = (
      ptr: number,
      self: number,
      args: number,
      kwds: number
    ) => {
      log?.(`dlopen - _PyCFunctionWithKeywords_TrampolineCall - ptr=${ptr}`, self, args, kwds);
      throw Error("not implemented");
      // return getFunction(ptr)(self, args, kwds);
    };
  }

  let wasi: WASI | undefined = undefined;
  let fs: FileSystem | undefined = undefined;
  if (!options?.noWasi) {
    const opts: WASIConfig = {
      preopens: { "/": "/" },
      bindings,
      args: process.argv,
      env: options.env,
      traceSyscalls: options.traceSyscalls,
      spinLock: options.spinLock,
      waitForStdin: options.waitForStdin,
      sendStdout: options.sendStdout,
      sendStderr: options.sendStderr,
    };
    if (options.fs != null) {
      // explicit fs option given, so create the bindings.fs object, which is typically
      // a union of several filesystems...
      fs = createFileSystem(options.fs, bindings);
      opts.bindings = {
        ...bindings,
        fs,
      };
    }
    wasi = new WASI(opts);
    wasmOpts.wasi_snapshot_preview1 = wasi.wasiImport;
  }

  function stubProxy(env) {
    return new Proxy(env, {
      get(target, key) {
        if (key in target) {
          if (new String(key).includes("Py")) log?.("using existing for ", key);
          return Reflect.get(target, key);
        }
        if (options.traceStubcalls) {
          if (new String(key).includes("Py")) log?.("creating stub for", key);
          return (...args) => {
            stub(
              key,
              "returning 0",
              args,
              options.traceStubcalls == "first",
              log
            );
            return 0;
          };
        } else {
          // faster to not trace or even check, obviously.
          return () => 0;
        }
      },
    });
  }

  wasmOpts.env = stubProxy(wasmOpts.env);

  if (source == null) {
    throw Error("source must be defined for now...");
  }
  let result;
  if (source instanceof Promise) {
    // This is in a web browser, which has WebAssembly.instantiateStreaming
    // whereas node doesn't.
    result = await WebAssembly.instantiateStreaming(source, wasmOpts);
  } else {
    // This is in node, or in browser without doing a streaming load.
    const typedArray = new Uint8Array(source);
    result = await WebAssembly.instantiate(typedArray, wasmOpts);
  }

  if (wasi != null) {
    // wasi assumes this:
    wasi.start(result.instance, memory);
  }
  if (result.instance.exports.__wasm_call_ctors != null) {
    // We also **MUST** explicitly call the WASM constructors. This is
    // a library function that is part of the zig libc code.  We have
    // to call this because the wasm file is built using build-lib, so
    // there is no main that does this.  This call does things like
    // setup the filesystem mapping.    Yes, it took me **days**
    // to figure this out, including reading a lot of assembly code. :shrug:
    (result.instance.exports.__wasm_call_ctors as CallableFunction)();
  }

  wasm = new WasmInstance(result.instance.exports, memory, fs);
  if (options.init != null) {
    await options.init(wasm);
    // Uncomment this for low level debugging, so that the broken wasm
    // module gets returned.
    /*
    try {
      await options.init(wasm);
    } catch (err) {
      console.warn(`WARNING: init of ${name} failed`, err);
    }
    */
  }

  cache[name] = wasm;

  if (options.time) {
    log?.(`imported ${name} in ${new Date().valueOf() - t}ms`);
  }
  // TODO
  (wasm as any).table = table;

  return wasm;
}

const wasmImport: WasmImportFunction = reuseInFlight(doWasmImport, {
  createKey: (args) => args[0],
});
export default wasmImport;

const stubUsed = new Set<string>([]);
function stub(functionName, behavior, args, firstOnly, log) {
  if (firstOnly) {
    if (stubUsed.has(functionName)) return;
    stubUsed.add(functionName);
  }
  log?.(`WARNING STUB - ${functionName}: `, behavior, args);
}
