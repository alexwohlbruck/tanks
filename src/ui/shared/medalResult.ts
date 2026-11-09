// RPMedalResult with RPRecordLyt (myRecord_00) and RPRankGetLyt (ptRankGet_00): the 1P result
// after the Tanks result list. "My Record" shows the five best scores with the new one inserted,
// then, if a better medal than the saved one was reached, the medal is awarded; both are saved.
// The 3D parts (the player's Mii avatar, the medal model, the Bcm_* effects) are drawn in 2D.

import { fullWidth, loadLayout, Lyt, msg } from '../lyt'
import { panePos, plural, Seq, type MenuInput, type SoundHost, WIDE_X } from './common'
import { drawMedal } from './medal'
import { drawMiiFigure, type Expression, type Pose } from './mii'
import { loadPlayerData, savePlayerData } from './save'

/** RPMedalResult sMedalThresholds, Tanks row: bronze / silver / gold / platinum */
export const TANKS_MEDALS = [11, 32, 84, 125]
/** Party game index of Tanks (message index 9) */
const GAME_MSG = 9
/** RPMedalResult::sRecordOffsets / sModelOffsets for the 16:9 TV mode */
const RECORD_OFFSET = { x: 20, y: 110 }
const MODEL_OFFSET = { x: 25, y: 90 }

const NEW_REC = ['N_newRec_00', 'N_newRec_01', 'N_newRec_02', 'N_newRec_03', 'N_newRec_04']
const T_RECORD = ['N_tRecord_00', 'N_tRecord_01', 'N_tRecord_02', 'N_tRecord_03', 'N_tRecord_04']

/** RPRecordLyt states: 0 off, 1 in, 2 blink, 3 new record, 4 shown, 5 out, 6 done */
class RecordLyt {
  l!: Lyt
  seq = new Seq()
  score = 0
  rank = -1
  records = [0, 0, 0, 0, 0]
  hasRecords = false
  /** unk35: the record jingle cue (one frame) */
  cue = false
  private latched: { x: number; y: number } | null = null

  constructor(private snd: SoundHost) {}

  async load() {
    this.l = new Lyt(await loadLayout('myRecord_00'))
  }

  reset() {
    this.seq.reset(0)
    this.l.reset()
    this.l.setText('T_header_00', msg(0x1f40))
    this.latched = null
    this.cue = false
  }

  open(score: number, rank: number, records: number[], hasRecords: boolean) {
    if (!this.seq.settled(0)) return
    this.score = score
    this.rank = rank
    this.records = records.slice()
    this.hasRecords = hasRecords
    this.seq.change(1)
  }

  close() {
    if (this.seq.settled(4)) this.seq.change(5)
  }

  calc() {
    const l = this.l
    this.seq.run(
      (s) => {
        if (s === 1) {
          l.unbindAll()
          l.play('myRecord_00_in_00', { key: 'main' })
          NEW_REC.forEach((n, i) => l.setVisible(n, i === this.rank))
          l.setText('T_nMyRec_00', msg(0x2008 + GAME_MSG, plural(this.score), fullWidth(this.score)))
          this.records.forEach((r, i) => {
            l.setText(`T_nRecord_0${i}`, fullWidth(r))
            l.setText(`T_uRecord_0${i}`, msg(0x1fa4 + GAME_MSG, plural(r)))
          })
          this.snd.se('RP_COM_GAME_PARTY_SE_Win_Open_01')
          this.snd.se('RP_COM_GAME_PARTY_SE_LANK_01')
        } else if (s === 2) {
          l.play('myRecord_00_blink_00', { key: 'blink', bind: T_RECORD[this.rank] })
          this.cue = false
        } else if (s === 3) {
          l.unbindAll()
          l.play('myRecord_00_newRec_00', { key: 'main' })
          l.setText('T_newRec_00', msg(this.rank === 0 ? 0x1f45 : 0x1f44))
          l.play('myRecord_00_blink_00', { key: 'blink', bind: T_RECORD[this.rank] })
          this.cue = false
        } else if (s === 5) {
          l.unbindAll()
          l.play(this.rank !== -1 && this.hasRecords ? 'myRecord_00_outNewRec_00' : 'myRecord_00_outRec_00', { key: 'main' })
          this.snd.se('RP_COM_GAME_PARTY_SE_Win_Close_01')
        }
      },
      (s) => {
        if (s === 1 && l.done('main')) {
          if (this.rank !== -1) this.cue = true
          this.seq.change(this.rank !== -1 && this.hasRecords ? 3 : this.rank !== -1 ? 2 : 4)
        } else if (s === 2 && this.seq.timer >= 180) this.seq.change(4)
        else if (s === 3 && l.done('main')) this.seq.change(4)
        else if (s === 5 && l.done('main')) this.seq.change(6)
      },
    )
    // both halves are drawn, around the 3D layer
    l.setVisible('N_center_00', true)
    l.setVisible('N_center_01', true)
    if (this.seq.state !== 0 && this.seq.state !== 6) l.calc()
  }

  get visible() {
    return this.seq.state !== 0 && this.seq.state !== 6
  }

  latch() {
    this.latched = this.playerPos()
  }

  /** N_pPosition_00: where the avatar stands */
  playerPos() {
    return this.latched ?? panePos(this.l, 'N_pPosition_00')
  }

  /** DrawLayer1A (behind the avatar) / DrawLayer1C (in front) */
  drawLayer(ctx: CanvasRenderingContext2D, wideX: number, front: boolean) {
    if (!this.visible) return
    this.l.setVisible('N_center_00', !front)
    this.l.setVisible('N_center_01', front)
    this.l.draw(ctx, wideX)
  }
}

/** RPRankGetLyt states: 0 off, 1 in, 2 shown, 3 out, 4 done */
class RankGetLyt {
  l!: Lyt
  seq = new Seq()

  async load() {
    this.l = new Lyt(await loadLayout('ptRankGet_00'))
  }

  reset() {
    this.seq.reset(0)
    this.l.reset()
    this.l.setText('T_rankGet_00', msg(0x1f4a))
    this.l.setText('T_rankGet_01', msg(0x1f4a))
    this.l.setText('T_congrats_00', msg(0x1f4d))
    this.l.setText('T_congrats_01', msg(0x1f4d))
  }

  open(rank: number) {
    if (this.seq.state !== 0) return
    this.seq.change(1)
    this.l.setText('T_step_00', msg(0x1f4b, GAME_MSG))
    this.l.setText('T_rankGet_00', msg(0x1f4c, rank - 1))
    this.l.setText('T_rankGet_01', msg(0x1f4c, rank - 1))
  }

  close() {
    if (!this.seq.orNext(3) && !this.seq.orNext(4)) this.seq.change(3)
  }

  calc() {
    const l = this.l
    this.seq.run(
      (s) => {
        if (s === 1) {
          l.unbindAll()
          l.play('ptRankGet_00_in_00', { key: 'main' })
        } else if (s === 3) {
          l.unbindAll()
          l.play('ptRankGet_00_out_00', { key: 'main' })
        }
      },
      (s) => {
        if (s === 1 && l.done('main')) this.seq.change(2)
        else if (s === 3 && l.done('main')) this.seq.change(4)
      },
    )
    if (this.visible) l.calc()
  }

  get visible() {
    return this.seq.state !== 0 && this.seq.state !== 4
  }

  draw(ctx: CanvasRenderingContext2D, wideX: number) {
    if (this.visible) this.l.draw(ctx, wideX)
  }
}

/** RPMedalResult states: 0 off, 1 record, 2 medal, 3 save, 4 done */
export class MedalResult {
  seq = new Seq()
  record: RecordLyt
  rankGet = new RankGetLyt()
  score = 0
  rank = -1
  medal = 0
  hasRecords = false
  private records = [0, 0, 0, 0, 0]
  private newRecords = [0, 0, 0, 0, 0]
  /** mFade / mFadeDir: the Bcm_best_* spotlight behind the avatar */
  private fade = 0
  private fadeDir = 0
  private medalFrame = 0
  private pose: Pose = 'wait'
  private expr: Expression = 'normal'
  private poseT = 0
  private avatar = { x: 0, y: 0 }
  private medalPos = { x: 0, y: 0 }
  /** the medal saved after this run (RPCommon::GetSavedMedal) */
  savedMedal = 0

  /** onSaved(medal): the best medal after saving (the gold medal lifts the 20-mission cap) */
  constructor(
    private snd: SoundHost,
    private onSaved: (medal: number) => void,
  ) {
    this.record = new RecordLyt(snd)
    this.savedMedal = loadPlayerData().medal
  }

  async load() {
    await Promise.all([this.record.load(), this.rankGet.load()])
    this.reset()
  }

  reset() {
    this.seq.reset(0)
    const d = loadPlayerData()
    this.records = d.records.slice()
    this.savedMedal = d.medal
    this.fade = 0
    this.fadeDir = 0
    this.record.reset()
    this.rankGet.reset()
  }

  get state() {
    return this.seq.state
  }

  /** RPMedalResult::Start(score) */
  start(score: number) {
    if (this.seq.state !== 0) return
    this.score = score
    this.seq.change(1)
  }

  private rankFor(score: number) {
    for (let i = 0; i < 5; i++) if (score > this.records[i]) return i
    return -1
  }

  private saveResults() {
    const d = loadPlayerData()
    if (this.rank >= 0) d.records = this.newRecords.slice()
    if (this.medal > d.medal) d.medal = this.medal
    savePlayerData(d)
    this.savedMedal = d.medal
    this.onSaved(d.medal)
  }

  private setPose(p: Pose, e: Expression) {
    this.pose = p
    this.expr = e
    this.poseT = 0
  }

  calc(input: MenuInput) {
    this.seq.run(
      (s) => {
        if (s === 1) this.enterRecord()
        else if (s === 2) this.enterMedal()
      },
      (s) => {
        if (s === 1) this.calcRecord(input)
        else if (s === 2) this.calcMedal(input)
        else if (s === 3) this.seq.change(4)
      },
    )
    if (this.seq.state !== 0) {
      if (this.fadeDir) this.fade = Math.max(0, Math.min(1, this.fade + this.fadeDir / 15))
      this.poseT++
    }
  }

  private enterRecord() {
    this.rank = this.rankFor(this.score)
    this.newRecords = this.records.slice()
    if (this.rank >= 0) {
      for (let i = 4; i > this.rank; i--) this.newRecords[i] = this.newRecords[i - 1]
      this.newRecords[this.rank] = this.score
      this.hasRecords = this.records.slice(this.rank).some((r) => r !== 0)
    } else this.hasRecords = false
    this.record.open(this.score, this.rank, this.newRecords, this.hasRecords)
    // CalcNewMedal: the best medal above the saved one that the score reaches
    this.medal = 0
    for (let m = 4; m > this.savedMedal; m--)
      if (this.score >= TANKS_MEDALS[m - 1]) {
        this.medal = m
        break
      }
    this.setPose('wait', 'normal')
    if (this.medal === 0) this.saveResults()
  }

  private calcRecord(input: MenuInput) {
    const r = this.record
    r.calc()
    if (r.cue) {
      this.setPose(this.rank === 0 && this.hasRecords ? 'win' : 'draw', 'smile')
      this.fadeDir = 1
      this.snd.se('RP_COM_BGM_RENEW_RECORD')
    }
    if (r.seq.state !== 0) {
      const p = r.playerPos()
      this.avatar = { x: p.x + RECORD_OFFSET.x * WIDE_X, y: p.y + RECORD_OFFSET.y }
    }
    if (this.medal !== 0 && r.seq.state === 4) r.latch()
    if ((r.seq.state === 4 && input.ab) || (r.seq.state === 4 && r.seq.timer >= 300)) {
      r.close()
      if (this.medal === 0) this.fadeDir = -1
    }
    if (r.seq.state === 6) this.seq.change(this.medal !== 0 ? 2 : 3)
  }

  private enterMedal() {
    this.rankGet.open(this.medal)
    this.medalFrame = 0
    if (this.rank !== 0 || !this.hasRecords) this.setPose('win', 'smile')
    this.fadeDir = 1
    this.snd.fanfare(['RP_COM_BGM_GET_COPPER', 'RP_COM_BGM_GET_SILVER', 'RP_COM_BGM_GET_GOLD', 'RP_COM_BGM_GET_PLATINA'][this.medal - 1])
    this.saveResults()
  }

  private calcMedal(input: MenuInput) {
    const g = this.rankGet
    g.calc()
    if (g.seq.state !== 0) {
      const p = panePos(g.l, 'N_pPosition_00')
      this.avatar = { x: p.x + RECORD_OFFSET.x * WIDE_X, y: p.y + RECORD_OFFSET.y }
    }
    if ((g.seq.state === 2 && g.seq.timer >= 280 && input.ab) || (g.seq.state === 2 && g.seq.timer >= 580)) {
      g.close()
      this.fadeDir = -1
    }
    if (g.seq.state === 4) this.seq.change(3)
    const m = panePos(g.l, 'N_rPosition_00')
    this.medalPos = { x: m.x + MODEL_OFFSET.x * WIDE_X, y: m.y + MODEL_OFFSET.y }
    this.medalFrame++
  }

  /** the Mii avatar with the Bcm_best_spot light behind it */
  private drawAvatar(ctx: CanvasRenderingContext2D) {
    const { x, y } = this.avatar
    if (this.fade > 0) {
      ctx.save()
      ctx.globalAlpha = this.fade
      const g = ctx.createRadialGradient(x, y + 60, 10, x, y + 60, 120)
      g.addColorStop(0, 'rgba(255,250,200,0.65)')
      g.addColorStop(1, 'rgba(255,250,200,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.ellipse(x, y + 60, 120 * this.fade, 130, 0, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    drawMiiFigure(ctx, x, y, 150, 0, this.pose, this.poseT, 1, this.expr)
  }

  draw(ctx: CanvasRenderingContext2D, wideX: number) {
    if (this.seq.state === 0) return
    const avatar = this.record.visible || this.rankGet.visible
    this.record.drawLayer(ctx, wideX, false)
    if (avatar && this.seq.state !== 4) this.drawAvatar(ctx)
    if (this.seq.state === 2 && this.rankGet.visible) drawMedal(ctx, this.medalPos.x, this.medalPos.y, 62, this.medal, this.medalFrame)
    this.record.drawLayer(ctx, wideX, true)
    this.rankGet.draw(ctx, wideX)
  }
}

