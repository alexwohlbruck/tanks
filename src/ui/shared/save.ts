// What Wii Play keeps for Tanks: RPPartyPlayerData's best medal and five-entry "My Record" list
// (persisted in localStorage), and RPSceneInfo's 2P win tally (kept for the session only, as it
// is reset when the player count is chosen again).

const KEY = 'tanks.partyPlayerData'

export type PlayerData = {
  /** 0 none, 1 bronze, 2 silver, 3 gold, 4 platinum */
  medal: number
  /** best five scores, highest first */
  records: number[]
}

export function loadPlayerData(): PlayerData {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (d && Array.isArray(d.records)) {
      const records = [0, 1, 2, 3, 4].map((i) => Math.max(0, Math.floor(+d.records[i] || 0)))
      return { medal: Math.max(0, Math.min(4, Math.floor(+d.medal || 0))), records }
    }
  } catch {
    /* corrupt or unavailable storage: start fresh */
  }
  return { medal: 0, records: [0, 0, 0, 0, 0] }
}

export function savePlayerData(d: PlayerData) {
  try {
    localStorage.setItem(KEY, JSON.stringify(d))
  } catch {
    /* storage unavailable */
  }
}

/** RPSceneInfo: 2P wins per player (capped at 99) and the win streak (-3..3) */
export const vsSession = { wins: [0, 0], streak: 0 }

export function resetVsSession() {
  vsSession.wins = [0, 0]
  vsSession.streak = 0
}
