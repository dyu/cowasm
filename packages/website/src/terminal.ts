import "xterm/css/xterm.css";
import { Terminal } from "xterm";
import setTheme from "./theme";
import pythonWasm from "python-wasm";

export default async function terminal(element: HTMLDivElement) {
  const term = new Terminal({ convertEol: true });
  term.open(element);
  const python = await pythonWasm();
  // @ts-ignore
  element.children[0].style.padding = "15px";
  term.resize(80, 40);
  setTheme(term, "solarized-light");
  term.onData((data) => {
    python.kernel.writeToStdin(data);
  });
  python.kernel.on("stdout", (data) => {
    term.write(data);
  });
  python.kernel.on("stderr", (data) => {
    term.write(data);
  });
  await python.terminal();
  python.kernel.terminate();
}
