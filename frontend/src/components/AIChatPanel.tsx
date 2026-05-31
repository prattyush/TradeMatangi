import { useState, useRef, useCallback, useEffect } from 'react'
import api, { DecisionItem, DecisionAction, StrategyItem } from '../services/api'

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

type ChatMessage = UserMessage | AssistantMessage | DecisionMessage
type PanelTab = 'chat' | 'hotwords'

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

let _msgCounter = 0
function nextId(): string {
  return `m${++_msgCounter}`
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
  const lastSeenTsRef = useRef<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Reset chat state when session changes
  useEffect(() => {
    setMessages([])
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
    if (t === 'hotwords') {
      fetchStrategies()
    }
  }, [fetchStrategies])

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
      setMessages(prev => [...prev, {
        id: nextId(), role: 'assistant', text: data.message, status: data.status,
      }])
    } catch {
      setMessages(prev => [...prev, {
        id: nextId(), role: 'assistant',
        text: 'Could not reach AI helper. Make sure aihelper is running on port 8701.',
        status: 'error',
      }])
    } finally {
      setLoading(false)
    }
  }, [inputText, sessionId, userId, symbol, strikeCe, strikePe, loading, fetchAndAppendDecisions])

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
      position: 'fixed', bottom: 24, right: 24,
      width: 380, height: 520,
      background: '#0d1117', border: '1px solid #30363d',
      borderRadius: 12, display: 'flex', flexDirection: 'column',
      zIndex: 1000, boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', padding: '10px 14px',
        borderBottom: '1px solid #21262d', background: '#161b22',
        flexShrink: 0, gap: 8,
      }}>
        <span style={{ color: '#56d364', fontWeight: 700, fontSize: 13 }}>AI Assistant</span>
        {!sessionId && tab === 'chat' && (
          <span style={{ fontSize: 11, color: '#484f58' }}>— start a session to use commands</span>
        )}

        {/* Tabs */}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button
            onClick={() => handleTabChange('chat')}
            style={{
              background: tab === 'chat' ? '#1f4d2e' : 'none',
              border: `1px solid ${tab === 'chat' ? '#56d364' : '#30363d'}`,
              color: tab === 'chat' ? '#56d364' : '#8b949e',
              borderRadius: 6, padding: '3px 10px', fontSize: 11,
              cursor: 'pointer', fontWeight: tab === 'chat' ? 700 : 400,
            }}
          >
            Chat
          </button>
          <button
            onClick={() => handleTabChange('hotwords')}
            style={{
              background: tab === 'hotwords' ? '#1f4d2e' : 'none',
              border: `1px solid ${tab === 'hotwords' ? '#56d364' : '#30363d'}`,
              color: tab === 'hotwords' ? '#56d364' : '#8b949e',
              borderRadius: 6, padding: '3px 10px', fontSize: 11,
              cursor: 'pointer', fontWeight: tab === 'hotwords' ? 700 : 400,
            }}
          >
            Hotwords
          </button>
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
              <div style={{ color: '#484f58', fontSize: 12, textAlign: 'center', marginTop: 20 }}>
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
                      padding: '7px 11px', fontSize: 12, color: '#e6edf3',
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
                      padding: '7px 11px', fontSize: 12, color: '#e6edf3',
                      whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    }}>
                      {m.text}
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
              <div style={{ alignSelf: 'flex-start', color: '#484f58', fontSize: 11 }}>
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
                borderRadius: 8, padding: '6px 10px', fontSize: 12,
                fontFamily: 'inherit', outline: 'none',
                opacity: !sessionId ? 0.5 : 1,
              }}
            />
            <button
              onClick={handleSend}
              disabled={!sessionId || loading || !inputText.trim()}
              style={{
                background: '#1f4d2e', border: '1px solid #56d364',
                color: '#56d364', borderRadius: 8, padding: '6px 14px',
                fontSize: 12, cursor: 'pointer', fontWeight: 600,
                opacity: (!sessionId || loading || !inputText.trim()) ? 0.4 : 1,
                flexShrink: 0, height: 56,
              }}
            >
              Send
            </button>
          </div>
        </>
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
            <div style={{ color: '#484f58', fontSize: 12, textAlign: 'center', marginTop: 20 }}>
              Loading…
            </div>
          )}

          {!strategiesLoading && strategies.length === 0 && (
            <div style={{ color: '#484f58', fontSize: 12, textAlign: 'center', marginTop: 20 }}>
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
