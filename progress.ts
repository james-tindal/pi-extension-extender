import { clearLine, cursorTo } from "node:readline";

export function progress(message = "", done = false) {
  const line = message ? `extension-extender: ${message}` : "";
  if (process.stderr.isTTY) {
    cursorTo(process.stderr, 0);
    clearLine(process.stderr, 0);
    process.stderr.write(line.slice(0, Math.max(1, process.stderr.columns - 1)));
    if (done) process.stderr.write("\n");
  } else if (message) {
    process.stderr.write(`${line}\n`);
  }
}
