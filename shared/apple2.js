// A small Apple II+ (48K + language card) with a Disk II card and one or two drives.
// By default no Apple ROMs: the few monitor routines the software calls are done in JS (HLE) or tiny stubs.
// Games written in Applesoft BASIC need the real ROM, which a page can pass in (opts.rom).
(function (root) {
  'use strict';
  const CPU = root.CPU6502 || (typeof require !== 'undefined' && require('./cpu6502.js'));

  // ---------- Disk II ----------
  // .dsk files are in DOS 3.3 logical order; this maps physical sector -> file sector
  const PHYS2DOS = [0, 7, 14, 6, 13, 5, 12, 4, 11, 3, 10, 2, 9, 1, 8, 15];
  const WRITE_TABLE = [
    0x96, 0x97, 0x9a, 0x9b, 0x9d, 0x9e, 0x9f, 0xa6, 0xa7, 0xab, 0xac, 0xad, 0xae, 0xaf, 0xb2, 0xb3,
    0xb4, 0xb5, 0xb6, 0xb7, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xcb, 0xcd, 0xce, 0xcf, 0xd3,
    0xd6, 0xd7, 0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf, 0xe5, 0xe6, 0xe7, 0xe9, 0xea, 0xeb, 0xec,
    0xed, 0xee, 0xef, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf9, 0xfa, 0xfb, 0xfc, 0xfd, 0xfe, 0xff];
  const READ_TABLE = new Int16Array(256).fill(-1);
  WRITE_TABLE.forEach((v, i) => { READ_TABLE[v] = i; });

  function encode62(data) {
    const buf = new Uint8Array(342);
    for (let i = 0; i < 86; i++) {
      let v = 0;
      const a = data[i], b = data[i + 86], c = i + 172 < 256 ? data[i + 172] : 0;
      v |= ((a & 1) << 1) | ((a & 2) >> 1);
      v |= (((b & 1) << 1) | ((b & 2) >> 1)) << 2;
      v |= (((c & 1) << 1) | ((c & 2) >> 1)) << 4;
      buf[i] = v;
    }
    for (let i = 0; i < 256; i++) buf[86 + i] = data[i] >> 2;
    const out = new Uint8Array(343);
    let last = 0;
    for (let i = 0; i < 342; i++) { out[i] = WRITE_TABLE[buf[i] ^ last]; last = buf[i]; }
    out[342] = WRITE_TABLE[last];
    return out;
  }
  function decode62(nib) {
    const buf = new Uint8Array(342);
    let last = 0;
    for (let i = 0; i < 342; i++) { const v = READ_TABLE[nib[i]]; if (v < 0) return null; last ^= v; buf[i] = last; }
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      const aux = buf[i % 86] >> (2 * Math.floor(i / 86));
      data[i] = (buf[86 + i] << 2) | ((aux & 1) << 1) | ((aux & 2) >> 1);
    }
    return data;
  }
  const oddEven = v => [(v >> 1) | 0xaa, v | 0xaa];

  function nibblizeTrack(dsk, t) {
    const out = [];
    const ff = n => { for (let i = 0; i < n; i++) out.push(0xff); };
    ff(48);
    for (let p = 0; p < 16; p++) {
      const off = (t * 16 + PHYS2DOS[p]) * 256;
      out.push(0xd5, 0xaa, 0x96, ...oddEven(254), ...oddEven(t), ...oddEven(p), ...oddEven(254 ^ t ^ p), 0xde, 0xaa, 0xeb);
      ff(6);
      out.push(0xd5, 0xaa, 0xad, ...encode62(dsk.subarray(off, off + 256)), 0xde, 0xaa, 0xeb);
      ff(27);
    }
    return Uint8Array.from(out);
  }
  // read sectors back out of a (possibly rewritten) nibble track
  function denibblizeTrack(nib, dsk, t) {
    const n = nib.length, at = i => nib[i % n];
    let changed = false;
    for (let i = 0; i < n; i++) {
      if (at(i) !== 0xd5 || at(i + 1) !== 0xaa || at(i + 2) !== 0x96) continue;
      const dec = j => ((at(j) << 1) | 1) & at(j + 1);
      const trk = dec(i + 5), sec = dec(i + 7);
      if (trk !== t || sec > 15) continue;
      for (let j = i + 11; j < i + 11 + 60; j++) {
        if (at(j) === 0xd5 && at(j + 1) === 0xaa && at(j + 2) === 0xad) {
          const raw = new Uint8Array(343);
          for (let k = 0; k < 343; k++) raw[k] = at(j + 3 + k);
          const data = decode62(raw);
          if (data) {
            const off = (t * 16 + PHYS2DOS[sec]) * 256;
            for (let k = 0; k < 256; k++) if (dsk[off + k] !== data[k]) { dsk[off + k] = data[k]; changed = true; }
          }
          break;
        }
      }
    }
    return changed;
  }

  function Disk(dsk) {
    this.dsk = dsk; this.tracks = [];
    this.ht = 0; this.phases = 0; this.pos = 0; this.motor = false;
    this.q6 = false; this.q7 = false; this.latch = 0; this.dirty = false; this.onWrite = null;
  }
  Disk.prototype.track = function () {
    const t = Math.min(34, this.ht >> 1);
    if (!this.tracks[t]) this.tracks[t] = nibblizeTrack(this.dsk, t);
    return this.tracks[t];
  };
  Disk.prototype.flush = function () {
    if (!this.dirty) return;
    this.dirty = false;
    let changed = false;
    this.tracks.forEach((nib, t) => { if (nib && nib.written) { changed = denibblizeTrack(nib, this.dsk, t) || changed; nib.written = false; } });
    if (changed && this.onWrite) this.onWrite(this.dsk);
  };
  Disk.prototype.io = function (a, v, isWrite) {
    const s = a & 0x0f;
    if (s < 8) {
      const p = s >> 1, on = s & 1;
      if (on) {
        this.phases |= 1 << p;
        const d = (p - this.ht) & 3;
        const old = this.ht >> 1;
        if (d === 1) this.ht = Math.min(69, this.ht + 1);
        else if (d === 3) this.ht = Math.max(0, this.ht - 1);
        if ((this.ht >> 1) !== old) { this.flush(); this.pos = this.pos % this.track().length; }
      } else this.phases &= ~(1 << p);
      return 0;
    }
    switch (s) {
      case 0x8: this.motor = false; this.flush(); break;
      case 0x9: this.motor = true; break;
      case 0xa: case 0xb: break;
      case 0xc: this.q6 = false; break;
      case 0xd: this.q6 = true; break;
      case 0xe: this.q7 = false; break;
      case 0xf: this.q7 = true; break;
    }
    if (isWrite && (s & 1)) this.latch = v;
    if (s === 0xc) {
      const tr = this.track();
      if (this.q7) {
        // write mode: each shift puts the latched byte on the disk
        tr[this.pos] = this.latch; tr.written = true; this.dirty = true;
        this.pos = (this.pos + 1) % tr.length;
        return 0;
      }
      const b = tr[this.pos];
      // Sync bytes are 10 bits long on a real disk, so between two of them the latch briefly shows a
      // half-shifted value. DOS 3.3 relies on that to tell a spinning disk from a stopped one.
      if (b === 0xff && this.last === 0xff) { this.last = 0x7f; return 0x7f; }
      this.pos = (this.pos + 1) % tr.length;
      this.last = b;
      return b;
    }
    if (s === 0xe && this.q6 && !this.q7) return 0; // write protect sense: not protected
    return 0;
  };

  // The card drives two disks; Q6/Q7, the data latch and the motor belong to the card, the head to each drive.
  function DiskCard(drives) { this.drives = drives; this.cur = 0; }
  DiskCard.prototype.io = function (a, v, isWrite) {
    const s = a & 0x0f;
    if (s === 0xa || s === 0xb) {
      const next = s - 0xa;
      if (next !== this.cur && this.drives[next]) {
        const from = this.drives[this.cur], to = this.drives[next];
        to.q6 = from.q6; to.q7 = from.q7; to.latch = from.latch; to.motor = from.motor;
        from.motor = false; from.flush();
        this.cur = next;
      }
      return 0;
    }
    return this.drives[this.cur].io(a, v, isWrite);
  };

  // ProDOS disks: block n lives in these two DOS-order sectors of its track
  const BLOCK_HALVES = [[0, 14], [13, 12], [11, 10], [9, 8], [7, 6], [5, 4], [3, 2], [1, 15]];
  function readBlock(dsk, b) {
    const t = b >> 3, [h1, h2] = BLOCK_HALVES[b & 7], out = new Uint8Array(512);
    out.set(dsk.subarray((t * 16 + h1) * 256, (t * 16 + h1 + 1) * 256), 0);
    out.set(dsk.subarray((t * 16 + h2) * 256, (t * 16 + h2 + 1) * 256), 256);
    return out;
  }
  // find a file in the volume directory and return its contents (seedling or sapling files)
  function readProdosFile(dsk, wanted) {
    for (let b = 2; b; ) {
      const blk = readBlock(dsk, b);
      for (let i = 0; i < 13; i++) {
        const e = blk.subarray(4 + i * 39, 4 + (i + 1) * 39), st = e[0] >> 4, nl = e[0] & 15;
        if (st < 1 || st > 2) continue;
        const name = String.fromCharCode(...e.subarray(1, 1 + nl));
        if (name !== wanted) continue;
        const key = e[17] | e[18] << 8, eof = e[21] | e[22] << 8 | e[23] << 16;
        const out = new Uint8Array(Math.ceil(eof / 512) * 512);
        if (st === 1) out.set(readBlock(dsk, key).subarray(0, out.length));
        else {
          const idx = readBlock(dsk, key);
          for (let k = 0; k * 512 < out.length; k++) { const bn = idx[k] | idx[256 + k] << 8; if (bn) out.set(readBlock(dsk, bn), k * 512); }
        }
        return out;
      }
      b = blk[2] | blk[3] << 8;
    }
    return null;
  }

  // Disk II card ID bytes (the boot code itself is done in JS below)
  const SLOT6 = new Uint8Array(256);
  SLOT6[1] = 0x20; SLOT6[3] = 0x00; SLOT6[5] = 0x03; SLOT6[7] = 0x3c;

  // ---------- the machine ----------
  // opts.model: 'ii+' (48K + language card, the default) or 'iie' (128K: an Apple IIe with the extended 80-column card)
  // opts.rom / opts.diskRom: real ROM images ($D000-$FFFF and the Disk II card's $C600 page), for games written
  // in Applesoft BASIC, which lives in the ROM. Without them the machine runs on the stubs below.
  function Apple2(dskBytes, dsk2Bytes, opts) {
    this.iie = !!(opts && opts.model === 'iie');
    this.ram = new Uint8Array(0x10000);
    this.lcBank1 = new Uint8Array(0x1000); this.lcBank2 = new Uint8Array(0x1000); this.lcHigh = new Uint8Array(0x2000);
    // the IIe's second 64K, with its own language-card RAM
    this.aux = new Uint8Array(0x10000);
    this.auxBank1 = new Uint8Array(0x1000); this.auxBank2 = new Uint8Array(0x1000); this.auxHigh = new Uint8Array(0x2000);
    this.store80 = false; this.ramrd = false; this.ramwrt = false; this.altzp = false;
    this.intcx = false; this.slotc3 = false; this.col80 = false; this.altchar = false; this.an3 = true;
    this.lcRead = false; this.lcWrite = false; this.lcPre = false; this.lcBank = 2;
    this.rom = new Uint8Array(0x3000); // $D000-$FFFF stubs
    this.drives = [new Disk(dskBytes)];
    if (dsk2Bytes) this.drives.push(new Disk(dsk2Bytes));
    this.disk = this.drives[0];
    this.card = new DiskCard(this.drives);
    this.key = 0; this.text = true; this.mixed = false; this.page2 = false; this.hires = false;
    this.spk = []; this.halted = null; this.hle = {};
    this.cpu = new CPU(a => this.read(a), (a, v) => this.write(a, v));
    this.realRom = !!(opts && opts.rom);
    this.slot6 = SLOT6;
    if (this.realRom) { this.rom.set(opts.rom); this.slot6 = opts.diskRom; } else this.initRom();
  }
  const A = Apple2.prototype;

  // which 64K a main-memory address ($0200-$BFFF) reaches right now
  A.bank = function (a, isWrite) {
    if (this.store80 && ((a >= 0x400 && a < 0x800) || (this.hires && a >= 0x2000 && a < 0x4000))) return this.page2 ? this.aux : this.ram;
    return (isWrite ? this.ramwrt : this.ramrd) ? this.aux : this.ram;
  };
  A.lcMem = function (a) {
    if (a >= 0xe000) return this.altzp ? this.auxHigh : this.lcHigh;
    if (this.lcBank === 1) return this.altzp ? this.auxBank1 : this.lcBank1;
    return this.altzp ? this.auxBank2 : this.lcBank2;
  };
  A.read = function (a) {
    if (a < 0x200) return (this.altzp ? this.aux : this.ram)[a];
    if (a < 0xc000) return this.bank(a, false)[a];
    if (a < 0xc100) return this.io(a, 0, false);
    if (a < 0xd000) return (a >> 8) === 0xc6 && !this.intcx ? this.slot6[a & 0xff] : 0;
    if (this.lcRead) return this.lcMem(a)[a & (a >= 0xe000 ? 0x1fff : 0x0fff)];
    return this.rom[a - 0xd000];
  };
  A.write = function (a, v) {
    if (a < 0x200) { (this.altzp ? this.aux : this.ram)[a] = v; return; }
    if (a < 0xc000) { this.bank(a, true)[a] = v; return; }
    if (a < 0xc100) { this.io(a, v, true); return; }
    if (a < 0xd000) return;
    if (this.lcWrite) this.lcMem(a)[a & (a >= 0xe000 ? 0x1fff : 0x0fff)] = v;
  };
  A.io = function (a, v, isWrite) {
    const lo = a & 0xff;
    if (lo < 0x10) {
      if (isWrite && this.iie) {
        // IIe memory and video switches
        const on = !!(lo & 1);
        switch (lo >> 1) {
          case 0: this.store80 = on; break;
          case 1: this.ramrd = on; break;
          case 2: this.ramwrt = on; break;
          case 3: this.intcx = on; break;
          case 4: this.altzp = on; break;
          case 5: this.slotc3 = on; break;
          case 6: this.col80 = on; break;
          case 7: this.altchar = on; break;
        }
        return 0;
      }
      // remember which code is reading the keyboard, and who called it (the JSR under the top of the stack);
      // Applesoft's check for Ctrl-C between statements isn't a wait for input, so it doesn't count
      if (!isWrite && !(this.realRom && this.cpu.pc === 0xd85b)) {
        this.kbdPC = this.cpu.pc;
        const sp = this.cpu.s;
        this.kbdCaller = ((this.read(0x100 | ((sp + 2) & 0xff)) << 8 | this.read(0x100 | ((sp + 1) & 0xff))) - 2) & 0xffff;
      }
      return this.key;
    }
    if (lo === 0x10) { const k = this.key; this.key &= 0x7f; return k; }
    if (lo < 0x20) {
      if (!this.iie) { this.key &= 0x7f; return 0; }
      // IIe status: bit 7 is the switch, the rest is the last key
      const k = this.key & 0x7f;
      const vbl = (this.cpu.cycles % 17030) >= 12480;
      const f = [0, this.lcBank === 2, this.lcRead, this.ramrd, this.ramwrt, this.intcx, this.altzp, this.slotc3,
        this.store80, !vbl, this.text, this.mixed, this.page2, this.hires, this.altchar, this.col80][lo & 15];
      return (f ? 0x80 : 0) | k;
    }
    if (lo >= 0x30 && lo < 0x40) { this.spk.push(this.cpu.cycles); return 0; }
    switch (lo) {
      case 0x50: this.text = false; return 0;
      case 0x51: this.text = true; return 0;
      case 0x52: this.mixed = false; return 0;
      case 0x53: this.mixed = true; return 0;
      case 0x54: this.page2 = false; return 0;
      case 0x55: this.page2 = true; return 0;
      case 0x56: this.hires = false; return 0;
      case 0x57: this.hires = true; return 0;
      case 0x5e: this.an3 = false; return 0;
      case 0x5f: this.an3 = true; return 0;
    }
    if (lo >= 0x70 && lo < 0x80) { this.paddleStart = this.cpu.cycles; return 0; }   // start the paddle timers
    if (lo >= 0x64 && lo < 0x68) {
      // joystick/paddles: no stick attached, so each axis reads as centered (timer runs ~128 * 11 cycles)
      return this.cpu.cycles - this.paddleStart < 128 * 11 ? 0x80 : 0;
    }
    if (lo >= 0x60 && lo < 0x70) return lo === 0x61 ? this.button0 : lo === 0x62 ? this.button1 : 0; // buttons
    if (lo >= 0x80 && lo < 0x90) {
      // language card
      const s = lo & 0x0f;
      this.lcBank = s & 8 ? 1 : 2;
      this.lcRead = (s & 3) === 0 || (s & 3) === 3;
      if (s & 1) { if (!isWrite && this.lcPre) this.lcWrite = true; this.lcPre = !isWrite; }
      else { this.lcWrite = false; this.lcPre = false; }
      return 0;
    }
    if (lo >= 0xe0) return this.card.io(lo, v, isWrite);
    return 0;
  };
  A.button0 = 0; A.button1 = 0; A.kbdPC = 0; A.kbdCaller = 0; A.paddleStart = -1e9;

  A.pressKey = function (c) { this.key = (c & 0x7f) | 0x80; };

  // ---------- ROM stand-ins ----------
  const TEXT_ROW = r => 0x400 + (r & 7) * 0x80 + (r >> 3) * 0x28;
  A.initRom = function () {
    const R = this.rom, put = (addr, bytes) => bytes.forEach((b, i) => { R[addr - 0xd000 + i] = b; });
    // Applesoft is "present" so DOS is happy; we take over when it jumps in
    put(0xe000, [0x4c, 0x28, 0xf1]);
    R[0xfbb3 - 0xd000] = 0xea; R[0xfb1e - 0xd000] = 0xad;         // II+ with Autostart ROM
    if (this.iie) { R[0xfbb3 - 0xd000] = 0x06; R[0xfbc0 - 0xd000] = 0xea; }   // unenhanced IIe (still a 6502)
    put(0xfb09, [...'APPLE ]['].map(ch => ch.charCodeAt(0) | 0x80));   // the ID text ProDOS looks for
    put(0xfffa, [0xfb, 0x03, 0x62, 0xfa, 0x40, 0xfa]); // NMI, RESET, IRQ
    put(0xfded, [0x6c, 0x36, 0x00]);                   // COUT: JMP (CSW)
    put(0xfd0c, [0x6c, 0x38, 0x00]);                   // RDKEY: JMP (KSW)
    // PRBYTE / PRHEX
    put(0xfdda, [0x48, 0x4a, 0x4a, 0x4a, 0x4a, 0x20, 0xe5, 0xfd, 0x68, 0x29, 0x0f, 0x09, 0xb0, 0xc9, 0xba, 0x90, 0x02, 0x69, 0x06, 0x6c, 0x36, 0x00]);
    R[0xfde3 - 0xd000] = 0x29; // PRHEX: AND #$0F then fall into the ORA at $FDE5
    put(0xfde3, [0x29, 0x0f]);
    put(0xfde5, [0x09, 0xb0, 0xc9, 0xba, 0x90, 0x02, 0x69, 0x06, 0x6c, 0x36, 0x00]);
    // CROUT: LDA #$8D, JMP (CSW)
    put(0xfd8e, [0xa9, 0x8d, 0x6c, 0x36, 0x00]);
    put(0xff58, [0x60]);                               // IORTS
    put(0xfe1f, [0x60]);                               // IDROUTINE: plain RTS (only a IIgs clears carry)
    // PRNTYX / PRNTAX / PRNTX, PRBLNK / PRBL2 (print X blanks)
    put(0xf940, [0x98, 0x20, 0xda, 0xfd, 0x8a, 0x4c, 0xda, 0xfd]);
    put(0xf948, [0xa2, 0x03, 0xa9, 0xa0, 0x20, 0xed, 0xfd, 0xca, 0xd0, 0xf8, 0x60]);
    // CROUT1: clear to end of line, then CROUT
    put(0xfd8b, [0x20, 0x9c, 0xfc]);
    // IRQ handler: JMP ($03FE)
    put(0xfa40, [0x6c, 0xfe, 0x03]);
    const H = this.hle, m = this;
    const rts = c => { const lo = c.pop(), hi = c.pop(); c.pc = (((hi << 8) | lo) + 1) & 0xffff; };
    const ram = m.ram;
    const bascalc = r => { const b = TEXT_ROW(r) + ram[0x20]; ram[0x28] = b & 0xff; ram[0x29] = b >> 8; };
    const vtab = () => bascalc(ram[0x25]);
    const clreol = (from) => { for (let x = from; x < ram[0x21]; x++) ram[TEXT_ROW(ram[0x25]) + ram[0x20] + x] = 0xa0; };
    const scroll = () => {
      const l = ram[0x20], w = ram[0x21], t = ram[0x22], b = ram[0x23];
      for (let r = t; r < b - 1; r++) for (let x = 0; x < w; x++) ram[TEXT_ROW(r) + l + x] = ram[TEXT_ROW(r + 1) + l + x];
      for (let x = 0; x < w; x++) ram[TEXT_ROW(b - 1) + l + x] = 0xa0;
    };
    const lf = () => { ram[0x25]++; if (ram[0x25] >= ram[0x23]) { ram[0x25] = ram[0x23] - 1; scroll(); } vtab(); };
    const cr = () => { ram[0x24] = 0; lf(); };
    const home = () => {
      for (let r = ram[0x22]; r < ram[0x23]; r++) for (let x = 0; x < ram[0x21]; x++) ram[TEXT_ROW(r) + ram[0x20] + x] = 0xa0;
      ram[0x24] = 0; ram[0x25] = ram[0x22]; vtab();
    };
    const cout1 = c => {
      const a = c.a;
      if (a >= 0xa0) {
        ram[TEXT_ROW(ram[0x25]) + ram[0x20] + ram[0x24]] = a & ram[0x32];
        ram[0x24]++;
        if (ram[0x24] >= ram[0x21]) cr();
      } else if (a === 0x8d) cr();
      else if (a === 0x8a) lf();
      else if (a === 0x88) { if (ram[0x24] > 0) ram[0x24]--; else { ram[0x24] = ram[0x21] - 1; if (ram[0x25] > ram[0x22]) { ram[0x25]--; vtab(); } } }
      else if (a === 0x87) m.beep();
    };
    H[0xfdf0] = c => { cout1(c); rts(c); };                           // COUT1
    H[0xfdf6] = c => { cout1(c); rts(c); };
    H[0xfc58] = c => { home(); rts(c); };                              // HOME
    H[0xfc22] = c => { vtab(); rts(c); };                              // VTAB
    H[0xfc24] = c => { bascalc(c.a); rts(c); };                        // VTABZ
    H[0xfbc1] = c => { bascalc(c.a); rts(c); };                        // BASCALC
    H[0xfc42] = c => { clreol(ram[0x24]); for (let r = ram[0x25] + 1; r < ram[0x23]; r++) for (let x = 0; x < ram[0x21]; x++) ram[TEXT_ROW(r) + ram[0x20] + x] = 0xa0; rts(c); }; // CLREOP
    H[0xfc9c] = c => { clreol(ram[0x24]); rts(c); };                  // CLREOL
    H[0xfc9e] = c => { clreol(c.y); rts(c); };                        // CLEOLZ
    H[0xfc62] = c => { cr(); rts(c); };                               // CR
    H[0xfc66] = c => { lf(); rts(c); };                               // LF
    H[0xfc70] = c => { scroll(); rts(c); };                           // SCROLL
    H[0xfe93] = c => { ram[0x36] = 0xf0; ram[0x37] = 0xfd; rts(c); }; // SETVID
    H[0xfe89] = c => { ram[0x38] = 0x1b; ram[0x39] = 0xfd; rts(c); }; // SETKBD
    H[0xfe84] = c => { ram[0x32] = 0xff; rts(c); };                   // SETNORM
    H[0xfe80] = c => { ram[0x32] = 0x3f; rts(c); };                   // SETINV
    H[0xfb39] = c => { m.text = true; m.page2 = false; ram[0x20] = 0; ram[0x21] = 40; ram[0x22] = 0; ram[0x23] = 24; ram[0x25] = 23; vtab(); rts(c); }; // SETTXT
    H[0xfb2f] = c => { m.text = true; m.mixed = false; m.page2 = false; m.hires = false; ram[0x20] = 0; ram[0x21] = 40; ram[0x22] = 0; ram[0x23] = 24; rts(c); }; // INIT
    H[0xfb40] = c => { m.text = false; m.mixed = true; m.hires = false; rts(c); }; // SETGR
    H[0xfb5b] = c => { ram[0x25] = c.a; vtab(); rts(c); };           // TABV
    H[0xfca8] = c => { const a = c.a || 256; c.cycles += Math.floor((26 + 27 * a + 5 * a * a) / 2); c.a = 0; rts(c); }; // WAIT
    H[0xff3a] = c => { m.beep(); rts(c); };                           // BELL
    H[0xfbdd] = c => { m.beep(); rts(c); };                           // BELL1
    H[0xfe2c] = c => {                                                 // MOVE
      for (;;) {
        const s = ram[0x3c] | ram[0x3d] << 8, d = ram[0x42] | ram[0x43] << 8;
        m.write(d, m.read(s));
        const e = ram[0x3e] | ram[0x3f] << 8;
        const s1 = (s + 1) & 0xffff, d1 = (d + 1) & 0xffff;
        ram[0x42] = d1 & 0xff; ram[0x43] = d1 >> 8;
        if (s >= e) { ram[0x3c] = s1 & 0xff; ram[0x3d] = s1 >> 8; break; }
        ram[0x3c] = s1 & 0xff; ram[0x3d] = s1 >> 8;
      }
      rts(c);
    };
    // KEYIN: wait for a key (stay on this instruction until one arrives)
    H[0xfd1b] = c => { if (m.key & 0x80) { c.a = m.key; m.key &= 0x7f; rts(c); } else { c.cycles += 200; m.idle = true; } };
    H[0xfd35] = c => { c.pc = 0xfd0c; };                              // RDCHAR -> RDKEY
    H[0xfa62] = c => { m.halt('reset'); };
    H[0xfb1e] = c => { c.y = 128; c.cycles += 1400; rts(c); };      // PREAD: no joystick, stick centered
    // IIe 80-column firmware helpers
    H[0xc311] = c => {                                                 // AUXMOVE: carry set main->aux, clear aux->main
      const rd = a => m.read(a);   // parameters are read through the memory currently switched in, as the ROM would
      let src = rd(0x3c) | rd(0x3d) << 8; const end = rd(0x3e) | rd(0x3f) << 8; let dst = rd(0x42) | rd(0x43) << 8;
      const from = (c.p & 1) ? m.ram : m.aux, to = (c.p & 1) ? m.aux : m.ram;
      for (;;) { to[dst] = from[src]; if (src >= end) break; src = (src + 1) & 0xffff; dst = (dst + 1) & 0xffff; }
      rts(c);
    };
    H[0xc314] = c => {                                                 // XFER: jump to ($3ED) in main or aux memory
      const target = m.read(0x3ed) | m.read(0x3ee) << 8;
      m.ramrd = m.ramwrt = !!(c.p & 1);
      m.altzp = !!(c.p & 0x40);
      c.pc = target;
    };
    // boot ROM for slot 6
    H[0xc600] = c => {
      m.disk.motor = true; m.disk.ht = 0; m.card.cur = 0;
      // A ProDOS disk's boot block copies code out of the card's ROM, which we don't have.
      // Do its job instead: load the PRODOS file to $2000 and start it, as the boot block would.
      const d = m.disk.dsk;
      if (d[0] === 0x01 && d[1] === 0x38 && d[2] === 0xb0 && d[3] === 0x03) {
        const pro = readProdosFile(d, 'PRODOS');
        if (pro) {
          m.ram.set(pro.subarray(0, Math.min(pro.length, 0xbf00 - 0x2000)), 0x2000);
          ram[0x43] = 0x60; ram[0x2b] = 0x60;   // booted from slot 6, drive 1
          c.x = 0x60; c.pc = 0x2000;
          return;
        }
      }
      ram[0x26] = 0; ram[0x27] = 8; ram[0x3d] = 0; ram[0x41] = 0; ram[0x2b] = 0x60;
      c.x = 0x60; c.pc = 0xc65c;
    };
    H[0xc65c] = c => {
      do {
        const t = m.disk.ht >> 1, s = ram[0x3d] & 15, off = (t * 16 + PHYS2DOS[s]) * 256, dst = ram[0x27] << 8 | ram[0x26];
        for (let i = 0; i < 256; i++) ram[(dst + i) & 0xffff] = m.disk.dsk[off + i];
        ram[0x27]++; ram[0x3d]++;
      } while (ram[0x3d] < ram[0x800]);
      c.x = ram[0x2b]; c.a = ram[0x3d]; c.pc = 0x801;   // like the real ROM: A holds the next sector number (ProDOS's loader checks it)
    };
  };

  A.beep = function () {
    const t = this.cpu.cycles;
    for (let i = 0; i < 192; i++) this.spk.push(t + i * 512);  // ~1kHz for 0.1s
  };
  A.halt = function (why) { this.halted = why; };

  // run for n cycles
  A.run = function (n) {
    const c = this.cpu, end = c.cycles + n, H = this.hle;
    this.idle = false;
    while (c.cycles < end && !this.halted) {
      const pc = c.pc;
      if (pc >= 0xc100 && !this.realRom) {
        const h = H[pc];
        if (pc < 0xd000 || !this.lcRead) {
          if (h) { h(c); if (this.idle) break; continue; }
          if (pc < 0xd000 || this.rom[pc - 0xd000] === 0) { this.halt('rom $' + pc.toString(16)); break; }
        } else if (h && this.read(pc) === this.rom[pc - 0xd000]) {
          // the monitor was copied into language-card RAM; run our routine in place of the copy
          h(c); if (this.idle) break; continue;
        } else if (pc >= 0xf800 && this.read(pc) === 0 && this.rom[pc - 0xd000] === 0) {
          // a monitor routine we don't have, reached through the copy
          this.halt('rom $' + pc.toString(16)); break;
        }
      }
      c.step();
      if (c.bad !== undefined) { this.halt('bad opcode $' + c.bad.toString(16) + ' at $' + c.pc.toString(16)); break; }
    }
  };
  // power-on: what the monitor's RESET does before the Autostart ROM boots slot 6
  A.boot = function () {
    if (this.realRom) { this.cpu.pc = this.rom[0x2ffc] | this.rom[0x2ffd] << 8; this.cpu.s = 0xff; return; }   // the real RESET
    const r = this.ram;
    r[0x20] = 0; r[0x21] = 40; r[0x22] = 0; r[0x23] = 24; r[0x32] = 0xff;
    r[0x36] = 0xf0; r[0x37] = 0xfd; r[0x38] = 0x1b; r[0x39] = 0xfd;
    for (let a = 0x400; a < 0x800; a++) r[a] = 0xa0;
    r[0x24] = 0; r[0x25] = 0; r[0x28] = 0; r[0x29] = 4;
    r[0x3f2] = 0x62; r[0x3f3] = 0xfa; r[0x3f4] = 0xfa ^ 0xa5;   // soft-entry vector (points at RESET)
    this.text = true; this.mixed = false; this.page2 = false; this.hires = false;
    this.cpu.pc = 0xc600; this.cpu.s = 0xff;
  };

  // ---------- video ----------
  const PAL = { k: [0, 0, 0], w: [255, 255, 255], g: [20, 245, 60], v: [255, 68, 253], o: [255, 106, 60], b: [20, 207, 253] };
  // render the current screen into an RGBA buffer (280x192); font is the 7x8 bitmap starting at space
  A.render = function (out, font, flashOn) {
    const ram = this.ram;
    const bits = new Uint8Array(282), pals = new Uint8Array(282);
    const put = (x, y, q) => { const o = (y * 280 + x) * 4; out[o] = q[0]; out[o + 1] = q[1]; out[o + 2] = q[2]; out[o + 3] = 255; };
    const textFrom = this.text ? 0 : this.mixed ? 20 : 24;
    if (!this.text) {
      if (this.hires) {
        const base = this.page2 && !this.store80 ? 0x4000 : 0x2000;   // with 80STORE on, PAGE2 picks memory, not the shown page
        const colAt = (x, p) => (x & 1) === 0 ? (p ? 'b' : 'v') : (p ? 'o' : 'g');
        for (let y = 0; y < textFrom * 8; y++) {
          const row = base + (y & 7) * 0x400 + ((y >> 3) & 7) * 0x80 + (y >> 6) * 0x28;
          for (let c = 0; c < 40; c++) {
            const b = ram[row + c], p = b >> 7;
            for (let i = 0; i < 7; i++) { bits[c * 7 + i + 1] = (b >> i) & 1; pals[c * 7 + i + 1] = p; }
          }
          for (let x = 0; x < 280; x++) {
            const on = bits[x + 1], l = bits[x], r = bits[x + 2];
            let col;
            if (on) col = (l || r) ? 'w' : colAt(x, pals[x + 1]);
            else col = (l && r) ? colAt(x - 1, pals[x]) : 'k';
            put(x, y, PAL[col]);
          }
        }
      } else {
        // lo-res: 16 colors
        const LORES = [[0, 0, 0], [227, 30, 96], [96, 78, 189], [255, 68, 253], [0, 163, 96], [156, 156, 156], [20, 207, 253], [208, 195, 255], [96, 114, 3], [255, 106, 60], [156, 156, 156], [255, 160, 208], [20, 245, 60], [208, 221, 141], [114, 255, 208], [255, 255, 255]];
        const base = this.page2 && !this.store80 ? 0x800 : 0x400;
        for (let r = 0; r < textFrom; r++) for (let c = 0; c < 40; c++) {
          const b = ram[base + TEXT_ROW(r) - 0x400 + c];
          for (let h = 0; h < 2; h++) { const q = LORES[h ? b >> 4 : b & 15]; for (let yy = 0; yy < 4; yy++) for (let xx = 0; xx < 7; xx++) put(c * 7 + xx, r * 8 + h * 4 + yy, q); }
        }
      }
    }
    const tbase = this.page2 && !this.store80 ? 0x800 : 0x400;
    for (let r = textFrom; r < 24; r++) for (let c = 0; c < 40; c++) {
      const code = ram[tbase + TEXT_ROW(r) - 0x400 + c];
      let ch, inv = false;
      if (code >= 0x80) ch = code & 0x7f; else { ch = code & 0x3f; if (ch < 0x20) ch += 0x40; inv = code < 0x40 || flashOn; }
      if (ch >= 0x60 && code < 0xe0) ch -= 0x20;
      const gi = (ch - 32) * 8;
      for (let y = 0; y < 8; y++) {
        const b = gi >= 0 ? font[gi + y] : 0;
        for (let x = 0; x < 7; x++) { const on = ((b >> x) & 1) ^ (inv ? 1 : 0); put(c * 7 + x, r * 8 + y, on ? PAL.w : PAL.k); }
      }
    }
  };

  root.Apple2 = Apple2;
  root.Apple2.PHYS2DOS = PHYS2DOS;
  if (typeof module !== 'undefined') module.exports = Apple2;
})(typeof self !== 'undefined' ? self : this);
