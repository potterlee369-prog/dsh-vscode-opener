// Temporary smoke test for the built host plugin (dev-only, not shipped).
// Runs the registered command handler end to end and really launches VS Code.
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

const result = await captured.handler({
  commandId: 'smoke-1',
  agent: { session: { header: { cwd: 'E:\\ai_ques_item_analysis' } } },
  rawInput: '',
  signal: new AbortController().signal,
})
console.log('handler result:', JSON.stringify(result, null, 2))
