"""Tanks!-specific metadata: which BMG messages the game uses, which layout
text panes they fill, and what each layout is for.

Text bindings are the US strings the game writes into the txt1 panes at
runtime (the strings stored in the BRLYTs are editor placeholders, often in
another language). Message IDs are MID1 ids as hex. Bindings were checked
against the decomp (build/decomp, RPTnkLyt*.cpp and RPPartyCommon).
"""

# id -> usage. {num} = number tag (1A 06 00 0000), {player} = player/Mii name tag.
TANKS_MESSAGES = {
    "0x000b5400": "Mission {num} (HUD bottom bar, tnkUI_00 T_mission_*)",
    "0x000b5401": "Enemy forces: (unused by Tanks code)",
    "0x000b5500": "Mission cleared! banner (tnkMsg_02 T_clear_*)",
    "0x000b5501": "Mission failed! banner (tnkMsg_03 T_failed_*)",
    "0x000b5600": "Destroyed (tnkMsg_02 T_total00_*)",
    "0x000b5700": "Bonus Tank! (extra life banner, tnkfade T_bonus_*)",
    "0x000b5701": "Restock tanks",
    "0x000b5800": "Mission complete! (all 100 missions / game over success, tnkMsg_04)",
    "0x000b5900": "Results (unused; tnkResult uses 0x000b6700/0x000b6800)",
    "0x000b5901": "Total: (unused by Tanks code)",
    "0x000b5a00": "Mission: (label)",
    "0x000b5a01": "Tanks left: (remaining lives label)",
    "0x000b5b00": "Start! (tnkMsg_01 T_start_*)",
    "0x000b5c00": "Hit! (tnkHit_00, 2P friendly-fire / hit popup)",
    "0x000b5d00": "Mission {num} (mission intro banner, tnkfade T_mission_*)",
    "0x000b5d01": "Final Mission (banner for mission 100)",
    "0x000b5e00": "Enemy tanks: {num} (mission intro banner, tnkfade T_enemy_*)",
    "0x000b5f00": "P1 (tnkUI_00 T_player_00)", "0x000b5f01": "P2 (tnkUI_00 T_player_01)",
    "0x000b6000": "P1 (tnkUI_00 balloons 00-03)", "0x000b6001": "P2 (tnkUI_00 balloons 04-07)",
    "0x000b6100": "P1", "0x000b6101": "P2",
    "0x000b6200": "P1 (tnkMsg_02 2P)", "0x000b6201": "P2 (tnkMsg_02 2P)", "0x000b6300": "P1 (tnkMsg_02 1P)",
    "0x000b6400": "P1 (tnkResult 2P list)", "0x000b6401": "P2 (tnkResult 2P list)", "0x000b6500": "P1 (tnkResult 1P list)",
    "0x000b6600": "P1 (tnkResult 2P total)", "0x000b6601": "P2 (tnkResult 2P total)",
    "0x000b6700": "Results (tnkResult_00 1P header T_result00_*)",
    "0x000b6800": "Results (tnkResult_00 2P header T_result01_*)",
    "0x000b7c00": "Explanation: Move the tank with Nunchuk stick / +Control Pad (tnkEx_00)",
    "0x000b7c01": "Explanation: Aim at the enemy tank. (tnkEx_00)",
    "0x000b7c02": "Explanation: Fire with B. (tnkEx_00)",
    "0x000b7c03": "Explanation: Drop mines with B (sic; A in the controls text). (tnkEx_00)",
    "0x001b5809": "Game title 'Tanks!' (ptSelectGame_01 T_gameTitle_00)",
    "0x001b5909": "How-to-play / controls text, first-play (ptSelectGame_01 T_comment_00)",
    "0x001b5a09": "How-to-play / controls text, replay",
    "0x001b5b00": "A: Start (ptSelectGame_01 T_start_00)",
    "0x001b5c09": "Stage 9 (Tanks is the 9th stage in first-play order)",
    "0x001b6209": "Game title 'Tanks!' (small)",
    "0x001b8a09": "Point to aim (game-select control hint)",
    "0x001f4000": "My Record (myRecord_00 T_header_00)",
    "0x001f4100": "1", "0x001f4101": "2", "0x001f4102": "3", "0x001f4103": "4", "0x001f4104": "5",
    "0x001f4400": "New record!",
    "0x001f4500": "Personal best!",
    "0x001f4b09": "Stage 9 (ptRankGet_00 T_step_00)",
    "0x001f4c00": "Bronze Medal Earned", "0x001f4c01": "Silver Medal Earned",
    "0x001f4c02": "Gold Medal Earned", "0x001f4c03": "Platinum Medal Earned",
    "0x001f4d00": "Congratulations! (ptRankGet_00)",
    "0x001f5400": "{num} win (ptVsResult_00)", "0x001f5401": "{num} wins (ptVsResult_00)",
    "0x001f5500": "Play again (ptGOMenu_00)", "0x001f5501": "Play a different game (ptGOMenu_00)",
    "0x001f5600": "P1 (ptVsResult_00)", "0x001f5601": "P2 (ptVsResult_00)",
    "0x001fad00": "tank (record unit, singular)", "0x001fad01": "tanks (record unit, plural)",
    "0x00201100": "{num} tank (score)", "0x00201101": "{num} tanks (score)",
    "0x00207500": "Record: {num} tank", "0x00207501": "Record: {num} tanks",
    "0x00238300": "Pause (ptPauseText_00)", "0x00238301": "Pause (alt.)",
    "0x00271200": "Bronze Medal Earned!", "0x00271300": "Silver Medal Earned!",
    "0x00271400": "Gold Medal Earned!", "0x00271500": "Platinum Medal Earned!",
    "0x002b6500": "Bronze medal in Tanks! message", "0x002b6501": "Silver medal in Tanks! message",
    "0x002b6502": "Gold medal in Tanks! message", "0x002b6503": "Platinum medal in Tanks! message",
    "0x0002ee00": "Continue (pause_00 T_choicesF_00) [common_message]",
    "0x0002ef00": "Start over (pause_00 T_choicesS_00) [common_message]",
    "0x0002f000": "Quit (pause_00 T_choicesT_00) [common_message]",
    "0x00038400": "Safety advice (playAdvice_00) [common_message]",
    "0x00038500": "Why not take a break? [common_message]",
}


def fw(n):
    """RPSysStringUtility::GetStringFullSizeNumber: full-width digits (U+FF10..FF19), no padding."""
    return "".join(chr(0xFF10 + int(c)) for c in str(n))


def _b(msg=None, text=None, args=None, note=None):
    d = {}
    if msg:
        d["msg"] = msg
    if text is not None:
        d["text"] = text
    if args:
        d["args"] = args
    if note:
        d["note"] = note
    return d


def _pair(prefix_list, **kw):
    return {p: _b(**kw) for p in prefix_list}


# Taken from the decomp (build/decomp/src/Pack/RPParty/RPTnkScene/RPTnkLyt*.cpp and
# RPPartyCommon/*): setMessage(msg, id, sub, nArgs, ...) -> MID1 id (id << 8) | sub;
# setText(...) of a number -> "text" (sample values). Numbers are full-width unless noted.
TEXT_BINDINGS = {
    "tnkfade": {
        **_pair(["T_mission_00", "T_mission_01"], msg="0x000b5d00", args=[fw(1)],
                note="0x000b5d01 'Final Mission' on the last stage"),
        **_pair(["T_enemy_00", "T_enemy_01"], msg="0x000b5e00", args=[fw(4)], note="enemies alive"),
        **_pair(["T_bonus_00", "T_bonus_01"], msg="0x000b5700"),
        **_pair(["T_lifeNo_00", "T_lifeNo_01"], text=fw(3), note="lives of player 0, updated every frame"),
    },
    "tnkUI_00": {
        **_pair(["T_mission_00", "T_mission_01"], msg="0x000b5400", args=[fw(1)]),
        **_pair(["T_enemyNo_00", "T_enemyNo_01"], text=fw(4), note="enemies alive"),
        **_pair(["T_score00_00", "T_score01_00"], text=fw(5), note="P1 kills"),
        **_pair(["T_score00_01", "T_score01_01"], text=fw(3), note="P2 kills (2P only)"),
        "T_player_00": _b(msg="0x000b5f00"), "T_player_01": _b(msg="0x000b5f01"),
        **{"T_balloon0%d_0%d" % (a, i): _b(msg="0x000b6000" if i < 4 else "0x000b6001")
           for a in (0, 1) for i in range(8)},
    },
    "tnkMsg_01": _pair(["T_start_00", "T_start_01", "T_start_02"], msg="0x000b5b00"),
    "tnkMsg_02": {
        **_pair(["T_clear_00", "T_clear_01"], msg="0x000b5500"),
        **_pair(["T_total00_00", "T_total00_01"], msg="0x000b5600"),
        "T_player00_00": _b(msg="0x000b6300"),
        "T_player00_01": _b(msg="0x000b6200"), "T_player00_02": _b(msg="0x000b6201"),
        **_pair(["T_No00_00", "T_No01_00", "T_No00_01", "T_No01_01"], text=fw(12), note="P1 kills"),
        **_pair(["T_No00_02", "T_No01_02"], text=fw(7), note="P2 kills"),
    },
    "tnkMsg_03": _pair(["T_failed_00", "T_failed_01"], msg="0x000b5501"),
    "tnkMsg_04": _pair(["T_complete00_00", "T_complete00_01", "T_complete00_02", "T_complete01_00"], msg="0x000b5800"),
    "tnkResult_00": {
        **_pair(["T_result00_00", "T_result00_01"], msg="0x000b6700"),
        **_pair(["T_result01_00", "T_result01_01"], msg="0x000b6800"),
        "T_player00_00": _b(msg="0x000b6500"),
        "T_player01_00": _b(msg="0x000b6400"), "T_player01_01": _b(msg="0x000b6401"),
        "T_player00_01": _b(msg="0x000b6600"), "T_player00_02": _b(msg="0x000b6601"),
        **{"T_No00_0%d" % i: _b(text=fw(9 - i), note="1P kills of enemy type i") for i in range(9)},
        **{"T_No01_0%d" % i: _b(text=fw(i + 1), note="P1 kills of type i") for i in range(9)},
        **{"T_No02_0%d" % i: _b(text=fw(i), note="P2 kills of type i") for i in range(9)},
        **_pair(["T_score00_00", "T_score01_00"], text="45", note="half-width total"),
        **_pair(["T_score00_01", "T_score01_01"], text="45", note="half-width P1 total"),
        **_pair(["T_score00_02", "T_score01_02"], text="36", note="half-width P2 total"),
    },
    "tnkHit_00": _pair(["T_hit00_00", "T_hit01_00", "T_hit00_01", "T_hit01_01"], msg="0x000b5c00"),
    "tnkEx_00": {"T_ex_00": _b(msg="0x000b7c00", note="0x000b7c00..02 by guide step")},
    "pause_00": {
        "T_choicesF_00": _b(msg="0x0002ee00"),
        "T_choicesS_00": _b(msg="0x0002ef00"),
        "T_choicesT_00": _b(msg="0x0002f000"),
    },
    "ptPauseText_00": _pair(["T_pause_00", "T_pause_01"], msg="0x00238300"),
    "ptGOMenu_00": {"T_choicesF_00": _b(msg="0x001f5500"), "T_choicesS_00": _b(msg="0x001f5501")},
    "ptVsResult_00": {
        **_pair(["T_P1_00", "T_P1_01"], msg="0x001f5600"),
        **_pair(["T_P2_00", "T_P2_01"], msg="0x001f5601"),
        **_pair(["T_P1wins_00", "T_P1wins_01"], msg="0x001f5401", args=[fw(2)]),
        **_pair(["T_P2wins_00", "T_P2wins_01"], msg="0x001f5400", args=[fw(1)]),
    },
    "myRecord_00": {
        "T_header_00": _b(msg="0x001f4000"),
        **{"T_nRecord_0%d" % i: _b(text=fw(v)) for i, v in enumerate([100, 64, 37, 20, 8])},
        **{"T_uRecord_0%d" % i: _b(msg="0x001fad01", note="0x1FA4 + gameIdx(9), sub = plural") for i in range(5)},
        "T_nMyRec_00": _b(msg="0x00201101", args=[fw(37)], note="0x2008 + gameIdx(9), sub = plural"),
    },
    "ptRankGet_00": {
        "T_step_00": _b(msg="0x001f4b09"),
        **_pair(["T_rankGet_00", "T_rankGet_01"], msg="0x001f4c02", note="0x1F4C sub = medal rank 0-3"),
        **_pair(["T_congrats_00", "T_congrats_01"], msg="0x001f4d00"),
    },
    "rankComplete_00": {
        "T_rank_00": _b(msg="0x001b8002"),
        **_pair(["T_congrats_00", "T_congrats_01"], msg="0x001b8100"),
    },
    "ptSelectGame_01": {
        **_pair(["T_step_00", "T_step_01"], msg="0x001b5c09"),
        "T_gameTitle_00": _b(msg="0x001b5809"),
        "T_comment_00": _b(msg="0x001b5909", note="0x1B59 first play / 0x1B5A otherwise"),
        "T_start_00": _b(msg="0x001b5b00"),
    },
    "playAdvice_00": {"T_advice_00": _b(msg="0x00038400")},
}

LAYOUT_INFO = {
    "tnkfade": "Between-mission screen: scrolling tank-pattern backdrop (P_loop_00), 'Mission N' + "
               "'Enemy tanks: N' banner (N_msg_00), 'Bonus Tank!' banner (N_msg_01), remaining-lives "
               "counter with player tank icons in speech balloons (N_life_00).",
    "tnkUI_00": "In-game HUD: bottom bar 'Mission N' + enemy tank badge × count (N_tnUIl_00); "
                "2P score windows left/right (N_score_00/01); P1/P2 speech balloons pointing at tanks "
                "(N_balloon_00..07, four directions per player).",
    "tnkMsg_01": "'Start!' text burst at mission start (three stacked copies scale/fade).",
    "tnkMsg_02": "'Mission cleared!' banner, then 'Destroyed' running kill total (1P: N_total_00, 2P: N_total_01 with P1 - P2).",
    "tnkMsg_03": "'Mission failed!' banner.",
    "tnkMsg_04": "'Mission complete!' banner (shine sweep via T_complete00_01/02).",
    "tnkResult_00": "Results screen: notebook-paper list of destroyed enemy tanks per type "
                    "(N_r00_00..08 for 1P, N_r01_00..08 with two columns for 2P) and the total (N_totalAll_00/01).",
    "tnkHit_00": "'Hit!' popup at a hit tank's screen position, 2P mode only (pool of 16; N_hit_00 blue = type 0, N_hit_01 red = type 1).",
    "tnkEx_00": "Explanation banner (demo/tutorial hint text with the tank-pattern band).",
    "pause_00": "Shared pause menu: Continue / Start over / Quit buttons.",
    "ptPauseText_00": "Shared '+ Pause' corner hint.",
    "ptGOMenu_00": "Shared post-game menu: Play again / Play a different game.",
    "ptVsResult_00": "Shared 2P win tally (P1 n wins / P2 n wins).",
    "ptVsWinner_00": "Shared 2P winner layout (no panes with content; 3D model based).",
    "myRecord_00": "Shared My Record top-5 table and 'New record!' line after a game.",
    "ptRankGet_00": "Shared medal earned popup (Bronze/Silver/Gold/Platinum Medal Earned, Congratulations!).",
    "rankComplete_00": "Shared all-medals-completed popup.",
    "ptSelectGame_00": "Shared game select grid (Tanks! is game index 9).",
    "ptSelectGame_01": "Shared pre-game how-to-play screen: stage label, game title, screenshot, controls text, 'A: Start'.",
    "ptG8RemoteH_00": "Tanks! controller illustration (nunchuk + remote) animated on the how-to-play screen; "
                      "game index 8 = te_game_08 screenshot / sm_gameIcon_08.",
    "playAdvice_00": "Shared safety advice window shown before play.",
    "messageWindowB_00": "Shared message window (black).",
    "messageWindowW_00": "Shared message window (white).",
    "systemWindow_00": "Shared system dialog (Yes/No).",
    "playerSelect_00": "Shared player select.",
    "AButton": "Shared blinking A button prompt.",
}
