import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWindowCloser, bounded, closeAfterSave, controlledScreens, journalKey, recoverState, SAVE_TIMEOUT_MS } from './windowLifecycle'

afterEach(() => vi.useRealTimers())
describe('window close and screen recovery', () => {
  it('finishes a successful save without leaving a deadline timer', async () => {
    vi.useFakeTimers()
    await expect(bounded(Promise.resolve('saved'), SAVE_TIMEOUT_MS)).resolves.toBe('saved')
    expect(vi.getTimerCount()).toBe(0)
  })
  it('bounds a save that never settles', async () => {
    vi.useFakeTimers()
    const result = bounded(new Promise(() => {}), SAVE_TIMEOUT_MS)
    const assertion = expect(result).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })
  it('surfaces an immediate save failure without waiting', async () => {
    await expect(bounded(Promise.reject(new Error('offline')), SAVE_TIMEOUT_MS)).rejects.toThrow('offline')
  })
  it('recovers unsaved run references at the same backend revision', () => {
    const saved = { mode: 'Browse', session_id: undefined as string | undefined }
    const state = { mode: 'Stepwise', session_id: 'session-running' }
    expect(recoverState(saved, 3, { revision: 3, state, mutationId: 'close' })).toEqual(state)
  })
  it('never overwrites a newer backend save with an older journal', () => {
    expect(recoverState('new layout', 4, { revision: 3, state: 'old layout', mutationId: 'old' })).toBe('new layout')
    expect(recoverState('saved', 4, null)).toBe('saved')
  })
  it('isolates journals by screen and backend', () => {
    expect(journalKey('http://backend/', 'screen-a')).toBe(journalKey('http://backend', 'screen-a'))
    expect(journalKey('http://backend', 'screen-a')).not.toBe(journalKey('http://backend', 'screen-b'))
    expect(journalKey('http://other', 'screen-a')).not.toBe(journalKey('http://backend', 'screen-a'))
  })
})

describe('window handoff and automatic close', () => {
  const screens = [{ id: 'one', persistedId: 'saved-one' }, { id: 'two', persistedId: 'saved-two' }]
  it('mounts no temporary child controller during discovery', () => {
    expect(controlledScreens(screens, 'two', false, [])).toEqual([])
  })
  it('mounts only the assigned child and leaves the other main screen running', () => {
    expect(controlledScreens(screens, 'two', true, ['two'])).toEqual([screens[1]])
    expect(controlledScreens(screens, 'saved-two', true, [])).toEqual([screens[1]])
    expect(controlledScreens(screens, null, true, ['two'])).toEqual([screens[0]])
  })
  it('restores both main controllers after rollback or child close', () => {
    expect(controlledScreens(screens, null, true, [])).toEqual(screens)
  })
  it('does not mount an unrelated controller for a missing assigned screen', () => {
    expect(controlledScreens(screens, 'missing', true, [])).toEqual([])
  })
  it('closes even after save failure', async () => {
    const close = vi.fn(async () => {})
    const error = vi.fn()
    await closeAfterSave(Promise.reject(new Error('offline')), close, error)
    expect(close).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledOnce()
  })
  it('closes after the deadline when saving hangs', async () => {
    vi.useFakeTimers()
    const close = vi.fn(async () => {})
    const result = closeAfterSave(new Promise(() => {}), close, vi.fn())
    await vi.advanceTimersByTimeAsync(SAVE_TIMEOUT_MS)
    await result
    expect(close).toHaveBeenCalledOnce()
  })
})

describe("single window close owner", () => {
  it("deduplicates native close, detach and repeated requests", async () => {
    let resolveSave!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        }),
    );
    const finish = vi.fn(async () => {});
    const request = createWindowCloser(save, finish, vi.fn());
    const first = request();
    const second = request();
    await Promise.resolve();
    resolveSave();
    await Promise.all([first, second]);
    await request();
    expect(save).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledOnce();
  });
  it("honors dirty/saving label navigation guards before saving", async () => {
    const save = vi.fn(async () => {}),
      finish = vi.fn(async () => {});
    await createWindowCloser(save, finish, vi.fn(), () => false)();
    expect(save).not.toHaveBeenCalled();
    expect(finish).not.toHaveBeenCalled();
  });
  it("allows retry after native closure fails", async () => {
    const finish = vi
      .fn()
      .mockRejectedValueOnce(new Error("native"))
      .mockResolvedValueOnce(undefined);
    const request = createWindowCloser(
      vi.fn(async () => {}),
      finish,
      vi.fn(),
    );
    await request();
    await request();
    expect(finish).toHaveBeenCalledTimes(2);
  });
});
