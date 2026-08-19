/**
 * Tests for PendingLabelPanel — compact button + popup trade labeling.
 *
 * NOTE: Requires vitest + @testing-library/react to run. Not currently
 * installed in this project's frontend (no test runner in package.json).
 * Files are committed so the tests can be wired up later.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import PendingLabelPanel from './PendingLabelPanel'

vi.mock('../services/api', () => {
  const saveLabels = vi.fn().mockResolvedValue([])
  return {
    default: {
      patternListStrategies: vi.fn().mockResolvedValue({ strategies: ['Breakout', 'Pullback'] }),
      patternListCategories: vi.fn().mockResolvedValue({ categories: ['Opening', 'Midday'] }),
      getEntryTags: vi.fn().mockResolvedValue(['AS_PER_PATTERN', 'FOMO_ENTRY']),
      getExitTags: vi.fn().mockResolvedValue(['AS_PER_PATTERN', 'TARGET_HIT']),
      saveLabels,
    },
  }
})

const noop = () => {}

describe('PendingLabelPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when no pending exits and no open legs needing label', () => {
    const { container } = render(
      <PendingLabelPanel
        sessionId="sess-1"
        pendingExitLabels={[]}
        openLegs={[]}
        savedEntryRtKeys={[]}
        onSaveEntry={noop}
        onSaveExit={noop}
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders pending exit buttons', () => {
    render(
      <PendingLabelPanel
        sessionId="sess-1"
        pendingExitLabels={[
          { right: 'CE', round_trip_index: 0, pnl: 145.5, closed_at: Date.now() - 60_000 },
        ]}
        openLegs={[]}
        savedEntryRtKeys={[]}
        onSaveEntry={noop}
        onSaveExit={noop}
      />,
    )
    expect(screen.getByTestId('pendingexit-btn')).toBeInTheDocument()
  })

  it('renders entry button for un-saved current open legs', () => {
    render(
      <PendingLabelPanel
        sessionId="sess-1"
        pendingExitLabels={[]}
        openLegs={[{ right: null, rtIndex: 0, label: 'NIFTY (equity)' }]}
        savedEntryRtKeys={[]}
        onSaveEntry={noop}
        onSaveExit={noop}
      />,
    )
    expect(screen.getByTestId('entry-btn')).toBeInTheDocument()
  })

  it('hides entry button for legs that already have entry saved', () => {
    render(
      <PendingLabelPanel
        sessionId="sess-1"
        pendingExitLabels={[]}
        openLegs={[{ right: null, rtIndex: 0, label: 'NIFTY (equity)' }]}
        savedEntryRtKeys={['sess-1#0#EQ']}
        onSaveEntry={noop}
        onSaveExit={noop}
      />,
    )
    expect(screen.queryByTestId('entry-btn')).toBeNull()
  })

  it('clicking exit button opens popup', () => {
    render(
      <PendingLabelPanel
        sessionId="sess-1"
        pendingExitLabels={[
          { right: 'CE', round_trip_index: 2, pnl: 320.10, closed_at: Date.now() - 60_000 },
        ]}
        openLegs={[]}
        savedEntryRtKeys={[]}
        onSaveEntry={noop}
        onSaveExit={noop}
      />,
    )
    fireEvent.click(screen.getByTestId('pendingexit-btn'))
    expect(screen.getByText('Label Exit')).toBeInTheDocument()
  })

  it('clicking entry button opens popup', () => {
    render(
      <PendingLabelPanel
        sessionId="sess-1"
        pendingExitLabels={[]}
        openLegs={[{ right: 'CE', rtIndex: 3, label: 'NIFTY 24750 CE' }]}
        savedEntryRtKeys={[]}
        onSaveEntry={noop}
        onSaveExit={noop}
      />,
    )
    fireEvent.click(screen.getByTestId('entry-btn'))
    expect(screen.getByText('Label Entry')).toBeInTheDocument()
  })

  it('exit-save calls onSaveExit with actual_* and exit_tag fields', async () => {
    const onSaveExit = vi.fn()
    render(
      <PendingLabelPanel
        sessionId="sess-1"
        pendingExitLabels={[
          { right: 'CE', round_trip_index: 2, pnl: 320.10, closed_at: Date.now() - 60_000 },
        ]}
        openLegs={[]}
        savedEntryRtKeys={[]}
        onSaveEntry={noop}
        onSaveExit={onSaveExit}
      />,
    )
    fireEvent.click(screen.getByTestId('pendingexit-btn'))
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(onSaveExit).toHaveBeenCalledWith(
        2,
        'CE',
        { actual_category: '', actual_strategy: '', exit_tag: 'AS_PER_PATTERN' },
      )
    })
  })

  it('exit-save with user-filled fields passes them through', async () => {
    const onSaveExit = vi.fn()
    render(
      <PendingLabelPanel
        sessionId="sess-1"
        pendingExitLabels={[
          { right: 'PE', round_trip_index: 1, pnl: -50, closed_at: Date.now() - 60_000 },
        ]}
        openLegs={[]}
        savedEntryRtKeys={[]}
        onSaveEntry={noop}
        onSaveExit={onSaveExit}
      />,
    )
    fireEvent.click(screen.getByTestId('pendingexit-btn'))
    const selects = screen.getAllByRole('combobox')
    fireEvent.change(selects[0], { target: { value: 'Opening' } })
    fireEvent.change(selects[1], { target: { value: 'Breakout' } })
    fireEvent.change(screen.getByPlaceholderText('Exit tag'), { target: { value: 'TARGET_HIT' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(onSaveExit).toHaveBeenCalledWith(
        1,
        'PE',
        { actual_category: 'Opening', actual_strategy: 'Breakout', exit_tag: 'TARGET_HIT' },
      )
    })
  })

  it('entry-save calls onSaveEntry with expected_* and entry_tag fields', async () => {
    const onSaveEntry = vi.fn()
    render(
      <PendingLabelPanel
        sessionId="sess-1"
        pendingExitLabels={[]}
        openLegs={[{ right: 'CE', rtIndex: 3, label: 'NIFTY 24750 CE' }]}
        savedEntryRtKeys={[]}
        onSaveEntry={onSaveEntry}
        onSaveExit={noop}
      />,
    )
    fireEvent.click(screen.getByTestId('entry-btn'))
    const selects = screen.getAllByRole('combobox')
    fireEvent.change(selects[0], { target: { value: 'Midday' } })
    fireEvent.change(selects[1], { target: { value: 'Pullback' } })
    fireEvent.change(screen.getByPlaceholderText('Entry tag'), { target: { value: 'FOMO_ENTRY' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(onSaveEntry).toHaveBeenCalledWith(
        3,
        'CE',
        { expected_category: 'Midday', expected_strategy: 'Pullback', entry_tag: 'FOMO_ENTRY' },
      )
    })
  })

  it('shows both pending-exit and entry buttons when both apply', () => {
    render(
      <PendingLabelPanel
        sessionId="sess-1"
        pendingExitLabels={[
          { right: null, round_trip_index: 0, pnl: 100, closed_at: Date.now() - 60_000 },
        ]}
        openLegs={[{ right: 'CE', rtIndex: 1, label: 'NIFTY 24750 CE' }]}
        savedEntryRtKeys={[]}
        onSaveEntry={noop}
        onSaveExit={noop}
      />,
    )
    expect(screen.getByTestId('pendingexit-btn')).toBeInTheDocument()
    expect(screen.getByTestId('entry-btn')).toBeInTheDocument()
  })

  it('popup closes on Cancel', () => {
    render(
      <PendingLabelPanel
        sessionId="sess-1"
        pendingExitLabels={[
          { right: 'CE', round_trip_index: 0, pnl: 100, closed_at: Date.now() - 60_000 },
        ]}
        openLegs={[]}
        savedEntryRtKeys={[]}
        onSaveEntry={noop}
        onSaveExit={noop}
      />,
    )
    fireEvent.click(screen.getByTestId('pendingexit-btn'))
    expect(screen.getByText('Label Exit')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText('Label Exit')).toBeNull()
  })

  it('popup closes after successful save', async () => {
    const onSaveExit = vi.fn()
    render(
      <PendingLabelPanel
        sessionId="sess-1"
        pendingExitLabels={[
          { right: 'CE', round_trip_index: 0, pnl: 100, closed_at: Date.now() - 60_000 },
        ]}
        openLegs={[]}
        savedEntryRtKeys={[]}
        onSaveEntry={noop}
        onSaveExit={onSaveExit}
      />,
    )
    fireEvent.click(screen.getByTestId('pendingexit-btn'))
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      expect(screen.queryByText('Label Exit')).toBeNull()
    })
  })
})