// Host plugin: registers the `/vscode` slash command through the harness
// command registry and launches VS Code detached on the calling session's
// workspace directory; also serves web routes for the browser half:
// the VS Code system icon (extracted from the installed executable) and a
// pair of SILENT launch routes — the composer buttons POST to the latter so
// opening a directory never writes a slash-command row into the conversation.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'

export const name = 'vscode-opener'

export const Config = z.object({
  /** How to launch VS Code: a bare command name (probed on PATH, with
   *  well-known install locations tried on Windows) or an absolute path
   *  to the executable, e.g. `C:\Program Files\Microsoft VS Code\Code.exe`. */
  codeCommand: z.string().default('code'),
  /** Pass `-r` so the workspace opens in the most recently used window
   *  instead of a new one. */
  reuseWindow: z.boolean().default(false),
})

export const inject = ['commands', 'webServer', 'sessions']

export interface VscodeOpenerConfig {
  codeCommand: string
  reuseWindow: boolean
}

/** Minimal structural face of the `ctx.commands` service (see dsh-commands). */
interface CommandInvocation {
  commandId: string
  agent: { session: { header: { cwd?: string } } }
  rawInput: string
  signal: AbortSignal
}

interface CommandResult {
  kind: 'success' | 'error'
  text: string
}

interface CommandDefinition {
  name: string
  description: string
  handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

interface CommandsService {
  register(definition: CommandDefinition): () => void
}

/** Minimal structural face of the `ctx.sessions` service (see dsh-session). */
interface SessionsService {
  get(id: string): { header: { cwd?: string } } | undefined
}

export function apply(
  ctx: {
    commands: CommandsService
    webServer?: WebServerService
    sessions?: SessionsService
    effect?(callback: () => unknown, label?: string): unknown
  },
  config: VscodeOpenerConfig,
) {
  const disposeAll: Array<() => void> = []
  const disposeCommand = ctx.commands.register({
    name: 'vscode',
    description: 'Open VS Code with the current session workspace (optional path argument)',
    handler: async (invocation) => {
      if (invocation.signal.aborted) return { kind: 'error', text: '已取消' }
      const base = invocation.agent.session.header.cwd ?? process.cwd()
      const target = resolveTarget(base, invocation.rawInput.trim())
      if (typeof target !== 'string') return { kind: 'error', text: target.message }
      const executable = resolveExecutable(config.codeCommand)
      if (executable === null) {
        return {
          kind: 'error',
          text: `找不到 VS Code 启动命令 "${config.codeCommand}"。请在 profile 的 cordis.patch.yml 中把 vscode-opener 的 codeCommand 配置为完整路径，例如 "C:\\Program Files\\Microsoft VS Code\\Code.exe"`,
        }
      }
      try {
        await launch(executable, target, config.reuseWindow)
      } catch (error) {
        return {
          kind: 'error',
          text: `启动 VS Code 失败: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      return { kind: 'success', text: `已在 VS Code 中打开 ${target}` }
    },
  })
  disposeAll.push(disposeCommand)
  if (ctx.webServer !== undefined) {
    // Every registrable service must be disposed on fiber teardown, otherwise
    // a hot reload re-runs apply and collides with the leaked route/command.
    disposeAll.push(registerIconRoute(ctx.webServer, config.codeCommand))
    disposeAll.push(registerLaunchRoute(ctx.webServer, ctx.sessions, config))
    disposeAll.push(registerExplorerRoute(ctx.webServer, ctx.sessions))
  }
  ctx.effect?.(() => () => {
    for (const dispose of disposeAll) {
      try {
        dispose()
      } catch {
        // Unregister best-effort; a leaked disposal must not break teardown.
      }
    }
  }, 'vscode-opener: routes + command')
}

/** Resolve the directory to open: the raw argument when given, else the session cwd. */
function resolveTarget(base: string, raw: string): string | Error {
  const target = raw === '' ? base : resolve(base, raw)
  try {
    if (!existsSync(target)) return new Error(`目录不存在: ${target}`)
    if (!statSync(target).isDirectory()) return new Error(`不是目录: ${target}`)
    return target
  } catch (error) {
    return new Error(`无法访问目录 ${target}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Quick spawn probe: a bare command that Node can launch directly works. */
function probeSpawn(command: string): boolean {
  try {
    const result = spawnSync(command, ['--version'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 5000,
    })
    return result.error === undefined
  } catch {
    return false
  }
}

/**
 * Resolve the configured launch command to a spawnable executable.
 * Bare names that probe successfully (macOS/Linux `code`, a full exe name on
 * PATH) are used as-is; on Windows — where the PATH shim `code.cmd` cannot be
 * spawned without a shell — the well-known Code.exe locations are tried.
 */
function resolveExecutable(configured: string): string | null {
  if (configured.includes('/') || configured.includes('\\')) return configured
  if (probeSpawn(configured)) return configured
  if (process.platform === 'win32') {
    const candidates = [
      process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      process.env.ProgramFiles && join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
      process.env['ProgramFiles(x86)'] && join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe'),
    ]
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) return candidate
    }
  }
  return null
}

/**
 * Launch VS Code detached: no stdio inheritance, no console window, and the
 * child is unref'ed so it outlives the harness process. Resolves once the
 * process is confirmed spawned; rejects on spawn failure (e.g. ENOENT).
 */
function launch(file: string, dir: string, reuseWindow: boolean): Promise<void> {
  return launchDetached(file, [...(reuseWindow ? ['-r'] : []), dir])
}

function launchDetached(file: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // NOTE: never pass `windowsHide: true` here. On Windows libuv turns that
    // into STARTF_USESHOWWINDOW + SW_HIDE in the child's startup info, which
    // VS Code honors for its first main window — the process starts fine but
    // the window is created invisible, so the composer button looks like a
    // no-op. Code.exe is a GUI-subsystem binary and opens no console anyway.
    const child = spawn(file, args, {
      detached: true,
      stdio: 'ignore',
    })
    let settled = false
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true
        fn()
      }
    }
    child.once('error', (error) => settle(() => reject(error)))
    child.once('spawn', () =>
      settle(() => {
        child.unref()
        resolvePromise()
      }),
    )
  })
}

/** Open a directory in the host operating system's file manager. */
function launchExplorer(dir: string): Promise<void> {
  const file =
    process.platform === 'win32'
      ? process.env.WINDIR
        ? join(process.env.WINDIR, 'explorer.exe')
        : 'explorer.exe'
      : process.platform === 'darwin'
        ? 'open'
        : process.platform === 'linux'
          ? 'xdg-open'
          : null
  if (file === null) return Promise.reject(new Error(`当前平台不支持打开资源管理器: ${process.platform}`))
  return launchDetached(file, [dir])
}

// ── system icon extraction (the button shows VS Code's real icon) ───────────

/** Minimal structural face of the `ctx.webServer` service (see dsh-host-webserver). */
interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: RouteRequest, res: RouteResponse) => void | Promise<void>
}

interface RouteRequest {
  method?: string
  url?: string
}

interface RouteResponse {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: Buffer | string): void
}

interface WebServerService {
  register(route: WebRoute): () => void
}

/** HTTP path the browser half loads the VS Code icon from. */
export const ICON_ROUTE = '/plugin/dsh-vscode-opener/icon'

const ICON_SIZE = 64

/**
 * PowerShell body that extracts the shell's associated icon for $Path (the
 * resolved Code.exe, or a shortcut) and prints it as a base64-encoded
 * ICON_SIZE×ICON_SIZE PNG on stdout. `$Path` is embedded by the caller with
 * single quotes doubled, so no argument quoting issues.
 */
const ICON_SCRIPT_BODY = `
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Path)
if ($null -eq $icon) { exit 2 }
$bitmap = $icon.ToBitmap()
$canvas = New-Object System.Drawing.Bitmap ${ICON_SIZE}, ${ICON_SIZE}
$g = [System.Drawing.Graphics]::FromImage($canvas)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($bitmap, 0, 0, ${ICON_SIZE}, ${ICON_SIZE})
$g.Dispose()
$bitmap.Dispose()
$icon.Dispose()
$ms = New-Object System.IO.MemoryStream
$canvas.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()
$out = [Convert]::ToBase64String($ms.ToArray())
$ms.Dispose()
[Console]::Out.Write($out)
`

/**
 * Extract the associated system icon for one filesystem path as a PNG
 * buffer. Returns null when the platform/backend cannot produce an icon, so
 * the browser half falls back to a generic system glyph.
 */
export function extractIcon(target: string): Promise<Buffer | null> {
  return new Promise((resolvePromise) => {
    if (process.platform !== 'win32') {
      resolvePromise(null)
      return
    }
    const script = `$Path = '${target.replace(/'/g, "''")}'\n${ICON_SCRIPT_BODY}`
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    )
    let stdout = ''
    let settled = false
    const settle = (result: Buffer | null) => {
      if (!settled) {
        settled = true
        resolvePromise(result)
      }
    }
    const timer = setTimeout(() => {
      child.kill()
      settle(null)
    }, 8000)
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.once('error', () => settle(null))
    child.once('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        settle(null)
        return
      }
      const b64 = stdout.trim()
      if (b64 === '') {
        settle(null)
        return
      }
      try {
        const buffer = Buffer.from(b64, 'base64')
        settle(buffer.length > 0 && buffer[0] === 0x89 ? buffer : null)
      } catch {
        settle(null)
      }
    })
  })
}

/**
 * Register the icon route on the web server. The resolved executable's icon
 * is extracted once (memoized per route registration); a failed extraction
 * answers 404 so the browser half renders its generic fallback.
 */
export function registerIconRoute(webServer: WebServerService, codeCommand: string): () => void {
  let pending: Promise<Buffer | null> | null = null
  const run = (): Promise<Buffer | null> => {
    if (pending === null) {
      // Resolve lazily on first request so plugin boot never pays the spawn
      // probe for the launch command.
      const executable = resolveExecutable(codeCommand)
      pending = executable !== null && existsSync(executable) ? extractIcon(executable) : Promise.resolve(null)
    }
    return pending
  }

  return webServer.register({
    kind: 'exact',
    path: ICON_ROUTE,
    handler: async (req, res) => {
      if (req.method !== undefined && req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.end()
        return
      }
      const buffer = await run()
      if (buffer === null || buffer.length === 0) {
        res.statusCode = 404
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end('icon unavailable')
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Cache-Control', 'public, max-age=3600')
      if (req.method === 'HEAD') {
        res.end()
      } else {
        res.end(buffer)
      }
    },
  })
}

// ── silent launch route (button → host, no conversation rows) ──────────────

/** HTTP path the browser half POSTs to for a silent VS Code launch. */
export const LAUNCH_ROUTE = '/plugin/dsh-vscode-opener/launch'

/** HTTP path the browser half POSTs to for a silent file-manager launch. */
export const EXPLORER_ROUTE = '/plugin/dsh-vscode-opener/open-explorer'

interface LaunchResult {
  ok: boolean
  target?: string
  error?: string
}

function sendJson(res: RouteResponse, status: number, body: LaunchResult): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * Register the silent launch route on the web server. Unlike the `/vscode`
 * command channel, this handler bypasses the command runtime entirely, so the
 * session log gains no `command/run` / `command/done` rows. It resolves the
 * session's workspace directory through `ctx.sessions` and launches VS Code
 * with the same config-driven executable/window rules as the command.
 */
export function registerLaunchRoute(
  webServer: WebServerService,
  sessions: SessionsService | undefined,
  config: VscodeOpenerConfig,
): () => void {
  return webServer.register({
    kind: 'exact',
    path: LAUNCH_ROUTE,
    handler: async (req, res) => {
      const method = req.method ?? ''
      if (method !== 'POST') {
        res.statusCode = 405
        res.setHeader('Allow', 'POST')
        res.end()
        return
      }
      let sessionId: string | null = null
      try {
        sessionId = new URL(req.url ?? '', 'http://localhost').searchParams.get('sessionId')
      } catch {
        sessionId = null
      }
      if (sessionId === null || sessionId === '') {
        sendJson(res, 400, { ok: false, error: 'missing sessionId' })
        return
      }
      if (sessions === undefined) {
        sendJson(res, 503, { ok: false, error: 'sessions service unavailable' })
        return
      }
      const session = sessions.get(sessionId)
      if (session === undefined) {
        sendJson(res, 404, { ok: false, error: `session not found: ${sessionId}` })
        return
      }
      const base = session.header.cwd ?? process.cwd()
      const target = resolveTarget(base, '')
      if (typeof target !== 'string') {
        sendJson(res, 400, { ok: false, error: target.message })
        return
      }
      const executable = resolveExecutable(config.codeCommand)
      if (executable === null) {
        sendJson(res, 500, {
          ok: false,
          error: `找不到 VS Code 启动命令 "${config.codeCommand}"。请在 profile 的 cordis.patch.yml 中把 vscode-opener 的 codeCommand 配置为完整路径，例如 "C:\\Program Files\\Microsoft VS Code\\Code.exe"`,
        })
        return
      }
      try {
        await launch(executable, target, config.reuseWindow)
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: `启动 VS Code 失败: ${error instanceof Error ? error.message : String(error)}`,
        })
        return
      }
      sendJson(res, 200, { ok: true, target })
    },
  })
}

/**
 * Register the silent file-manager route. It resolves the same session cwd as
 * the VS Code button, then opens that directory in Explorer (or the platform's
 * native file manager on macOS/Linux).
 */
export function registerExplorerRoute(webServer: WebServerService, sessions: SessionsService | undefined): () => void {
  return webServer.register({
    kind: 'exact',
    path: EXPLORER_ROUTE,
    handler: async (req, res) => {
      const method = req.method ?? ''
      if (method !== 'POST') {
        res.statusCode = 405
        res.setHeader('Allow', 'POST')
        res.end()
        return
      }
      let sessionId: string | null = null
      try {
        sessionId = new URL(req.url ?? '', 'http://localhost').searchParams.get('sessionId')
      } catch {
        sessionId = null
      }
      if (sessionId === null || sessionId === '') {
        sendJson(res, 400, { ok: false, error: 'missing sessionId' })
        return
      }
      if (sessions === undefined) {
        sendJson(res, 503, { ok: false, error: 'sessions service unavailable' })
        return
      }
      const session = sessions.get(sessionId)
      if (session === undefined) {
        sendJson(res, 404, { ok: false, error: `session not found: ${sessionId}` })
        return
      }
      const base = session.header.cwd ?? process.cwd()
      const target = resolveTarget(base, '')
      if (typeof target !== 'string') {
        sendJson(res, 400, { ok: false, error: target.message })
        return
      }
      try {
        await launchExplorer(target)
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          error: `打开资源管理器失败: ${error instanceof Error ? error.message : String(error)}`,
        })
        return
      }
      sendJson(res, 200, { ok: true, target })
    },
  })
}
