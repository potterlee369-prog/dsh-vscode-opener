// Client plugin: compact "open in VS Code" and "open in Explorer" buttons in
// the composer's left extension slot. Clicking either button POSTs to the
// plugin's own silent launch route on the web server, so opening a directory
// never writes a slash-command row into the conversation.
// The button shows VS Code's real system icon (extracted host-side from the
// installed executable) and falls back to the harness's own code glyph.
import { useEffect, useState } from 'react'
import { IconCodeOutline16, IconFolderOpenOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './index.css'

const NS = 'vscode-opener'
const CSS_TAG = 'dsh-vscode-opener/index.css'
const ICON_SRC = '/plugin/dsh-vscode-opener/icon'
const VSCODE_LAUNCH_ROUTE = '/plugin/dsh-vscode-opener/launch'
const EXPLORER_LAUNCH_ROUTE = '/plugin/dsh-vscode-opener/open-explorer'

// Inject the stylesheet once, at module materialization — the same
// data-plugin-css pattern the harness's own client bundles use.
if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_TAG}"]`) === null) {
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-vscode-opener'
  tag.dataset.pluginCss = CSS_TAG
  tag.textContent = css
  document.head.appendChild(tag)
}

const zh = {
  'button.title': '在 VS Code 中打开当前会话目录',
  'button.opening': '正在打开 VS Code…',
  'button.ok': '已在 VS Code 中打开',
  'button.error': '打开 VS Code 失败',
  'explorer.title': '在资源管理器中打开当前会话目录',
  'explorer.opening': '正在打开资源管理器…',
  'explorer.ok': '已在资源管理器中打开',
  'explorer.error': '打开资源管理器失败',
}

const en = {
  'button.title': 'Open the current session directory in VS Code',
  'button.opening': 'Opening VS Code…',
  'button.ok': 'Opened in VS Code',
  'button.error': 'Failed to open VS Code',
  'explorer.title': 'Open the current session directory in File Explorer',
  'explorer.opening': 'Opening File Explorer…',
  'explorer.ok': 'Opened in File Explorer',
  'explorer.error': 'Failed to open File Explorer',
}

export const inject = ['slots', 'locale']

/** Body returned by either silent launch route on the host half. */
interface LaunchResponse {
  ok: boolean
  target?: string
  error?: string
}

interface Locale {
  register(namespace: string, dictionaries: Record<'zh' | 'en', Record<string, string>>): () => void
}

interface Slots {
  inject(name: string, register: () => void): void
  register(options: object, component: unknown): void
}

interface ClientContext {
  slots: Slots
  locale: Locale
  effect(callback: () => () => void, label: string): void
}

async function postLaunch(route: string, sessionId: string): Promise<string> {
  const response = await fetch(`${route}?sessionId=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
  })
  let payload: LaunchResponse
  try {
    payload = (await response.json()) as LaunchResponse
  } catch {
    throw new Error(`launch request failed (HTTP ${response.status})`)
  }
  if (!response.ok || payload.ok !== true) {
    throw new Error(payload.error ?? `launch request failed (HTTP ${response.status})`)
  }
  return payload.target ?? ''
}

export function apply(ctx: ClientContext) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-vscode-opener: dictionaries')

  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'dsh-vscode-opener',
        order: 0,
        locale: NS,
        inject: (sessionId: string) => ({
          openVscode: () => postLaunch(VSCODE_LAUNCH_ROUTE, sessionId),
        }),
      },
      VscodeButton,
    ),
  )

  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.left',
        id: 'dsh-vscode-opener-explorer',
        order: 1,
        locale: NS,
        inject: (sessionId: string) => ({
          openExplorer: () => postLaunch(EXPLORER_LAUNCH_ROUTE, sessionId),
        }),
      },
      ExplorerButton,
    ),
  )
}

type ButtonState = 'idle' | 'busy' | 'ok' | 'error'

interface VscodeButtonProps {
  openVscode: () => Promise<string>
  t: (key: string) => string
}

interface ExplorerButtonProps {
  openExplorer: () => Promise<string>
  t: (key: string) => string
}

type OpenButtonKind = 'vscode' | 'explorer'

interface OpenButtonProps {
  kind: OpenButtonKind
  open: () => Promise<string>
  t: (key: string) => string
}

function VscodeButton({ openVscode, t }: VscodeButtonProps) {
  return <OpenButton kind="vscode" open={openVscode} t={t} />
}

function ExplorerButton({ openExplorer, t }: ExplorerButtonProps) {
  return <OpenButton kind="explorer" open={openExplorer} t={t} />
}

function OpenButton({ kind, open, t }: OpenButtonProps) {
  const [state, setState] = useState<ButtonState>('idle')
  const [detail, setDetail] = useState('')
  const [iconOk, setIconOk] = useState(false)

  useEffect(() => {
    if (state !== 'ok' && state !== 'error') return
    const timer = setTimeout(() => setState('idle'), 3000)
    return () => clearTimeout(timer)
  }, [state])

  // Probe the host's extracted VS Code system icon; render the harness's
  // generic code glyph until/unless it loads.
  useEffect(() => {
    if (kind !== 'vscode') return
    let alive = true
    const probe = new Image()
    probe.onload = () => {
      if (alive) setIconOk(true)
    }
    probe.onerror = () => {
      if (alive) setIconOk(false)
    }
    probe.src = ICON_SRC
    return () => {
      alive = false
    }
  }, [kind])

  const onClick = async () => {
    if (state === 'busy') return
    setState('busy')
    setDetail('')
    try {
      await open()
      setState('ok')
    } catch (error) {
      setState('error')
      setDetail(error instanceof Error ? error.message : String(error))
    }
  }

  const keyPrefix = kind === 'vscode' ? 'button' : 'explorer'
  const title =
    state === 'idle'
      ? t(`${keyPrefix}.title`)
      : state === 'busy'
        ? t(`${keyPrefix}.opening`)
        : state === 'ok'
          ? t(`${keyPrefix}.ok`)
          : `${t(`${keyPrefix}.error`)}${detail ? `: ${detail}` : ''}`

  return (
    <button
      type="button"
      className={`dsh-open-button ${kind}-button ${state}`}
      title={title}
      aria-label={t(`${keyPrefix}.title`)}
      disabled={state === 'busy'}
      onClick={() => void onClick()}
    >
      {kind === 'vscode' ? (
        iconOk ? <img src={ICON_SRC} alt="" draggable={false} aria-hidden="true" /> : <IconCodeOutline16 size={15} />
      ) : (
        <IconFolderOpenOutline16 size={15} />
      )}
    </button>
  )
}
