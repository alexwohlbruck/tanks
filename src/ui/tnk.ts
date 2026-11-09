// Port of the Tanks! 2D layout classes (decomp RPTnkLyt*.cpp): mission fade,
// HUD, start/clear/failed/complete messages, results, hit popups and the
// mission-1 hint banner, plus RPTnkLayoutManager's calc/draw gating.

import { fullWidth, loadLayout, loadMessages, Lyt, msg } from './lyt'

/** What the layouts read from the game (RPTnkGameManager / RPTnkGameStats / RPTnkTankManager). */
export type TnkInfo = {
  state(): number
  stage(): number
  lastStage(): number
  modeIdx(): 0 | 1
  lives(p: number): number
  addLives(p: number, n: number): void
  kills(p: number): number
  killsByType(p: number, i: number): number
  typeOrder(i: number): number
  typeNum(): number
  winner(): number
  enemyAlive(): number
  setStageReady(): void
  startBgm(): void
  startStageBgm(): void
  se(id: number): void
  /** screen position (layout units, 832x456 centred, y up) of a player tank's balloon point */
  playerScreen(p: number): { x: number; y: number } | null
  /** facing code angle (0/90/180/270) of a player for the balloon quadrant */
  playerAngle(p: number): number
}

const halfX = (n: number) => String(n)

// ---- RPTnkFade (RPTnkLyt_2.cpp) ----------------------------------------------

export class TnkFade {
  state = 0
  timer = 0
  fast = false
  bonus = false
  doneFlag = false
  constructor(public l: Lyt, private g: TnkInfo) {}

  reset() {
    this.state = 0
    this.timer = 0
    this.fast = this.bonus = this.doneFlag = false
    this.l.reset()
    this.l.setText('T_bonus_00', msg(0xb57))
    this.l.setText('T_bonus_01', msg(0xb57))
    this.l.play('tnkfade_in_00', { key: 'in' })
    this.l.setRate('in', 0)
    this.l.calc()
  }

  start(bonus: boolean, fast: boolean) {
    if (this.state !== 0) return
    this.fast = fast
    this.bonus = bonus
    this.timer = bonus ? 150 : 4
    const twoP = this.g.modeIdx() === 1
    this.l.setVisible('N_lifetnk_00', !twoP)
    this.l.setVisible('N_lifetnk_01', twoP)
    if (twoP) {
      this.l.setVisible('N_lifeNo_00', false)
      this.l.setVisible('T_lifeX_00', false)
      this.l.setVisible('T_lifeX_01', false)
    }
    this.l.unbindAll()
    this.l.play('tnkfade_in_00', { key: 'in', rate: fast ? 15 : 1 })
    this.l.play('tnkfade_loop_00', { key: 'loop', bind: 'P_loop_00', loop: true })
    this.doneFlag = false
    this.state = 1
  }

  private setMissionTexts() {
    this.timer = 140
    const stage = this.g.stage()
    const m = stage === this.g.lastStage() ? msg(0xb5d, 1) : msg(0xb5d, 0, fullWidth(stage + 1))
    this.l.setText('T_mission_00', m)
    this.l.setText('T_mission_01', m)
    const e = msg(0xb5e, 0, fullWidth(this.g.enemyAlive()))
    this.l.setText('T_enemy_00', e)
    this.l.setText('T_enemy_01', e)
    this.l.play('tnkfade_inMission_00', { key: 'inMission', bind: 'N_msg_00' })
    this.l.play('tnkfade_inEnemy_00', { key: 'inEnemy', bind: 'N_enemy_00' })
    this.g.startBgm()
    this.state = 5
  }

  private updateStates() {
    const l = this.l
    switch (this.state) {
      case 1:
        if (l.done('in')) {
          l.setRate('in', 1)
          if (!this.fast) this.g.setStageReady()
          l.play('tnkfade_inLife_00', { key: 'inLife', bind: 'N_life_00' })
          if (this.bonus) {
            l.play('tnkfade_inBonus_00', { key: 'inBonus', bind: 'N_msg_01' })
            this.g.se(0x21)
          }
          this.state = 2
        }
        break
      case 2:
        if (l.done('inLife') && (!this.bonus || l.done('inBonus'))) this.state = 3
        break
      case 4:
        if (l.done('outBonus')) this.setMissionTexts()
        break
      case 5:
        if (l.done('inMission') && l.done('inEnemy')) this.state = 6
        break
      case 7:
        if (l.done('outLife')) {
          l.play('tnkfade_out_00', { key: 'out', bind: 'N_loop_00' })
          // rebinding loop_00 to P_loop_00 without restart keeps it scrolling
          this.g.startStageBgm()
          this.state = 8
        }
        break
      case 8:
        if (l.done('out')) {
          this.state = 0
          this.doneFlag = true
        }
        break
    }
  }

  calc(hud: TnkHud) {
    const lives = fullWidth(this.g.lives(0))
    this.l.setText('T_lifeNo_00', lives)
    this.l.setText('T_lifeNo_01', lives)
    if (this.state === 3) {
      if (--this.timer === 0) {
        if (this.bonus) {
          this.l.play('tnkfade_outBonus_00', { key: 'outBonus', bind: 'N_msg_01' })
          this.state = 4
        } else this.setMissionTexts()
      } else if (this.bonus && this.timer === 120) {
        this.g.addLives(0, 1)
        if (this.g.modeIdx() === 1) this.g.addLives(1, 1)
        this.l.play('tnkfade_addLife_00', { key: 'addLife0', bind: 'N_life_00' })
        this.l.play('tnkfade_addLife_01', { key: 'addLife1', bind: 'N_msg_01' })
        this.g.se(0x22)
      }
    } else if (this.state === 6) {
      if (--this.timer === 0) {
        this.l.play('tnkfade_outLife_00', { key: 'outLife', bind: 'N_tnk_00' })
        hud.showBalloons = true
        this.state = 7
      }
    }
    this.updateStates()
    this.l.calc()
  }
}

// ---- RPTnkHud (RPTnkLyt_3.cpp) -------------------------------------------------

const BALLOON_P1 = ['N_balloon_00', 'N_balloon_03', 'N_balloon_01', 'N_balloon_02']
const BALLOON_P2 = ['N_balloon_04', 'N_balloon_07', 'N_balloon_05', 'N_balloon_06']

export class TnkHud {
  state = 1
  showBalloons = false
  constructor(public l: Lyt, private g: TnkInfo) {}

  reset() {
    this.state = 1
    this.showBalloons = false
    const l = this.l
    l.reset()
    l.setText('T_player_00', msg(0xb5f, 0))
    l.setText('T_player_01', msg(0xb5f, 1))
    for (let i = 0; i < 8; i++) {
      const t = msg(0xb60, i < 4 ? 0 : 1)
      l.setText(`T_balloon00_0${i}`, t)
      l.setText(`T_balloon01_0${i}`, t)
    }
    l.play('tnkUI_00_in_00', { key: 'in', bind: 'N_tnUIl_00' })
    l.setRate('in', 0)
  }

  calc() {
    const l = this.l
    const m = msg(0xb54, 0, fullWidth(this.g.stage() + 1))
    l.setText('T_mission_00', m)
    l.setText('T_mission_01', m)
    const e = fullWidth(this.g.enemyAlive())
    l.setText('T_enemyNo_00', e)
    l.setText('T_enemyNo_01', e)
    const s0 = fullWidth(this.g.kills(0))
    l.setText('T_score00_00', s0)
    l.setText('T_score01_00', s0)
    if (this.g.modeIdx() === 1) {
      const s1 = fullWidth(this.g.kills(1))
      l.setText('T_score00_01', s1)
      l.setText('T_score01_01', s1)
    }
    for (const n of [...BALLOON_P1, ...BALLOON_P2]) l.setVisible(n, false)
    if (this.showBalloons) {
      this.placeBalloon(0)
      if (this.g.modeIdx() === 1) this.placeBalloon(1)
    }
    if (this.state === 2 && l.done('in')) this.state = 0
    else if (this.state === 3 && l.done('out')) this.state = 1
    l.calc()
  }

  private placeBalloon(p: number) {
    const q = Math.floor(this.g.playerAngle(p) / 90) & 3
    const name = (p === 0 ? BALLOON_P1 : BALLOON_P2)[q]
    const s = this.g.playerScreen(p)
    if (!s) return
    this.l.setVisible(name, true)
    this.l.setTranslate(name, s.x, s.y)
  }

  playIn() {
    if (this.state === 0) return
    this.l.setVisible('N_score_00', true)
    this.l.setVisible('N_score_01', this.g.modeIdx() === 1)
    this.l.unbindAll()
    this.l.play('tnkUI_00_in_00', { key: 'in', bind: 'N_tnUIl_00' })
    this.state = 2
  }

  playOut() {
    this.l.unbindAll()
    this.l.play('tnkUI_00_out_00', { key: 'out' })
    this.state = 3
  }

  playScore(p: number) {
    if (this.state !== 0) return
    if (p === 0) this.l.play('tnkUI_00_point1P_00', { key: 'p1', bind: 'N_score_00' })
    else this.l.play('tnkUI_00_point2P_00', { key: 'p2', bind: 'N_score_01' })
  }
}

// ---- simple messages (RPTnkLyt_6/7/8/9.cpp) -------------------------------------

export class TnkStartMsg {
  constructor(public l: Lyt, private g: TnkInfo) {}
  reset() {
    this.l.reset()
    for (const n of ['T_start_00', 'T_start_01', 'T_start_02']) this.l.setText(n, msg(0xb5b))
    this.l.play('tnkMsg_01_start_00', { key: 'start' })
  }
  play() {
    this.l.play('tnkMsg_01_start_00', { key: 'start' })
    this.g.se(0x23)
  }
}

export class TnkClearMsg {
  state = 0
  timer = 120
  active = false
  constructor(public l: Lyt, private g: TnkInfo) {}
  reset() {
    this.state = 0
    this.timer = 120
    this.active = false
    const l = this.l
    l.reset()
    l.setText('T_clear_00', msg(0xb55))
    l.setText('T_clear_01', msg(0xb55))
    l.setText('T_total00_00', msg(0xb56))
    l.setText('T_total00_01', msg(0xb56))
    l.setText('T_player00_00', msg(0xb63))
    l.setText('T_player00_01', msg(0xb62, 0))
    l.setText('T_player00_02', msg(0xb62, 1))
    l.setVisible('N_clear_00', false)
    l.setVisible('N_total_00', false)
    l.setVisible('N_total_01', false)
  }
  calc() {
    if (this.state === 1 && this.l.done('inCleare')) this.showTotal()
    else if (this.state === 2 && this.l.done('inTotal')) this.state = 3
    if (this.state === 3 && --this.timer <= 0) this.active = true
    this.l.calc()
  }
  show() {
    if (this.state !== 0) return
    this.timer = 120
    this.active = false
    const l = this.l
    if (this.g.modeIdx() === 0) {
      const t = fullWidth(this.g.kills(0))
      l.setText('T_No00_00', t)
      l.setText('T_No01_00', t)
    } else {
      const a = fullWidth(this.g.kills(0))
      const b = fullWidth(this.g.kills(1))
      l.setText('T_No00_01', a)
      l.setText('T_No01_01', a)
      l.setText('T_No00_02', b)
      l.setText('T_No01_02', b)
    }
    l.setVisible('N_clear_00', true)
    l.setVisible('N_total_00', false)
    l.setVisible('N_total_01', false)
    l.unbind('inCleare')
    l.unbind('inTotal')
    l.play('tnkMsg_02_inCleare_00', { key: 'inCleare', bind: 'N_clear_00' })
    this.state = 1
  }
  private showTotal() {
    const l = this.l
    l.unbind('inCleare')
    l.unbind('inTotal')
    const one = this.g.modeIdx() === 0
    l.setVisible('N_clear_00', true)
    l.setVisible('N_total_00', one)
    l.setVisible('N_total_01', !one)
    l.play('tnkMsg_02_inTotal_00', { key: 'inTotal', bind: one ? 'N_total_00' : 'N_total_01' })
    this.g.se(0x24)
    this.state = 2
  }
  hide() {
    if (this.state !== 3) return
    this.l.setVisible('N_clear_00', false)
    this.l.setVisible('N_total_00', false)
    this.l.setVisible('N_total_01', false)
    this.state = 0
  }
}

/** RPTnkFailedMsg / RPTnkCompleteMsg: in, hold, out, then active */
export class TnkTimedMsg {
  state = 1
  timer = 0
  active = false
  constructor(public l: Lyt, private prefix: string, private hold: number, private texts: [string[], number, number]) {}
  reset() {
    this.state = 1
    this.timer = this.hold
    this.active = false
    this.l.reset()
    const [names, id, sub] = this.texts
    for (const n of names) this.l.setText(n, msg(id, sub))
    this.l.play(`${this.prefix}_in_00`, { key: 'in' })
  }
  calc() {
    if (this.state === 2) {
      if (this.l.done('in')) this.state = 0
    } else if (this.state === 3 && this.l.done('out')) {
      this.state = 1
      this.active = true
    }
    if ((this.state === 2 || this.state === 0) && --this.timer <= 0) {
      this.l.play(`${this.prefix}_out_00`, { key: 'out' })
      this.state = 3
    }
    this.l.calc()
  }
  show() {
    if (this.state === 0) return
    this.timer = this.hold
    this.active = false
    this.l.play(`${this.prefix}_in_00`, { key: 'in' })
    this.state = 2
  }
}

// ---- RPTnkHitPopup (RPTnkLyt_4.cpp) ---------------------------------------------

export class TnkHitPopup {
  active = false
  constructor(public l: Lyt) {}
  reset() {
    this.l.reset()
    for (const n of ['T_hit00_00', 'T_hit01_00', 'T_hit00_01', 'T_hit01_01']) this.l.setText(n, msg(0xb5c))
    this.active = false
  }
  calc(onDone: () => void) {
    if (this.active && this.l.done('hit')) {
      onDone()
      this.active = false
    }
    this.l.calc()
  }
  /** pos: screen position normalised to [-1, 1] (x right, y up) */
  start(pos: { x: number; y: number }, type: 0 | 1) {
    this.l.setVisible('N_hit_00', type === 0)
    this.l.setVisible('N_hit_01', type === 1)
    const x = Math.min(0.9, Math.max(-0.9, pos.x))
    const y = Math.min(0.9, Math.max(-0.9, pos.y))
    this.l.setTranslate('N_tnk_00', x * 304, y * 228)
    this.l.unbindAll()
    this.l.play('tnkHit_00_hit_00', { key: 'hit', bind: type === 0 ? 'N_hit_00' : 'N_hit_01' })
    this.active = true
  }
}

// ---- RPTnkExMsg (RPTnkLyt_5.cpp) --------------------------------------------------

export class TnkExMsg {
  state = 1
  constructor(public l: Lyt) {}
  reset() {
    this.state = 1
    this.l.reset()
    this.l.play('tnkEx_00_in_00', { key: 'a' })
  }
  calc() {
    this.l.calc()
  }
  show(m: number) {
    this.l.setText('T_ex_00', msg(0xb7c, m))
    if (this.state === 0 || this.state === 2) return
    this.l.unbindAll()
    this.l.play('tnkEx_00_in_00', { key: 'a' })
    this.state = 2
  }
  playOut() {
    if (this.state === 1 || this.state === 3) return
    this.l.unbindAll()
    this.l.play('tnkEx_00_out_00', { key: 'a' })
    this.state = 3
  }
  playOutAll() {
    this.l.unbindAll()
    // the BRLAN is flagged as a loop; RPTnkExMsg::Load sets every anim to EPlayMode_OneTime
    this.l.play('tnkEx_00_outAll_00', { key: 'a', loop: false })
    this.state = 3
  }
}

// ---- RPTnkResultLyt (RPTnkLyt_10.cpp) --------------------------------------------

const pad2 = (i: number) => String(i).padStart(2, '0')

export class TnkResult {
  state = 0
  timer = 0
  row = 0
  wait = 0
  waiting = false
  finished = false
  constructor(public l: Lyt, private g: TnkInfo) {}

  reset() {
    this.state = this.timer = this.row = this.wait = 0
    this.waiting = this.finished = false
    const l = this.l
    l.reset()
    l.setText('T_result00_00', msg(0xb67))
    l.setText('T_result00_01', msg(0xb67))
    l.setText('T_result01_00', msg(0xb68))
    l.setText('T_result01_01', msg(0xb68))
    l.setText('T_player00_00', msg(0xb65))
    l.setText('T_player01_00', msg(0xb64, 0))
    l.setText('T_player01_01', msg(0xb64, 1))
    l.setText('T_player00_01', msg(0xb66, 0))
    l.setText('T_player00_02', msg(0xb66, 1))
    this.hideAll()
  }

  private hideAll() {
    const l = this.l
    l.setVisible('N_list_00', false)
    l.setVisible('N_list_01', false)
    for (let i = 0; i < 9; i++) {
      l.setVisible(`N_r00_${pad2(i)}`, false)
      l.setVisible(`N_r01_${pad2(i)}`, false)
    }
    l.setVisible('N_totalAll_00', false)
    l.setVisible('N_totalAll_01', false)
  }

  start() {
    if (this.state !== 0) return
    this.timer = -20
    this.row = this.wait = 0
    this.waiting = this.finished = false
    this.hideAll()
    const l = this.l
    if (this.g.modeIdx() === 0) {
      for (let i = 0; i < 9; i++) l.setText(`T_No00_${pad2(i)}`, fullWidth(this.g.killsByType(0, i)))
      const t = halfX(this.g.kills(0))
      l.setText('T_score00_00', t)
      l.setText('T_score01_00', t)
      l.setVisible('N_list_00', true)
      l.play('tnkResult_00_inList_00', { key: 'inList', bind: 'N_list_00' })
    } else {
      for (let i = 0; i < 9; i++) {
        l.setText(`T_No01_${pad2(i)}`, fullWidth(this.g.killsByType(0, i)))
        l.setText(`T_No02_${pad2(i)}`, fullWidth(this.g.killsByType(1, i)))
      }
      const a = halfX(this.g.kills(0))
      const b = halfX(this.g.kills(1))
      l.setText('T_score00_01', a)
      l.setText('T_score01_01', a)
      l.setText('T_score00_02', b)
      l.setText('T_score01_02', b)
      l.setVisible('N_list_01', true)
      l.play('tnkResult_00_inList_00', { key: 'inList', bind: 'N_list_01' })
    }
    this.g.se(0)
    this.state = 1
  }

  private revealRow(type: number, row: number) {
    const two = this.g.modeIdx() === 1 ? 1 : 0
    const pane = `N_r0${two}_${pad2(type)}`
    const pos = this.l.pane(`N_p0${two}_${pad2(row)}`).translate[1]
    this.l.setVisible(pane, true)
    const p = this.l.pane(pane)
    this.l.setTranslate(pane, p.translate[0], pos)
    this.l.unbind('inList')
    this.l.unbind('inScore')
    this.l.play('tnkResult_00_inScore_00', { key: 'inScore', bind: pane, force: true })
    this.g.se(0x34 - row)
    this.state = 2
  }

  private sequence() {
    const l = this.l
    const two = this.g.modeIdx() === 1
    if (this.state === 1) {
      if (!this.waiting && l.done('inList')) {
        this.wait = 20
        this.waiting = true
      } else if (this.waiting && --this.wait <= 0) {
        this.row = 0
        this.revealRow(this.g.typeOrder(0), 0)
        this.waiting = false
      }
    }
    if (this.state === 2) {
      if (!this.waiting && l.done('inScore')) {
        this.wait = 20
        this.waiting = true
      } else if (this.waiting && --this.wait <= 0) {
        this.row++
        if (this.row === 9 || this.row >= this.g.typeNum()) {
          const tot = two ? 'N_totalAll_01' : 'N_totalAll_00'
          l.setVisible(tot, true)
          l.play('tnkResult_00_inTotal_00', { key: 'inTotal', bind: tot })
          this.g.se(0x2b)
          this.state = 3
        } else this.revealRow(this.g.typeOrder(this.row), this.row)
        this.waiting = false
      }
    }
    if (this.state === 3) {
      if (l.done('inTotal')) {
        if (!two) {
          l.unbindAll()
          l.play('tnkResult_00_win1P_00', { key: 'win', bind: 'N_total_00', loop: true })
        }
        this.state = 4
      }
    } else if (this.state === 5) {
      if (l.done('upTotal')) {
        const w = this.g.winner()
        if (w !== -1) {
          l.unbindAll()
          if (w === 0) l.play('tnkResult_00_win1P_00', { key: 'win', bind: 'N_total_01', loop: true })
          else l.play('tnkResult_00_win2P_00', { key: 'win', bind: 'N_total_02', loop: true })
        }
        this.state = 6
      }
    } else if (this.state === 6 && l.done('outList') && (two || l.done('outTotal'))) {
      this.state = 0
      this.finished = true
    }
  }

  calc(confirm: boolean) {
    this.sequence()
    if (this.state === 4) {
      this.timer++
      if (this.timer >= 20 && confirm) this.timer = 300
      if (this.timer >= 300) this.closeList()
    }
    this.l.calc()
  }

  private closeList() {
    const l = this.l
    if (this.g.modeIdx() === 0) {
      l.unbindAll()
      l.play('tnkResult_00_outList_00', { key: 'outList', bind: 'N_list_00' })
      l.play('tnkResult_00_outTotal_00', { key: 'outTotal', bind: 'N_totalAll_00' })
      l.play('tnkResult_00_win1P_00', { key: 'win', bind: 'N_total_00', loop: true })
      this.state = 6
    } else {
      l.play('tnkResult_00_outList_00', { key: 'outList', bind: 'N_list_01' })
      l.play('tnkResult_00_upTotal_00', { key: 'upTotal', bind: 'N_totalAll_01' })
      this.state = 5
    }
  }
}

// ---- RPTnkLayoutManager (RPTnkLyt.cpp) ---------------------------------------------

export class TnkLayouts {
  fade!: TnkFade
  hud!: TnkHud
  start!: TnkStartMsg
  clear!: TnkClearMsg
  failed!: TnkTimedMsg
  complete!: TnkTimedMsg
  result!: TnkResult
  ex!: TnkExMsg
  hits: TnkHitPopup[] = []
  hitNum = 0
  hitNext = 0

  constructor(private g: TnkInfo) {}

  async load() {
    await loadMessages()
    const names = ['tnkfade', 'tnkUI_00', 'tnkMsg_01', 'tnkMsg_02', 'tnkMsg_03', 'tnkMsg_04', 'tnkResult_00', 'tnkEx_00', 'tnkHit_00']
    const R = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await loadLayout(n)] as const)))
    this.fade = new TnkFade(new Lyt(R.tnkfade), this.g)
    this.hud = new TnkHud(new Lyt(R.tnkUI_00), this.g)
    this.start = new TnkStartMsg(new Lyt(R.tnkMsg_01), this.g)
    this.clear = new TnkClearMsg(new Lyt(R.tnkMsg_02), this.g)
    this.failed = new TnkTimedMsg(new Lyt(R.tnkMsg_03), 'tnkMsg_03', 120, [['T_failed_00', 'T_failed_01'], 0xb55, 1])
    this.complete = new TnkTimedMsg(new Lyt(R.tnkMsg_04), 'tnkMsg_04', 180, [['T_complete00_00', 'T_complete00_01', 'T_complete00_02', 'T_complete01_00'], 0xb58, 0])
    this.result = new TnkResult(new Lyt(R.tnkResult_00), this.g)
    this.ex = new TnkExMsg(new Lyt(R.tnkEx_00))
    this.hits = Array.from({ length: 16 }, () => new TnkHitPopup(new Lyt(R.tnkHit_00)))
    this.reset()
  }

  reset() {
    this.hud.reset()
    this.ex.reset()
    this.start.reset()
    this.clear.reset()
    this.failed.reset()
    this.complete.reset()
    for (const h of this.hits) h.reset()
    this.hitNum = this.hitNext = 0
    this.result.reset()
    this.fade.reset()
  }

  spawnHit(pos: { x: number; y: number }, type: 0 | 1) {
    if (this.g.modeIdx() === 0 || this.hitNum === 16) return
    this.hits[this.hitNext].start(pos, type)
    this.hitNum++
    this.hitNext = (this.hitNext + 1) % 16
  }

  private eachHit(f: (h: TnkHitPopup) => void) {
    let idx = (this.hitNext - this.hitNum + 16) % 16
    for (let n = this.hitNum; n > 0; n--) {
      f(this.hits[idx])
      idx = (idx + 1) % 16
    }
  }

  calc(confirm: boolean) {
    const s = this.g.state()
    this.hud.calc()
    if (this.g.stage() === 0) this.ex.calc()
    if (s === 4) this.start.l.calc()
    if (s === 6 || s === 7) this.clear.calc()
    if (s === 9) this.failed.calc()
    if (s === 8) this.complete.calc()
    this.eachHit((h) => h.calc(() => this.hitNum--))
    if (s >= 10 && s <= 12) this.result.calc(confirm)
    this.fade.calc(this.hud)
  }

  draw(ctx: CanvasRenderingContext2D, wideX: number) {
    const s = this.g.state()
    if (this.g.stage() === 0) this.ex.l.draw(ctx, wideX)
    this.hud.l.draw(ctx, wideX)
    this.eachHit((h) => h.l.draw(ctx, wideX))
    if (s === 4) this.start.l.draw(ctx, wideX)
    if (s === 6 || s === 7) this.clear.l.draw(ctx, wideX)
    if (s === 9) this.failed.l.draw(ctx, wideX)
    if (s === 8) this.complete.l.draw(ctx, wideX)
    if (s >= 10 && s <= 12) this.result.l.draw(ctx, wideX)
    this.fade.l.draw(ctx, wideX)
  }
}
