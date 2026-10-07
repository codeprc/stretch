export const COUNTDOWN_STORAGE_KEY = 'mse-calendar-countdowns-v1'
export const COUNTDOWN_SYNC_EVENT = 'mse-calendar-countdowns-sync'

let completionAudioContext: AudioContext | null = null

export function playCompletionBell() {
  const AudioContextConstructor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextConstructor) return

  try {
    completionAudioContext ??= new AudioContextConstructor()
    const context = completionAudioContext
    if (context.state === 'suspended') void context.resume().catch(() => {})
    const start = context.currentTime
    ;[1046.5, 1318.5, 1568].forEach((frequency, index) => {
      const oscillator = context.createOscillator()
      const volume = context.createGain()
      const noteStart = start + index * 0.08
      oscillator.type = 'sine'
      oscillator.frequency.setValueAtTime(frequency, noteStart)
      volume.gain.setValueAtTime(0.0001, noteStart)
      volume.gain.exponentialRampToValueAtTime(0.1, noteStart + 0.012)
      volume.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.65)
      oscillator.connect(volume)
      volume.connect(context.destination)
      oscillator.start(noteStart)
      oscillator.stop(noteStart + 0.68)
    })
  } catch {}
}

export function stopCountdownForCompletedItem(type: 'task' | 'subtask', id: string) {
  try {
    const timers = JSON.parse(window.localStorage.getItem(COUNTDOWN_STORAGE_KEY) || '{}') as Record<string, unknown>
    const key = `${type}-${id}`
    if (!(key in timers)) return
    delete timers[key]
    window.localStorage.setItem(COUNTDOWN_STORAGE_KEY, JSON.stringify(timers))
    window.dispatchEvent(new Event(COUNTDOWN_SYNC_EVENT))
  } catch {}
}