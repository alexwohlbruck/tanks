"""BMG (MESGbmg1) message files -> JSON-able dict.

Text is UTF-16BE. Inline control tags start with U+001A:
    1A <u8 size> <u8 group> <u16 id> <params: size-6 bytes>
`size` counts the whole tag in bytes including the 0x001A unit.
The decoded string replaces each tag with a readable placeholder
"{tag:<group>:<id>:<hexparams>}" (or a friendlier name when known); the
raw tag bytes are kept in "tags" for exact reproduction.
"""
import struct

ENCODING = {1: "cp1252", 2: "utf-16-be", 3: "shift-jis", 4: "utf-8"}


def describe_tag(group, tid, params):
    """Readable placeholder for a tag.

    Observed in the game's US BMGs:
      group 0 id 0, no params  -> {num}     number substitution (printf %d)
      group 0 id 1, no params  -> {player}  player / Mii name substitution
      group 2 id N, u16 param  -> {win:N:pppp} message-window control codes
         (2:0 auto-advance/close delay in frames, e.g. 003c=60, 00b4=180;
          2:1 / 2:2 Yes-No style choice buttons (param 0000/0100 = default
          selection); 2:3 text alignment/indent mode) - meanings inferred.
    """
    hx = params.hex()
    if group == 0 and tid == 0 and not params:
        return "{num}"
    if group == 0 and tid == 1 and not params:
        return "{player}"
    if group == 2:
        return "{win:%d:%s}" % (tid, hx)
    return "{tag:%d:%d%s}" % (group, tid, (":" + hx) if hx else "")


def decode_text(raw):
    out = []
    tags = []
    i = 0
    n = len(raw)
    while i + 1 < n:
        u = (raw[i] << 8) | raw[i + 1]
        if u == 0:
            break
        if u == 0x1A:
            size = raw[i + 2]
            group = raw[i + 3]
            tid = (raw[i + 4] << 8) | raw[i + 5]
            params = raw[i + 6:i + size]
            ph = describe_tag(group, tid, params)
            tags.append({"pos": len("".join(out)), "group": group, "id": tid,
                         "params": params.hex(), "raw": raw[i:i + size].hex(), "placeholder": ph})
            out.append(ph)
            i += size
            continue
        # surrogate pairs
        if 0xD800 <= u < 0xDC00 and i + 3 < n:
            out.append(raw[i:i + 4].decode("utf-16-be", "replace"))
            i += 4
            continue
        out.append(chr(u))
        i += 2
    return "".join(out), tags


def read_bmg(data):
    assert data[:8] == b"MESGbmg1", "not a BMG"
    nsec, = struct.unpack_from(">I", data, 0xC)
    enc = data[0x10]
    o = 0x20
    inf = dat = mid = None
    for _ in range(nsec):
        magic = data[o:o + 4]
        size, = struct.unpack_from(">I", data, o + 4)
        if magic == b"INF1":
            inf = o
        elif magic == b"DAT1":
            dat = o
        elif magic == b"MID1":
            mid = o
        o += size
    n, esize = struct.unpack_from(">HH", data, inf + 8)
    group_id, = struct.unpack_from(">H", data, inf + 12)
    ids = None
    if mid is not None:
        mn, mfmt, minfo = struct.unpack_from(">HBB", data, mid + 8)
        ids = [struct.unpack_from(">I", data, mid + 16 + 4 * k)[0] for k in range(mn)]
    msgs = []
    for k in range(n):
        e = inf + 16 + esize * k
        toff, = struct.unpack_from(">I", data, e)
        attr = data[e + 4:e + esize]
        start = dat + 8 + toff
        # find terminator (u16 0) honouring tags
        j = start
        while True:
            u = (data[j] << 8) | data[j + 1]
            if u == 0:
                break
            j += data[j + 2] if u == 0x1A else 2
        raw = data[start:j]
        text, tags = decode_text(raw)
        m = {"index": k, "text": text, "attributes": attr.hex()}
        if ids is not None:
            m["id"] = ids[k]
            m["idHex"] = "0x%08x" % ids[k]
        if tags:
            m["tags"] = tags
        msgs.append(m)
    return {"encoding": ENCODING.get(enc, enc), "entrySize": esize, "groupId": group_id,
            "midFormat": None if mid is None else {"format": mfmt, "info": minfo},
            "messages": msgs}
