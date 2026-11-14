import { clearLine, cursorTo, moveCursor } from 'node:readline'

export function progress(message = '', done = false) {
  const line = message ? `extension-extender: ${message}` : ''
  if (process.stderr.isTTY) {
    cursorTo(process.stderr, 0)
    clearLine(process.stderr, 0)
    process.stderr.write(line.slice(0, Math.max(1, process.stderr.columns - 1)))
    if (done) process.stderr.write('\n')
  } else if (message) {
    process.stderr.write(`${line}\n`)
  }
}

const rowLine = (name: string, message: string) => `extension-extender: ${name ? `${name}: ` : ''}${message}`

export function statusBoard(names: string[]) {
  if (!process.stderr.isTTY) {
    return (name: string, message: string) => process.stderr.write(`${rowLine(name, message)}\n`)
  }
  const messages = new Map(names.map((name): [string, string] => [name, '']))
  process.stderr.write('\n'.repeat(names.length))
  return (name: string, message: string) => {
    messages.set(name, message)
    names.forEach((row, index) => {
      const up = names.length - index
      moveCursor(process.stderr, 0, -up)
      cursorTo(process.stderr, 0)
      clearLine(process.stderr, 0)
      process.stderr.write(rowLine(row, messages.get(row)!))
      moveCursor(process.stderr, 0, up)
    })
    cursorTo(process.stderr, 0)
  }
}
