// Temporary client-bundle shape test (dev-only): loads lib/client.js the way
// the web shell does (classic script + __ModuleLoader__ handoff) and checks
// the factory returns the plugin exports.
import { readFileSync } from 'node:fs'

let handoff = null
globalThis.window = {
  __ModuleLoader__: { load(h) { handoff = h } },
}
// eslint-disable-next-line no-eval
;(0, eval)(readFileSync(new URL('./lib/client.js', import.meta.url), 'utf8'))

if (handoff === null) throw new Error('bundle never called __ModuleLoader__.load')

const reactMock = {
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
}
const jsxMock = { jsx: (...args) => args, jsxs: (...args) => args }
// The system icon set is external (shell-provided); any glyph resolves to a
// stub component in this harness.
const primitivesMock = new Proxy({}, { get: () => () => null })

const exportsObj = handoff.factory((spec) => {
  if (spec === 'react') return reactMock
  if (spec === 'react/jsx-runtime') return jsxMock
  if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitivesMock
  throw new Error(`unexpected require: ${spec}`)
})

console.log('factory id:', handoff.id)
console.log('exports:', Object.keys(exportsObj))
console.log('inject:', exportsObj.inject)
console.log('apply is function:', typeof exportsObj.apply === 'function')

const registrations = []
exportsObj.apply({
  slots: {
    inject(name, register) {
      if (name !== 'conversation.input.left') throw new Error(`unexpected slot: ${name}`)
      register()
    },
    register(options, component) {
      registrations.push({ options, component })
    },
  },
  locale: {
    register() {
      return () => {}
    },
  },
  effect(callback) {
    callback()
  },
})

const ids = registrations.map(({ options }) => options.id)
if (ids.join(',') !== 'dsh-vscode-opener,dsh-vscode-opener-explorer') {
  throw new Error(`unexpected composer registrations: ${ids.join(',')}`)
}
if (registrations[0].options.order >= registrations[1].options.order) {
  throw new Error('Explorer button is not ordered beside the VS Code button')
}
console.log('apply smoke: OK (VS Code and Explorer buttons registered in order)')
