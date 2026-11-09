// WebAudio playback of the sounds converted from rp_Tnk_sound.brsar
// (public/assets/audio, see docs/audio.md).

export type SoundInfo = {
  file: string
  volume?: number
  loop?: boolean
  loopStart?: number
  loopEnd?: number
  sampleRate?: number
}

type BgmInfo = { file: string; volume?: number; stems?: { file: string }[]; loop?: boolean; loopStart?: number; loopEnd?: number; sampleRate?: number }

export type Manifest = {
  sounds: Record<string, SoundInfo & { id?: number }>
  bgm?: Record<string, BgmInfo>
  commonSounds?: Record<string, SoundInfo>
  commonBgm?: Record<string, BgmInfo>
}

export class Audio {
  ctx = new AudioContext()
  master = this.ctx.createGain()
  sfxBus = this.ctx.createGain()
  musicBus = this.ctx.createGain()
  manifest: Manifest = { sounds: {} }
  private buffers = new Map<string, Promise<AudioBuffer | null>>()
  private loops = new Map<string, { src: AudioBufferSourceNode; gain: GainNode }>()
  private music: { sources: AudioBufferSourceNode[]; gains: GainNode[]; name: string; vol: number } | null = null

  constructor(private base = 'assets/audio/') {
    this.master.connect(this.ctx.destination)
    this.sfxBus.connect(this.master)
    this.musicBus.connect(this.master)
    const unlock = () => {
      if (this.ctx.state !== 'running') this.ctx.resume()
    }
    addEventListener('pointerdown', unlock)
    addEventListener('keydown', unlock)
  }

  private byId = new Map<number, string>()

  async load() {
    try {
      this.manifest = await fetch(this.base + 'manifest.json').then((r) => r.json())
    } catch {
      console.warn('audio manifest missing')
    }
    for (const [name, s] of Object.entries(this.manifest.sounds)) if (s.id != null) this.byId.set(s.id, name)
    for (const [name, s] of Object.entries(this.manifest.bgm ?? {})) if ((s as unknown as { id?: number }).id != null) this.byId.set((s as unknown as { id: number }).id, name)
  }

  /** brsar sound index (rp_Tnk_sound.h) -> label */
  nameOf(id: number) {
    return this.byId.get(id)
  }

  private info(name: string): SoundInfo | undefined {
    return this.manifest.sounds[name] ?? this.manifest.commonSounds?.[name] ?? (this.manifest.bgm?.[name] as SoundInfo | undefined)
  }

  private buffer(file: string) {
    let p = this.buffers.get(file)
    if (!p) {
      p = fetch(this.base + file)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(r.status)))
        .then((b) => this.ctx.decodeAudioData(b))
        .catch(() => null)
      this.buffers.set(file, p)
    }
    return p
  }

  /** preload every sound so the first shot isn't silent */
  preload(names = Object.keys(this.manifest.sounds)) {
    return Promise.all(names.map((n) => this.manifest.sounds[n] && this.buffer(this.manifest.sounds[n].file)))
  }

  /** fire-and-forget sound effect; `pan` in -1..1 */
  async play(name: string, opts: { volume?: number; pan?: number; rate?: number } = {}) {
    const info = this.info(name)
    if (!info) return
    const buf = await this.buffer(info.file)
    if (!buf) return
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    if (opts.rate) src.playbackRate.value = opts.rate
    const gain = this.ctx.createGain()
    gain.gain.value = (info.volume ?? 1) * (opts.volume ?? 1)
    let node: AudioNode = gain
    if (opts.pan) {
      const p = this.ctx.createStereoPanner()
      p.pan.value = opts.pan
      gain.connect(p)
      node = p
    }
    node.connect(this.sfxBus)
    src.connect(gain)
    src.start()
  }

  /** start/keep a looping sound under `key`; volume 0 stops it */
  async loop(key: string, name: string, volume: number, rate = 1) {
    const cur = this.loops.get(key)
    if (volume <= 0) {
      if (cur) {
        cur.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03)
        try {
          cur.src.stop(this.ctx.currentTime + 0.2)
        } catch {
          // still loading: never started
        }
        this.loops.delete(key)
      }
      return
    }
    if (cur) {
      cur.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.03)
      cur.src.playbackRate.value = rate
      return
    }
    const info = this.info(name)
    if (!info) return
    const placeholder = { src: this.ctx.createBufferSource(), gain: this.ctx.createGain() }
    this.loops.set(key, placeholder)
    const buf = await this.buffer(info.file)
    if (!buf || this.loops.get(key) !== placeholder) return
    const { src, gain } = placeholder
    src.buffer = buf
    src.loop = true
    // loop points are in source samples; decoded buffers are resampled to the context rate
    const rate0 = info.sampleRate ?? buf.sampleRate
    if (info.loopStart != null) src.loopStart = info.loopStart / rate0
    if (info.loopEnd != null) src.loopEnd = info.loopEnd / rate0
    src.playbackRate.value = rate
    gain.gain.value = volume * (info.volume ?? 1)
    src.connect(gain).connect(this.sfxBus)
    src.start()
  }

  stopLoops() {
    for (const k of [...this.loops.keys()]) this.loop(k, '', 0)
  }

  /**
   * Play a BGM. Layered music is a set of sample-aligned stems; `layers` gives
   * the initial gain per stem.
   */
  async playMusic(name: string, layers?: number[]) {
    this.stopMusic()
    const info = this.manifest.bgm?.[name] ?? this.manifest.commonBgm?.[name]
    if (!info) return
    const files = layers && info.stems ? info.stems.map((s) => s.file) : [info.file]
    const token = {}
    this.musicToken = token
    const bufs = await Promise.all(files.map((f) => this.buffer(f)))
    if (this.musicToken !== token) return
    const vol = info.volume ?? 1
    const t0 = this.ctx.currentTime + 0.05
    const sources: AudioBufferSourceNode[] = []
    const gains: GainNode[] = []
    bufs.forEach((buf, i) => {
      const src = this.ctx.createBufferSource()
      const gain = this.ctx.createGain()
      gain.gain.value = (layers && files.length > 1 ? (layers[i] ?? 0) : 1) * vol
      if (buf) {
        src.buffer = buf
        if (info.loop && info.loopStart != null) {
          src.loop = true
          // loop points are in source samples; decoded buffers are resampled to the context rate
          const rate0 = info.sampleRate ?? buf.sampleRate
          src.loopStart = info.loopStart / rate0
          src.loopEnd = info.loopEnd != null ? info.loopEnd / rate0 : buf.duration
        }
      }
      src.connect(gain).connect(this.musicBus)
      if (buf) src.start(t0)
      sources.push(src)
      gains.push(gain)
    })
    this.music = { sources, gains, name, vol }
  }

  private musicToken: object | null = null

  /** fade individual stems in/out (tank-type layers) */
  /**
   * RPTnkBgmMix track mask on a stem BGM: unmuted stems come in at once (the next note-on),
   * muted ones get a short release instead of being cut (MUTE_NO_STOP lets notes ring out).
   */
  setTrackMask(mask: number) {
    this.pendingMask = mask
    const m = this.music
    if (!m || m.gains.length < 2) return
    const t = this.ctx.currentTime
    m.gains.forEach((g, i) => {
      const on = (mask >> i) & 1
      g.gain.cancelScheduledValues(t)
      if (on) g.gain.setTargetAtTime(m.vol, t, 0.01)
      else g.gain.setTargetAtTime(0, t, 0.12)
    })
  }

  pendingMask = 0xffff

  layersFor(mask: number, n = 11) {
    return Array.from({ length: n }, (_, i) => (mask >> i) & 1)
  }

  stopMusic(fadeSeconds = 0) {
    this.musicToken = null
    if (!this.music) return
    if (fadeSeconds > 0) {
      const t = this.ctx.currentTime
      for (const g of this.music.gains) g.gain.setTargetAtTime(0, t, fadeSeconds / 3)
      for (const s of this.music.sources)
        try {
          s.stop(t + fadeSeconds)
        } catch {}
      this.music = null
      return
    }
    for (const s of this.music.sources)
      try {
        s.stop()
      } catch {}
    this.music = null
  }

  get musicName() {
    return this.music?.name ?? null
  }
}
