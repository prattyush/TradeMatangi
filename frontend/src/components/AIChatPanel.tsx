import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import api, { DecisionItem, DecisionAction, StrategyItem, CommandItem, AnalysisResult } from '../services/api'

interface UserMessage {
  id: string
  role: 'user'
  text: string
}

interface AssistantMessage {
  id: string
  role: 'assistant'
  text: string
  status?: string
}

interface DecisionMessage {
  id: string
  role: 'decision'
  decision: DecisionItem
}

interface AnalysisMessage {
  id: string
  role: 'analysis'
  analysis: AnalysisResult
  periodLabel: string
}

type ChatMessage = UserMessage | AssistantMessage | DecisionMessage | AnalysisMessage
type PanelTab = 'chat' | 'commands' | 'hotwords'

interface Props {
  sessionId: string | null
  userId: string
  symbol: string | null
  strikeCe: number | null
  strikePe: number | null
}

function formatBarTime(isoTs: string): string {
  try {
    return new Date(isoTs).toLocaleTimeString('en-IN', {
      timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false,
    })
  } catch {
    return isoTs
  }
}

function formatAction(action: DecisionAction): string {
  const side = action.side ?? '?'
  const qty = (() => {
    if (action.quantity_type === 'ratio_l') return 'L ratio'
    if (action.quantity_type === 'ratio_m') return 'M ratio'
    if (action.quantity_type === 'ratio_h') return 'H ratio'
    if (action.quantity_type === 'fixed') return `${action.quantity_value ?? '?'} lots`
    return action.quantity_type ?? '?'
  })()
  const price = action.price_value != null
    ? `₹${action.price_value} (${action.price_type ?? 'limit'})`
    : 'at market'
  return `${side} ${qty} ${price}`
}

function formatResult(result: string): string {
  if (result === 'order_placed') return '✓ Order placed'
  if (result === 'rejected_guardrail') return '✗ Blocked by guardrail'
  if (result === 'backend_error') return '✗ Backend error'
  return result
}

function formatQty(quantityType: string, quantityValue?: number | null): string {
  if (quantityType === 'ratio_l') return 'L ratio'
  if (quantityType === 'ratio_m') return 'M ratio'
  if (quantityType === 'ratio_h') return 'H ratio'
  if (quantityType === 'fixed') return `${quantityValue ?? '?'} lots`
  return quantityType
}

let _msgCounter = 0
function nextId(): string {
  return `m${++_msgCounter}`
}

const STATUS_BADGE: Record<CommandItem['status'], { label: string; color: string; bg: string; border: string }> = {
  active:    { label: 'Watching',   color: '#56d364', bg: '#1f4d2e', border: '#2d6a3f' },
  executed:  { label: 'Executed',   color: '#8b949e', bg: '#21262d', border: '#30363d' },
  cancelled: { label: 'Cancelled',  color: '#f85149', bg: '#2d1b1b', border: '#6e3333' },
}

export default function AIChatPanel({ sessionId, userId, symbol, strikeCe, strikePe }: Props) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<PanelTab>('chat')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [inputText, setInputText] = useState('')
  const [loading, setLoading] = useState(false)
  const [strategies, setStrategies] = useState<StrategyItem[]>([])
  const [strategiesLoading, setStrategiesLoading] = useState(false)
  const [deletingHotword, setDeletingHotword] = useState<string | null>(null)
  const [commands, setCommands] = useState<CommandItem[]>([])
  const [commandsLoading, setCommandsLoading] = useState(false)
  const [cancellingCommand, setCancellingCommand] = useState<string | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const isDragging = useRef(false)
  const dragStart = useRef({ mouseX: 0, mouseY: 0, panelX: 0, panelY: 0 })
  const lastSeenTsRef = useRef<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  const effectivePos = useMemo(() => {
    if (pos) return pos
    const PANEL_W = 480, PANEL_H = 640, MARGIN = 24
    return {
      x: (typeof window !== 'undefined' ? window.innerWidth : 800) - PANEL_W - MARGIN,
      y: (typeof window !== 'undefined' ? window.innerHeight : 600) - PANEL_H - MARGIN,
    }
  }, [pos])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return
      setPos({
        x: dragStart.current.panelX + e.clientX - dragStart.current.mouseX,
        y: dragStart.current.panelY + e.clientY - dragStart.current.mouseY,
      })
    }
    const onMouseUp = () => { isDragging.current = false }
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    isDragging.current = true
    dragStart.current = {
      mouseX: e.clientX, mouseY: e.clientY,
      panelX: effectivePos.x, panelY: effectivePos.y,
    }
    e.preventDefault()
  }, [effectivePos])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Reset chat state when session changes
  useEffect(() => {
    setMessages([])
    setCommands([])
    lastSeenTsRef.current = null
  }, [sessionId])

  const fetchAndAppendDecisions = useCallback(async (): Promise<void> => {
    if (!sessionId) return
    try {
      const items = await api.aiGetDecisions(sessionId, lastSeenTsRef.current)
      if (items.length === 0) return
      lastSeenTsRef.current = items[items.length - 1].timestamp
      const decisionMsgs: DecisionMessage[] = items.map(d => ({
        id: nextId(), role: 'decision', decision: d,
      }))
      setMessages(prev => [...prev, ...decisionMsgs])
    } catch {
      // silently ignore — aihelper may not be running
    }
  }, [sessionId])

  const fetchCommands = useCallback(async () => {
    if (!sessionId) return
    setCommandsLoading(true)
    try {
      const items = await api.aiGetCommands(sessionId)
      setCommands(items)
    } catch {
      setCommands([])
    } finally {
      setCommandsLoading(false)
    }
  }, [sessionId])

  const fetchStrategies = useCallback(async () => {
    setStrategiesLoading(true)
    try {
      const items = await api.aiGetStrategies(userId)
      setStrategies(items)
    } catch {
      setStrategies([])
    } finally {
      setStrategiesLoading(false)
    }
  }, [userId])

  const handleOpen = useCallback(async () => {
    setOpen(true)
    await fetchAndAppendDecisions()
  }, [fetchAndAppendDecisions])

  const handleTabChange = useCallback((t: PanelTab) => {
    setTab(t)
    if (t === 'hotwords') fetchStrategies()
    if (t === 'commands') fetchCommands()
  }, [fetchStrategies, fetchCommands])

  const handleDelete = useCallback(async (hotword: string) => {
    setDeletingHotword(hotword)
    try {
      await api.aiDeleteStrategy(userId, hotword)
      setStrategies(prev => prev.filter(s => s.hotword !== hotword))
    } catch {
      // silently ignore
    } finally {
      setDeletingHotword(null)
    }
  }, [userId])

  const handleUseHotword = useCallback((hotword: string) => {
    setTab('chat')
    setInputText(`use ${hotword}`)
  }, [])

  const handleCancelCommand = useCallback(async (commandId: string) => {
    setCancellingCommand(commandId)
    try {
      await api.aiCancelCommand(commandId, userId)
      setCommands(prev => prev.map(c =>
        c.command_id === commandId ? { ...c, status: 'cancelled', cancel_reason: 'user_cancelled' } : c
      ))
    } catch {
      // silently ignore
    } finally {
      setCancellingCommand(null)
    }
  }, [userId])

  const handleSend = useCallback(async () => {
    const text = inputText.trim()
    if (!text || !sessionId || loading) return
    setInputText('')
    setLoading(true)

    setMessages(prev => [...prev, { id: nextId(), role: 'user', text }])

    // Fetch any decisions that fired since last check before showing response
    await fetchAndAppendDecisions()

    try {
      const data = await api.aiChat({
        message: text,
        session_id: sessionId,
        user_id: userId,
        symbol,
        strike_ce: strikeCe,
        strike_pe: strikePe,
      })
      if (data.status === 'analysis' && data.analysis) {
        // Extract period label from message (e.g. "Trade analysis for last 7 days:")
        const periodLabel = data.message.replace(/^Trade analysis for /, '').replace(/:.*$/s, '').trim()
        setMessages(prev => [...prev, {
          id: nextId(), role: 'analysis', analysis: data.analysis!, periodLabel,
        }])
      } else {
        setMessages(prev => [...prev, {
          id: nextId(), role: 'assistant', text: data.message, status: data.status,
        }])
      }
      // Refresh commands list if a new command was registered
      if (data.status === 'watching' && data.command_id) {
        fetchCommands()
      }
    } catch {
      setMessages(prev => [...prev, {
        id: nextId(), role: 'assistant',
        text: 'Could not reach AI helper. Make sure aihelper is running on port 8701.',
        status: 'error',
      }])
    } finally {
      setLoading(false)
    }
  }, [inputText, sessionId, userId, symbol, strikeCe, strikePe, loading, fetchAndAppendDecisions, fetchCommands])

  if (!open) {
    return (
      <button
        onClick={handleOpen}
        title="AI Assistant"
        style={{
          position: 'fixed', bottom: 24, right: 24,
          width: 48, height: 48, borderRadius: '50%',
          background: '#1f4d2e', border: '1px solid #56d364',
          color: '#56d364', fontSize: 13, fontWeight: 700,
          cursor: 'pointer', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 2px 10px rgba(0,0,0,0.5)',
        }}
      >
        AI
      </button>
    )
  }

  return (
    <div style={{
      position: 'fixed', left: effectivePos.x, top: effectivePos.y,
      width: 480, height: 640,
      background: '#0d1117', border: '1px solid #30363d',
      borderRadius: 12, display: 'flex', flexDirection: 'column',
      zIndex: 1000, boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
      overflow: 'hidden',
    }}>
      {/* Header — drag handle */}
      <div
        onMouseDown={handleHeaderMouseDown}
        style={{
          display: 'flex', alignItems: 'center', padding: '10px 14px',
          borderBottom: '1px solid #21262d', background: '#161b22',
          flexShrink: 0, gap: 8, cursor: 'grab',
          userSelect: 'none',
        }}
      >
        <span style={{ color: '#56d364', fontWeight: 700, fontSize: 13 }}>AI Assistant</span>
        {!sessionId && tab === 'chat' && (
          <span style={{ fontSize: 11, color: '#484f58' }}>— start a session to use commands</span>
        )}

        {/* Tabs */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {(['chat', 'commands', 'hotwords'] as PanelTab[]).map(t => (
            <button
              key={t}
              onClick={() => handleTabChange(t)}
              style={{
                background: tab === t ? '#1f4d2e' : 'none',
                border: `1px solid ${tab === t ? '#56d364' : '#30363d'}`,
                color: tab === t ? '#56d364' : '#8b949e',
                borderRadius: 6, padding: '3px 8px', fontSize: 11,
                cursor: 'pointer', fontWeight: tab === t ? 700 : 400,
                textTransform: 'capitalize',
              }}
            >
              {t}
            </button>
          ))}
        </div>

        <button
          onClick={() => setOpen(false)}
          style={{
            background: 'none', border: 'none',
            color: '#8b949e', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0,
          }}
        >✕</button>
      </div>

      {/* Chat tab */}
      {tab === 'chat' && (
        <>
          <div style={{
            flex: 1, overflowY: 'auto', padding: '10px 12px',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            {messages.length === 0 && (
              <div style={{ color: '#484f58', fontSize: 13, textAlign: 'center', marginTop: 20 }}>
                {sessionId
                  ? 'AI decisions appear here when commands fire. Type a command below.'
                  : 'Start a trading session to use AI commands.'}
              </div>
            )}

            {messages.map(msg => {
              if (msg.role === 'user') {
                return (
                  <div key={msg.id} style={{ alignSelf: 'flex-end', maxWidth: '82%' }}>
                    <div style={{
                      background: '#1f4d2e', border: '1px solid #2d6a3f',
                      borderRadius: '12px 12px 2px 12px',
                      padding: '8px 12px', fontSize: 14, color: '#e6edf3',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    }}>
                      {msg.text}
                    </div>
                  </div>
                )
              }

              if (msg.role === 'assistant') {
                const m = msg as AssistantMessage
                const isError = m.status === 'error'
                const isWatching = m.status === 'watching'
                return (
                  <div key={msg.id} style={{ alignSelf: 'flex-start', maxWidth: '85%' }}>
                    <div style={{
                      background: '#161b22',
                      border: `1px solid ${isError ? '#f85149' : isWatching ? '#56d364' : '#30363d'}`,
                      borderRadius: '2px 12px 12px 12px',
                      padding: '8px 12px', fontSize: 14, color: '#e6edf3',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    }}>
                      {m.text}
                    </div>
                  </div>
                )
              }

              // Analysis message
              if (msg.role === 'analysis') {
                const am = msg as AnalysisMessage
                const a = am.analysis
                const stats = a.notable_stats ?? {}
                return (
                  <div key={msg.id} style={{ alignSelf: 'flex-start', width: '95%' }}>
                    <div style={{
                      background: '#0d1117', border: '1px solid #1f6feb',
                      borderRadius: 10, padding: '10px 12px', fontSize: 11,
                    }}>
                      <div style={{ color: '#58a6ff', fontWeight: 700, marginBottom: 6, fontSize: 12 }}>
                        📊 Trade Analysis — {am.periodLabel}
                      </div>

                      {/* Summary */}
                      <div style={{ color: '#e6edf3', marginBottom: 8, lineHeight: 1.5, wordBreak: 'break-word' }}>
                        {a.summary}
                      </div>

                      {/* Notable Stats */}
                      {Object.keys(stats).length > 0 && (
                        <div style={{
                          display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 8,
                        }}>
                          {stats.win_rate && (
                            <span style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 4, padding: '2px 7px', color: '#8b949e', fontSize: 10 }}>
                              Win rate: <strong style={{ color: '#e6edf3' }}>{stats.win_rate}</strong>
                            </span>
                          )}
                          {stats.avg_profit_pct && (
                            <span style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 4, padding: '2px 7px', color: '#8b949e', fontSize: 10 }}>
                              Avg profit: <strong style={{ color: '#56d364' }}>{stats.avg_profit_pct}</strong>
                            </span>
                          )}
                          {stats.avg_loss_pct && (
                            <span style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 4, padding: '2px 7px', color: '#8b949e', fontSize: 10 }}>
                              Avg loss: <strong style={{ color: '#f85149' }}>{stats.avg_loss_pct}</strong>
                            </span>
                          )}
                          {stats.best_time_of_day && (
                            <span style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 4, padding: '2px 7px', color: '#8b949e', fontSize: 10 }}>
                              Best time: <strong style={{ color: '#e6edf3' }}>{stats.best_time_of_day}</strong>
                            </span>
                          )}
                          {stats.worst_time_of_day && (
                            <span style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 4, padding: '2px 7px', color: '#8b949e', fontSize: 10 }}>
                              Worst time: <strong style={{ color: '#e6edf3' }}>{stats.worst_time_of_day}</strong>
                            </span>
                          )}
                        </div>
                      )}

                      {/* Patterns */}
                      {a.patterns && a.patterns.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <div style={{ color: '#484f58', fontSize: 10, marginBottom: 4 }}>PATTERNS</div>
                          {a.patterns.map((p, i) => (
                            <div key={i} style={{
                              background: '#161b22',
                              border: `1px solid ${p.type === 'positive' ? '#238636' : '#6e3333'}`,
                              borderRadius: 6, padding: '5px 8px', marginBottom: 4,
                            }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                                <span style={{ fontSize: 10 }}>{p.type === 'positive' ? '✓' : '✗'}</span>
                                <span style={{ color: p.type === 'positive' ? '#56d364' : '#f85149', fontWeight: 600, fontSize: 11 }}>
                                  {p.title}
                                </span>
                                {p.frequency && (
                                  <span style={{ color: '#484f58', fontSize: 10, marginLeft: 'auto', flexShrink: 0 }}>
                                    {p.frequency}
                                  </span>
                                )}
                              </div>
                              <div style={{ color: '#8b949e', fontSize: 10, lineHeight: 1.4, wordBreak: 'break-word' }}>
                                {p.detail}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* Suggestions */}
                      {a.suggestions && a.suggestions.length > 0 && (
                        <div>
                          <div style={{ color: '#484f58', fontSize: 10, marginBottom: 4 }}>SUGGESTIONS</div>
                          {a.suggestions.map((s, i) => (
                            <div key={i} style={{
                              color: '#8b949e', fontSize: 11, marginBottom: 3,
                              paddingLeft: 8, borderLeft: '2px solid #1f6feb',
                              wordBreak: 'break-word', lineHeight: 1.4,
                            }}>
                              {s}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              }

              // Decision message
              const d = (msg as DecisionMessage).decision
              const isSuccess = d.action_result === 'order_placed'
              const shortCmd = d.command_text.length > 70
                ? d.command_text.slice(0, 70) + '…'
                : d.command_text
              return (
                <div key={msg.id} style={{ alignSelf: 'flex-start', width: '92%' }}>
                  <div style={{
                    background: '#0d1117',
                    border: `1px solid ${isSuccess ? '#238636' : '#f0883e'}`,
                    borderRadius: 8, padding: '8px 10px', fontSize: 11,
                  }}>
                    <div style={{ color: '#56d364', fontWeight: 600, marginBottom: 4, fontSize: 10 }}>
                      🤖 {formatBarTime(d.bar_time)} IST — command triggered
                    </div>
                    <div style={{ color: '#8b949e', marginBottom: 4, fontStyle: 'italic', wordBreak: 'break-word' }}>
                      "{shortCmd}"
                    </div>
                    <div style={{ marginBottom: 2, color: '#e6edf3' }}>
                      <span style={{ color: '#484f58' }}>Action: </span>
                      {formatAction(d.action)}
                    </div>
                    <div style={{ marginBottom: 2, color: '#8b949e', wordBreak: 'break-word' }}>
                      <span style={{ color: '#484f58' }}>Reason: </span>
                      {d.reason}
                    </div>
                    <div style={{ color: isSuccess ? '#56d364' : '#f85149' }}>
                      <span style={{ color: '#484f58' }}>Result: </span>
                      {formatResult(d.action_result)}
                    </div>
                  </div>
                </div>
              )
            })}

            {loading && (
              <div style={{ alignSelf: 'flex-start', color: '#484f58', fontSize: 13 }}>
                AI is thinking…
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div style={{
            borderTop: '1px solid #21262d', padding: '8px 12px',
            display: 'flex', gap: 8, alignItems: 'flex-end',
            flexShrink: 0, background: '#161b22',
          }}>
            <textarea
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleSend()
                }
              }}
              disabled={!sessionId || loading}
              placeholder={sessionId ? 'Type a command or question… (Enter to send)' : 'No active session'}
              rows={2}
              style={{
                flex: 1, resize: 'none', background: '#0d1117',
                border: '1px solid #30363d', color: '#e6edf3',
                borderRadius: 8, padding: '7px 10px', fontSize: 14,
                fontFamily: 'inherit', outline: 'none',
                opacity: !sessionId ? 0.5 : 1,
              }}
            />
            <button
              onClick={handleSend}
              disabled={!sessionId || loading || !inputText.trim()}
              style={{
                background: '#1f4d2e', border: '1px solid #56d364',
                color: '#56d364', borderRadius: 8, padding: '7px 16px',
                fontSize: 14, cursor: 'pointer', fontWeight: 600,
                opacity: (!sessionId || loading || !inputText.trim()) ? 0.4 : 1,
                flexShrink: 0, alignSelf: 'stretch',
              }}
            >
              Send
            </button>
          </div>
        </>
      )}

      {/* Commands tab */}
      {tab === 'commands' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: '#8b949e', fontSize: 11 }}>
              Commands for this session
            </span>
            <button
              onClick={fetchCommands}
              disabled={commandsLoading || !sessionId}
              style={{
                background: 'none', border: '1px solid #30363d',
                color: '#8b949e', borderRadius: 6, padding: '2px 8px',
                fontSize: 11, cursor: 'pointer',
                opacity: (commandsLoading || !sessionId) ? 0.5 : 1,
              }}
            >
              {commandsLoading ? '…' : '↻ Refresh'}
            </button>
          </div>

          {!sessionId && (
            <div style={{ color: '#484f58', fontSize: 13, textAlign: 'center', marginTop: 20 }}>
              Start a trading session to see commands.
            </div>
          )}

          {sessionId && commandsLoading && commands.length === 0 && (
            <div style={{ color: '#484f58', fontSize: 13, textAlign: 'center', marginTop: 20 }}>
              Loading…
            </div>
          )}

          {sessionId && !commandsLoading && commands.length === 0 && (
            <div style={{ color: '#484f58', fontSize: 13, textAlign: 'center', marginTop: 20 }}>
              No commands this session.{'\n'}
              <span style={{ fontSize: 11 }}>
                Type a command in the Chat tab to add one.
              </span>
            </div>
          )}

          {commands.map(cmd => {
            const badge = STATUS_BADGE[cmd.status]
            const isActive = cmd.status === 'active'
            const shortTrigger = cmd.parsed_trigger.length > 80
              ? cmd.parsed_trigger.slice(0, 80) + '…'
              : cmd.parsed_trigger
            const symbolLabel = [
              cmd.symbol,
              cmd.right,
              cmd.strike ? `(${cmd.strike})` : null,
            ].filter(Boolean).join(' ')

            return (
              <div key={cmd.command_id} style={{
                background: '#161b22',
                border: `1px solid ${isActive ? '#21262d' : '#1c2128'}`,
                borderRadius: 8, padding: '9px 11px',
                opacity: cmd.status === 'cancelled' ? 0.65 : 1,
              }}>
                {/* Status badge row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                  <span style={{
                    background: badge.bg, border: `1px solid ${badge.border}`,
                    color: badge.color, borderRadius: 4, padding: '1px 7px',
                    fontSize: 10, fontWeight: 700, flexShrink: 0,
                  }}>
                    {badge.label}
                  </span>

                  {cmd.hotword && (
                    <span style={{
                      color: '#56d364', fontSize: 10,
                      background: '#1f4d2e', border: '1px solid #2d6a3f',
                      borderRadius: 4, padding: '1px 6px',
                    }}>
                      {cmd.hotword}
                    </span>
                  )}

                  {symbolLabel && (
                    <span style={{ color: '#8b949e', fontSize: 10, marginLeft: 2 }}>
                      {symbolLabel}
                    </span>
                  )}

                  {isActive && (
                    <button
                      onClick={() => handleCancelCommand(cmd.command_id)}
                      disabled={cancellingCommand === cmd.command_id}
                      title="Cancel this command"
                      style={{
                        marginLeft: 'auto',
                        background: 'none', border: '1px solid #f85149',
                        color: '#f85149', borderRadius: 5, padding: '2px 8px',
                        fontSize: 10, cursor: 'pointer',
                        opacity: cancellingCommand === cmd.command_id ? 0.5 : 1,
                        flexShrink: 0,
                      }}
                    >
                      {cancellingCommand === cmd.command_id ? '…' : 'Cancel'}
                    </button>
                  )}
                </div>

                {/* Order details row */}
                <div style={{ display: 'flex', gap: 6, marginBottom: 5, flexWrap: 'wrap' }}>
                  <span style={{
                    color: '#8b949e', fontSize: 10,
                    background: '#21262d', borderRadius: 3, padding: '1px 5px',
                  }}>
                    {cmd.order_type}
                  </span>
                  <span style={{
                    color: '#8b949e', fontSize: 10,
                    background: '#21262d', borderRadius: 3, padding: '1px 5px',
                  }}>
                    {formatQty(cmd.quantity_type, cmd.quantity_value)}
                  </span>
                  {cmd.parsed_price_expr && cmd.parsed_price_expr !== 'market' && (
                    <span style={{
                      color: '#8b949e', fontSize: 10,
                      background: '#21262d', borderRadius: 3, padding: '1px 5px',
                    }}>
                      @ {cmd.parsed_price_expr}
                    </span>
                  )}
                </div>

                {/* Trigger */}
                {shortTrigger && (
                  <div style={{ color: '#8b949e', fontSize: 11, wordBreak: 'break-word', marginBottom: 3 }}>
                    {shortTrigger}
                  </div>
                )}

                {/* Timestamps */}
                <div style={{ color: '#484f58', fontSize: 10 }}>
                  {cmd.created_at && `Added ${formatBarTime(cmd.created_at)}`}
                  {cmd.fired_at && ` · Fired ${formatBarTime(cmd.fired_at)}`}
                  {cmd.cancel_reason && ` · ${cmd.cancel_reason.replace(/_/g, ' ')}`}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Hotwords tab */}
      {tab === 'hotwords' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <span style={{ color: '#8b949e', fontSize: 11 }}>
              Saved strategies recalled by name in chat
            </span>
            <button
              onClick={fetchStrategies}
              disabled={strategiesLoading}
              style={{
                background: 'none', border: '1px solid #30363d',
                color: '#8b949e', borderRadius: 6, padding: '2px 8px',
                fontSize: 11, cursor: 'pointer',
                opacity: strategiesLoading ? 0.5 : 1,
              }}
            >
              {strategiesLoading ? '…' : '↻ Refresh'}
            </button>
          </div>

          {strategiesLoading && strategies.length === 0 && (
            <div style={{ color: '#484f58', fontSize: 13, textAlign: 'center', marginTop: 20 }}>
              Loading…
            </div>
          )}

          {!strategiesLoading && strategies.length === 0 && (
            <div style={{ color: '#484f58', fontSize: 13, textAlign: 'center', marginTop: 20 }}>
              No saved hotwords yet.{'\n'}
              <span style={{ fontSize: 11 }}>
                Add "save as 'name'" to any command to save it.
              </span>
            </div>
          )}

          {strategies.map(s => (
            <div key={s.hotword} style={{
              background: '#161b22', border: '1px solid #21262d',
              borderRadius: 8, padding: '9px 11px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                <span style={{
                  color: '#56d364', fontWeight: 700, fontSize: 12,
                  background: '#1f4d2e', border: '1px solid #2d6a3f',
                  borderRadius: 4, padding: '1px 7px',
                }}>
                  {s.hotword}
                </span>
                {s.use_count != null && s.use_count > 0 && (
                  <span style={{ color: '#484f58', fontSize: 10 }}>
                    used {s.use_count}×
                  </span>
                )}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  <button
                    onClick={() => handleUseHotword(s.hotword)}
                    disabled={!sessionId}
                    title={sessionId ? `Send "use ${s.hotword}"` : 'Start a session first'}
                    style={{
                      background: '#1f4d2e', border: '1px solid #56d364',
                      color: '#56d364', borderRadius: 5, padding: '2px 9px',
                      fontSize: 11, cursor: sessionId ? 'pointer' : 'not-allowed',
                      fontWeight: 600, opacity: sessionId ? 1 : 0.4,
                    }}
                  >
                    Use
                  </button>
                  <button
                    onClick={() => handleDelete(s.hotword)}
                    disabled={deletingHotword === s.hotword}
                    title="Delete this hotword"
                    style={{
                      background: 'none', border: '1px solid #f85149',
                      color: '#f85149', borderRadius: 5, padding: '2px 8px',
                      fontSize: 11, cursor: 'pointer',
                      opacity: deletingHotword === s.hotword ? 0.5 : 1,
                    }}
                  >
                    {deletingHotword === s.hotword ? '…' : '✕'}
                  </button>
                </div>
              </div>
              {s.description && (
                <div style={{ color: '#8b949e', fontSize: 11, wordBreak: 'break-word', marginBottom: 3 }}>
                  {s.description}
                </div>
              )}
              {s.last_used_at && (
                <div style={{ color: '#484f58', fontSize: 10 }}>
                  Last used: {new Date(s.last_used_at).toLocaleDateString('en-IN')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
