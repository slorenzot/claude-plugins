import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Snapshot } from '../types'

const snapshot = atom({ plugin: 'usage-band', key: 'snapshot' } as const, null)

const lastResponseAt = atom(
  { plugin: 'usage-band', key: 'lastResponseAt' } as const,
  null
)

// Instante (ms) en que empezó el handoff, o null si no hay uno en curso
const handoffBusy = atom({ plugin: 'usage-band', key: 'handoffBusy' } as const, null)

// Cambia cada segundo mientras corre el handoff para redibujar el contador
const handoffTick = atom({ plugin: 'usage-band', key: 'handoffTick' } as const, 0)

// Subagentes en ejecución (los lee el dibujo; se actualiza cada segundo)
const agentsRunning = atom({ plugin: 'usage-band', key: 'agentsRunning' } as const, 0)

// Pasos ofrecidos y la conversación (id de sesión) a la que pertenecen
const suggestions = atom(
  { plugin: 'usage-band', key: 'suggestions' } as const,
  { sid: null, list: [] }
)

// Pide al modelo, sobre la conversación, hasta 3 siguientes pasos breves
const SUGGEST_PROMPT =
  'Con base en esta conversación, propone hasta 3 mensajes que el USUARIO ' +
  'podría escribirte a continuación para seguir la conversación: preguntas, ' +
  'peticiones o respuestas en primera persona, tal como las escribiría él. ' +
  'No propongas tareas que tú esperes hacer ni pasos sugeridos por ti. ' +
  'Basa los mensajes SOLO en lo conversado en este chat, sobre todo en los ' +
  'últimos mensajes: ignora el handoff, la memoria y cualquier contexto de ' +
  'otras tareas o chats inyectado al iniciar la sesión, salvo que el usuario ' +
  'esté hablando de eso ahora. ' +
  'Cada mensaje debe poder enviarse tal cual y entenderse solo, sobre el ' +
  'objetivo real del usuario (su proyecto o tarea), en una acción nueva ' +
  'que el usuario querría pedir. Prohibido: confirmar cosas internas de la ' +
  'herramienta o del entorno (hot reload, mods, paneles, plugins, ' +
  'configuración de Claude), contar lo que el usuario ya hizo, o responder ' +
  'preguntas de configuración que tú hiciste. Si no hay un siguiente paso ' +
  'útil, devuelve []. ' +
  'Cada uno en el idioma del usuario, máximo 8 palabras. Responde SOLO con ' +
  'un arreglo JSON de strings, sin texto adicional.'

const HANDOFF_PROMPT =
  'Escribe un resumen de traspaso para continuar este trabajo en una ' +
  'conversación nueva sin perder contexto: objetivo, estado actual, decisiones ' +
  'tomadas, archivos relevantes y pasos pendientes. Responde solo con el resumen.'

// Espacio interior de los botones: Button no tiene padding propio, se simula
// con espacios de no separación a cada lado de la etiqueta
function padded(label: string): string {
  return `\u00A0\u00A0${label}\u00A0\u00A0`
}

// Texto del uso de contexto: "ctx ~9% (95k)"
function contextText(snap: Snapshot): string | null {
  const c = snap.context
  if (!c || c.percent === undefined) return null
  const k = c.tokens !== undefined ? ` (${Math.round(c.tokens / 1000)}k)` : ''
  return `ctx ~${c.percent}%${k}`
}

// Instrucción permanente: el modelo cierra cada respuesta con el bloque <pasos>
const STEPS_INSTRUCTION =
  'Al final de cada respuesta, después de todo el contenido, añade en una ' +
  'línea aparte un bloque con hasta 3 mensajes que el USUARIO podría ' +
  'escribirte a continuación para seguir la conversación: preguntas, ' +
  'peticiones o respuestas en primera persona, tal como las escribiría él ' +
  '(no las cosas que tú esperas hacer ni pasos que tú sugieres). ' +
  'Basa los mensajes SOLO en lo conversado en este chat, sobre todo en los ' +
  'últimos mensajes: ignora el handoff, la memoria y cualquier contexto de ' +
  'otras tareas o chats inyectado al iniciar la sesión, salvo que el usuario ' +
  'esté hablando de eso ahora. Cada mensaje debe entenderse solo y servir al ' +
  'objetivo real del usuario (su proyecto o tarea); nunca confirmes cosas ' +
  'internas de la herramienta o del entorno (hot reload, mods, paneles, ' +
  'plugins, configuración de Claude), ni cuentes lo que el usuario ya hizo. ' +
  'Si no hay un siguiente paso útil, usa []. Cada uno máximo 8 palabras y ' +
  'en el idioma del usuario, con este formato exacto: ' +
  '<pasos>["mensaje 1","mensaje 2","mensaje 3"]</pasos>. Es un bloque ' +
  'técnico que la interfaz oculta: no lo menciones ni lo expliques.'

const STEPS_BLOCK = /<pasos>([\s\S]*?)<\/pasos>/
// Incluye el bloque aún abierto mientras la respuesta se transmite
const STEPS_HIDDEN = /\s*<pasos>[\s\S]*?(<\/pasos>|$)/g

// Extrae el arreglo JSON de la respuesta del modelo
function parseSuggestions(text: string): string[] {
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) return []
  try {
    const list = JSON.parse(match[0])
    return Array.isArray(list)
      ? list.filter(x => typeof x === 'string' && x.trim()).slice(0, 3)
      : []
  } catch {
    return []
  }
}

// Vida mostrada del caché, en minutos (la API no la expone al mod)
const CACHE_TTL_MIN = 60
const CACHE_TTL_MS = CACHE_TTL_MIN * 60 * 1000

const LABELS: Record<string, string> = {
  five_hour: '5h',
  seven_day: '7 días',
}

// Formatea los milisegundos restantes como "2d 6h 48m", "5d", "8h" o "35m"
function remaining(ms: number): string {
  if (ms <= 0) return 'ahora'
  const minutes = Math.ceil(ms / 60000)
  const d = Math.floor(minutes / 1440)
  const h = Math.floor((minutes % 1440) / 60)
  const m = minutes % 60
  // Omite las unidades en cero: "5d", "8h", "1h 5m"
  const parts = [d > 0 ? `${d}d` : '', h > 0 ? `${h}h` : '', m > 0 ? `${m}m` : '']
  return parts.filter(Boolean).join(' ') || '0m'
}

// Color según el uso: naranja por encima de 74 %, rojo por encima de 90 %
function colorFor(percent: number): string | undefined {
  if (percent > 90) return '#ef4444'
  if (percent > 74) return '#f97316'
  return undefined
}

// Caché tibio (vida de 60 min): verde hasta el minuto 41, naranja 42-53, rojo desde 54
function cacheView(
  now: number,
  last: number | null
): { text: string; color?: string } | null {
  if (last === null) return null
  const elapsed = now - last
  if (elapsed >= CACHE_TTL_MS) return { text: 'Cache frío' }
  const minutes = Math.floor(elapsed / 60000)
  const color = minutes >= 54 ? '#ef4444' : minutes >= 42 ? '#f97316' : '#22c55e'
  return {
    text: `Cache · ${remaining(CACHE_TTL_MS - elapsed)}`,
    color,
  }
}

function describe(l: Snapshot['limits'][number], now: number): string {
  const label = LABELS[l.kind] ?? l.kind
  const reset = l.resetsAt
    ? ` · reinicia en ${remaining(Date.parse(l.resetsAt) - now)}`
    : ''
  return `${Math.round(l.percentUsed)}% de ${label}${reset}`
}

function summary(snap: Snapshot): string {
  if (snap.limits.length === 0) return 'Uso: sin datos de límites'
  return `Uso: ${snap.limits.map(l => describe(l, snap.now)).join(' | ')}`
}

// Cambia los pasos ofrecidos y los guarda por conversación, para recuperarlos al reabrirla
async function setSteps($, list: string[]) {
  const sid = await $.session.id()
  await update($, suggestions, () => ({ sid, list }))
  try {
    const key = `steps:${sid}`
    if (list.length > 0) await $.store.set(key, list)
    else await $.store.delete(key)
  } catch {}
}

// Cuenta los subagentes que siguen trabajando
async function countRunning($): Promise<number> {
  try {
    const agents = await $.agent.list()
    return agents.filter(a => a.type !== 'teammate' && a.status === 'running').length
  } catch {
    return 0
  }
}

// Declarada en el nivel superior para que el motor acepte recibir `$`
async function refresh($) {
  const usage = await $.session.usage()
  const now = await $.clock.now()
  const next: Snapshot = {
    limits: usage.rateLimits ?? [],
    now,
    context: { percent: usage.context?.percent, tokens: usage.context?.tokens },
  }
  await update($, snapshot, () => next)
}

export const register: Register = on => {
  // Entrega al modelo la instrucción de cerrar con los siguientes pasos
  on('prompt.context', ($, e, next) =>
    next({
      ...e,
      blocks: [...e.blocks, { name: 'nextSteps', text: STEPS_INSTRUCTION }],
    })
  )

  on('turn.complete', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, lastResponseAt, () => now)
    await refresh($)
    const isMain = !e.agentId && e.reason === 'answer'
    // Con subagentes en curso no se proponen pasos: se esperan sus resultados
    if (isMain && (await countRunning($)) > 0) {
      await setSteps($, [])
      return next(e)
    }
    const found = isMain ? STEPS_BLOCK.exec(e.answer ?? '') : null
    const fromAnswer = found ? parseSuggestions(found[1]) : []
    if (isMain && fromAnswer.length > 0) {
      await setSteps($, fromAnswer)
      return next(e)
    }
    const result = await next(e)
    // Respaldo: el modelo no incluyó el bloque, se pide con un fork
    if (isMain) {
      await setSteps($, [])
      const r = await $.model.fork({ prompt: SUGGEST_PROMPT })
      if (r.isAnswered) {
        const list = parseSuggestions(r.text)
        await setSteps($, list)
      }
    }
    return result
  })

  // Oculta el bloque <pasos> al dibujar la respuesta (el mensaje guardado no cambia)
  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    const text = e.props.text.replace(STEPS_HIDDEN, '')
    return text === e.props.text
      ? next(e)
      : next({ ...e, props: { ...e.props, text } })
  })

  on('session.start', async ($, e, next) => {
    await refresh($)
    // Refresca cada minuto para avanzar las cuentas regresivas
    $.clock.every(60000, () => refresh($))
    // Avanza el contador del handoff cada segundo (solo mientras está activo)
    $.clock.every(1000, async () => {
      const n = await countRunning($)
      if (n !== (await read($, agentsRunning))) {
        await update($, agentsRunning, () => n)
      }
      if ((await read($, handoffBusy)) !== null) {
        await update($, handoffTick, n => n + 1)
      }
    })
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refresh($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    let snap = await read($, snapshot)
    if (snap === null) {
      await refresh($)
      snap = await read($, snapshot)
    }
    const last = await read($, lastResponseAt)
    const cache = snap ? cacheView(snap.now, last) : null
    const { Box, Text, Button } = $.ui.resolve(e)
    // Solo los pasos de este chat: los del atom si son de esta sesión; si no
    // (reinicio, /clear), los guardados bajo el id de esta sesión
    const sid = await $.session.id()
    const held = await read($, suggestions)
    let steps: string[] = []
    if (held.sid === sid) steps = held.list
    else {
      try {
        const saved = await $.store.get(`steps:${sid}`)
        if (Array.isArray(saved)) {
          steps = saved.filter(x => typeof x === 'string' && x.trim()).slice(0, 3)
        }
      } catch {}
    }
    const waiting = await read($, agentsRunning)
    const waitingText = `${waiting} ${waiting === 1 ? 'subagente sigue trabajando' : 'subagentes siguen trabajando'}, cuando finalice${waiting === 1 ? '' : 'n'} sugiero tus siguientes pasos...`
    const busyFrom = await read($, handoffBusy)
    const busy = busyFrom !== null
    const secs = busy ? Math.max(0, Math.floor(((await $.clock.now()) - busyFrom) / 1000)) : 0
    // Handoff se ofrece cuando el contexto supera el 75 %
    const showHandoff = (snap?.context?.percent ?? 0) > 75
    const hasLimits = snap !== null && snap.limits.length > 0
    return (
      <Box flexDirection="column">
        <Text wrap="truncate">
          {cache ? (
            <Text color={cache.color}>{cache.text}</Text>
          ) : null}
          {cache ? <Text dimColor>{'  |  '}</Text> : null}
          {snap && contextText(snap) ? (
            <Text color={colorFor(snap.context?.percent ?? 0)}>
              {contextText(snap)}
            </Text>
          ) : null}
          {snap && contextText(snap) ? <Text dimColor>{'  |  '}</Text> : null}
          {hasLimits ? (
            <Text dimColor>
              {'Uso: '}
              {snap.limits.map((l, i) => (
                <Text key={l.kind} color={colorFor(l.percentUsed)}>
                  {i > 0 ? ' | ' : ''}
                  {describe(l, snap.now)}
                </Text>
              ))}
            </Text>
          ) : (
            <Text dimColor>{snap ? summary(snap) : 'Uso: cargando…'}</Text>
          )}
        </Text>
        {busy ? (
          <Box paddingTop={1}>
            <Text color="yellow">Generando traspaso… {secs}s · no escribas hasta que termine</Text>
          </Box>
        ) : !e.props.isWorking && waiting > 0 ? (
          <Box paddingTop={1}>
            <Text dimColor>{waitingText}</Text>
          </Box>
        ) : !e.props.isWorking && (steps.length > 0 || showHandoff) ? (
          <Box flexDirection="column">
            <Box paddingTop={1} paddingBottom={1}>
              <Text dimColor>Siguientes pasos:</Text>
            </Box>
            {steps.map((step, i) => (
              <Box key={`step-${i}`} paddingBottom={1}>
                <Button
                  plain
                  key={`step-btn-${i}`}
                  hotkey={String(i + 1)}
                  label={padded(step)}
                  onPress={async () => {
                    await setSteps($, [])
                    await $.prompt.submit({ text: step, asUser: true })
                  }}
                />
              </Box>
            ))}
            {showHandoff ? (
              <Box key="handoff-box" paddingBottom={1}>
                <Button
                  plain
                  key="handoff"
                  hotkey={String(steps.length + 1)}
                  label={padded('Handoff and clear')}
                  onPress={async () => {
                    // Feedback inmediato: el fork tarda varios segundos
                    const startedAt = await $.clock.now()
                    await update($, handoffBusy, () => startedAt)
                    try {
                      const r = await $.model.fork({ prompt: HANDOFF_PROMPT })
                      if (!r.isAnswered) {
                        $.ui.toast(`Handoff: sin resumen (${r.reason})`)
                        return
                      }
                      await setSteps($, [])
                      await $.command.run({ command: 'clear' })
                      await $.prompt.submit({
                        text: `Continúa el trabajo con este traspaso de la conversación anterior:\n\n${r.text}`,
                        asUser: true,
                      })
                      $.ui.toast('Handoff aplicado: contexto limpiado y traspaso enviado')
                    } catch (err) {
                      $.ui.toast(
                        `Handoff falló: ${err instanceof Error ? err.message : String(err)}`
                      )
                    } finally {
                      await update($, handoffBusy, () => null)
                    }
                  }}
                />
              </Box>
            ) : null}
            <Button
              key="dismiss"
              plain
              dimColor
              hotkey="0"
              label={padded('Descartar')}
              onPress={() => setSteps($, [])}
            />
          </Box>
        ) : null}
      </Box>
    )
  })
}
