// Temporary smoke test for the built host plugin (dev-only, not shipped).
// By default it only checks command registration. Set RUN_VSCODE_SMOKE=1 to
// run the end-to-end variant that really launches VS Code.
import { apply, Config } from './lib/index.js'

const config = Config({})
console.log('resolved config:', JSON.stringify(config))

let captured = null
const ctx = {
  commands: {
    register(definition) {
      captured = definition
      return () => {}
    },
  },
}
apply(ctx, config)

console.log('registered command:', captured.name, '-', captured.description)

if (process.env.RUN_VSCODE_SMOKE !== '1') {
  console.log('registration smoke: OK (set RUN_VSCODE_SMOKE=1 to launch VS Code)')
} else {
  const result = await captured.handler({
    commandId: 'smoke-1',
    agent: { session: { header: { cwd: process.env.SMOKE_CWD ?? process.cwd() } } },
    rawInput: '',
    signal: new AbortController().signal,
  })
  console.log('handler result:', JSON.stringify(result, null, 2))
}
