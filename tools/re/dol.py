"""DOL loader: section table + address<->bytes helpers."""
import struct, os
DOL = os.path.join(os.path.dirname(__file__), '../../build/rom/ext/sys/main.dol')

class Dol:
    def __init__(self, path=DOL):
        self.data = open(path, 'rb').read()
        h = self.data
        offs = struct.unpack('>18I', h[0:72]); addrs = struct.unpack('>18I', h[72:144]); sizes = struct.unpack('>18I', h[144:216])
        self.bss_addr, self.bss_size, self.entry = struct.unpack('>3I', h[216:228])
        self.sections = []  # (name, addr, size, fileoff)
        for i in range(18):
            if sizes[i]:
                name = ('T%d' % i) if i < 7 else ('D%d' % (i - 7))
                self.sections.append((name, addrs[i], sizes[i], offs[i]))
    def sec(self, addr):
        for s in self.sections:
            if s[1] <= addr < s[1] + s[2]: return s
        return None
    def read(self, addr, n):
        s = self.sec(addr)
        if not s: return None
        o = s[3] + addr - s[1]
        return self.data[o:o + n]
    def u32(self, a):
        b = self.read(a, 4); return struct.unpack('>I', b)[0] if b and len(b) == 4 else None
    def f32(self, a):
        b = self.read(a, 4); return struct.unpack('>f', b)[0] if b and len(b) == 4 else None
    def f64(self, a):
        b = self.read(a, 8); return struct.unpack('>d', b)[0] if b and len(b) == 8 else None
    def cstr(self, a, maxn=200):
        b = self.read(a, maxn)
        if not b: return None
        e = b.find(b'\0')
        if e <= 0: return None
        s = b[:e]
        try: t = s.decode('ascii')
        except: return None
        if all(32 <= c < 127 or c in (9, 10) for c in s): return t
        return None
    def is_text(self, a):
        s = self.sec(a); return s and s[0].startswith('T')

if __name__ == '__main__':
    d = Dol()
    for s in d.sections: print('%-4s %08x-%08x size %06x off %06x' % (s[0], s[1], s[1] + s[2], s[2], s[3]))
    print('bss %08x size %x entry %08x' % (d.bss_addr, d.bss_size, d.entry))
