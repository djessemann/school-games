// NMOS 6502 CPU core. The machine supplies read(addr) and write(addr, value).
// step() runs one instruction and returns the cycles it took.
(function (root) {
  'use strict';
  const C = 1, Z = 2, I = 4, D = 8, B = 16, U = 32, V = 64, N = 128;

  function CPU(read, write) {
    this.read = read; this.write = write;
    this.a = 0; this.x = 0; this.y = 0; this.s = 0xfd; this.p = U | I; this.pc = 0;
    this.cycles = 0;
  }
  const P = CPU.prototype;

  P.nz = function (v) { this.p = (this.p & ~(N | Z)) | (v & N) | (v === 0 ? Z : 0); return v; };
  P.push = function (v) { this.write(0x100 | this.s, v); this.s = (this.s - 1) & 0xff; };
  P.pop = function () { this.s = (this.s + 1) & 0xff; return this.read(0x100 | this.s); };
  P.rd16 = function (a) { return this.read(a) | (this.read((a + 1) & 0xffff) << 8); };
  // JMP ($xxFF) bug: the high byte comes from the start of the same page
  P.rd16bug = function (a) { return this.read(a) | (this.read((a & 0xff00) | ((a + 1) & 0xff)) << 8); };
  P.fetch = function () { const v = this.read(this.pc); this.pc = (this.pc + 1) & 0xffff; return v; };
  P.fetch16 = function () { const v = this.rd16(this.pc); this.pc = (this.pc + 2) & 0xffff; return v; };

  P.adc = function (m) {
    const a = this.a, c = this.p & C;
    if (this.p & D) {
      let lo = (a & 0x0f) + (m & 0x0f) + c;
      let hi = (a & 0xf0) + (m & 0xf0);
      if (lo > 9) { lo += 6; }
      if (lo > 0x0f) hi += 0x10;
      const zbin = ((a + m + c) & 0xff) === 0;
      this.p &= ~(N | V | Z | C);
      if (zbin) this.p |= Z;
      if (hi & 0x80) this.p |= N;
      if (~(a ^ m) & (a ^ hi) & 0x80) this.p |= V;
      if (hi > 0x90) hi += 0x60;
      if (hi > 0xff) this.p |= C;
      this.a = (hi & 0xf0) | (lo & 0x0f);
    } else {
      const r = a + m + c;
      this.p &= ~(C | V);
      if (r > 0xff) this.p |= C;
      if (~(a ^ m) & (a ^ r) & 0x80) this.p |= V;
      this.a = this.nz(r & 0xff);
    }
  };
  P.sbc = function (m) {
    const a = this.a, c = this.p & C, r = a - m - (1 - c);
    this.p &= ~(C | V);
    if (r >= 0) this.p |= C;
    if ((a ^ m) & (a ^ r) & 0x80) this.p |= V;
    if (this.p & D) {
      let lo = (a & 0x0f) - (m & 0x0f) - (1 - c);
      let hi = (a & 0xf0) - (m & 0xf0);
      if (lo & 0x10) { lo -= 6; hi -= 0x10; }
      if (hi & 0x100) hi -= 0x60;
      this.nz(r & 0xff);
      this.a = (hi & 0xf0) | (lo & 0x0f);
    } else {
      this.a = this.nz(r & 0xff);
    }
  };
  P.cmp = function (r, m) { const t = r - m; this.p = (this.p & ~C) | (t >= 0 ? C : 0); this.nz(t & 0xff); };
  P.branch = function (cond) {
    const o = this.fetch();
    if (cond) {
      const old = this.pc;
      this.pc = (this.pc + (o < 128 ? o : o - 256)) & 0xffff;
      return (old & 0xff00) !== (this.pc & 0xff00) ? 2 : 1;
    }
    return 0;
  };
  P.irq = function () {
    if (this.p & I) return;
    this.push(this.pc >> 8); this.push(this.pc & 0xff); this.push((this.p | U) & ~B);
    this.p |= I; this.pc = this.rd16(0xfffe);
  };
  P.reset = function () { this.s = 0xfd; this.p = U | I; this.pc = this.rd16(0xfffc); };

  // addressing modes return an effective address
  const M = {
    imm(c) { const a = c.pc; c.pc = (c.pc + 1) & 0xffff; return a; },
    zp(c) { return c.fetch(); },
    zpx(c) { return (c.fetch() + c.x) & 0xff; },
    zpy(c) { return (c.fetch() + c.y) & 0xff; },
    abs(c) { return c.fetch16(); },
    abx(c) { const b = c.fetch16(); const a = (b + c.x) & 0xffff; if ((a ^ b) & 0xff00) c.extra = 1; return a; },
    aby(c) { const b = c.fetch16(); const a = (b + c.y) & 0xffff; if ((a ^ b) & 0xff00) c.extra = 1; return a; },
    izx(c) { const z = (c.fetch() + c.x) & 0xff; return c.read(z) | (c.read((z + 1) & 0xff) << 8); },
    izy(c) { const z = c.fetch(); const b = c.read(z) | (c.read((z + 1) & 0xff) << 8); const a = (b + c.y) & 0xffff; if ((a ^ b) & 0xff00) c.extra = 1; return a; },
  };

  const OPS = new Array(256);
  function op(code, cyc, fn, mode, pagePenalty) { OPS[code] = { cyc, fn, mode: mode ? M[mode] : null, pp: !!pagePenalty }; }
  const ld = r => function (c, a) { c[r] = c.nz(c.read(a)); };
  const st = r => function (c, a) { c.write(a, c[r]); };
  const group = (name, fn, list) => { for (const [code, mode, cyc, pp] of list) op(code, cyc, fn, mode, pp); };

  group('LDA', ld('a'), [[0xa9, 'imm', 2], [0xa5, 'zp', 3], [0xb5, 'zpx', 4], [0xad, 'abs', 4], [0xbd, 'abx', 4, 1], [0xb9, 'aby', 4, 1], [0xa1, 'izx', 6], [0xb1, 'izy', 5, 1]]);
  group('LDX', ld('x'), [[0xa2, 'imm', 2], [0xa6, 'zp', 3], [0xb6, 'zpy', 4], [0xae, 'abs', 4], [0xbe, 'aby', 4, 1]]);
  group('LDY', ld('y'), [[0xa0, 'imm', 2], [0xa4, 'zp', 3], [0xb4, 'zpx', 4], [0xac, 'abs', 4], [0xbc, 'abx', 4, 1]]);
  group('STA', st('a'), [[0x85, 'zp', 3], [0x95, 'zpx', 4], [0x8d, 'abs', 4], [0x9d, 'abx', 5], [0x99, 'aby', 5], [0x81, 'izx', 6], [0x91, 'izy', 6]]);
  group('STX', st('x'), [[0x86, 'zp', 3], [0x96, 'zpy', 4], [0x8e, 'abs', 4]]);
  group('STY', st('y'), [[0x84, 'zp', 3], [0x94, 'zpx', 4], [0x8c, 'abs', 4]]);
  const alu = [['imm', 2, 0x09], ['zp', 3, 0x05], ['zpx', 4, 0x15], ['abs', 4, 0x0d], ['abx', 4, 0x1d, 1], ['aby', 4, 0x19, 1], ['izx', 6, 0x01], ['izy', 5, 0x11, 1]];
  const aluOps = [
    [0x00, function (c, a) { c.a = c.nz(c.a | c.read(a)); }],
    [0x20, function (c, a) { c.a = c.nz(c.a & c.read(a)); }],
    [0x40, function (c, a) { c.a = c.nz(c.a ^ c.read(a)); }],
    [0x60, function (c, a) { c.adc(c.read(a)); }],
    [0xc0, function (c, a) { c.cmp(c.a, c.read(a)); }],
    [0xe0, function (c, a) { c.sbc(c.read(a)); }],
  ];
  for (const [base, fn] of aluOps) for (const [m, cyc, o, pp] of alu) op(base + o, cyc, fn, m, pp);

  op(0xe0, 2, function (c, a) { c.cmp(c.x, c.read(a)); }, 'imm'); op(0xe4, 3, function (c, a) { c.cmp(c.x, c.read(a)); }, 'zp'); op(0xec, 4, function (c, a) { c.cmp(c.x, c.read(a)); }, 'abs');
  op(0xc0, 2, function (c, a) { c.cmp(c.y, c.read(a)); }, 'imm'); op(0xc4, 3, function (c, a) { c.cmp(c.y, c.read(a)); }, 'zp'); op(0xcc, 4, function (c, a) { c.cmp(c.y, c.read(a)); }, 'abs');
  const bit = function (c, a) { const m = c.read(a); c.p = (c.p & ~(N | V | Z)) | (m & (N | V)) | ((c.a & m) === 0 ? Z : 0); };
  op(0x24, 3, bit, 'zp'); op(0x2c, 4, bit, 'abs');

  // read-modify-write
  const rmw = (fnA, fnM, codes) => {
    op(codes[0], 2, function (c) { c.a = fnA(c, c.a); });
    const modes = [['zp', 5], ['zpx', 6], ['abs', 6], ['abx', 7]];
    modes.forEach(([m, cyc], i) => op(codes[i + 1], cyc, function (c, a) { const v = c.read(a); c.write(a, v); c.write(a, fnM(c, v)); }, m));
  };
  const asl = (c, v) => { c.p = (c.p & ~C) | (v >> 7); return c.nz((v << 1) & 0xff); };
  const lsr = (c, v) => { c.p = (c.p & ~C) | (v & 1); return c.nz(v >> 1); };
  const rol = (c, v) => { const r = ((v << 1) | (c.p & C)) & 0xff; c.p = (c.p & ~C) | (v >> 7); return c.nz(r); };
  const ror = (c, v) => { const r = (v >> 1) | ((c.p & C) << 7); c.p = (c.p & ~C) | (v & 1); return c.nz(r); };
  rmw(asl, asl, [0x0a, 0x06, 0x16, 0x0e, 0x1e]);
  rmw(lsr, lsr, [0x4a, 0x46, 0x56, 0x4e, 0x5e]);
  rmw(rol, rol, [0x2a, 0x26, 0x36, 0x2e, 0x3e]);
  rmw(ror, ror, [0x6a, 0x66, 0x76, 0x6e, 0x7e]);
  const inc = (c, v) => c.nz((v + 1) & 0xff), dec = (c, v) => c.nz((v - 1) & 0xff);
  [['zp', 5, 0xe6], ['zpx', 6, 0xf6], ['abs', 6, 0xee], ['abx', 7, 0xfe]].forEach(([m, cyc, o]) => op(o, cyc, function (c, a) { const v = c.read(a); c.write(a, inc(c, v)); }, m));
  [['zp', 5, 0xc6], ['zpx', 6, 0xd6], ['abs', 6, 0xce], ['abx', 7, 0xde]].forEach(([m, cyc, o]) => op(o, cyc, function (c, a) { const v = c.read(a); c.write(a, dec(c, v)); }, m));

  op(0xe8, 2, c => { c.x = inc(c, c.x); }); op(0xca, 2, c => { c.x = dec(c, c.x); });
  op(0xc8, 2, c => { c.y = inc(c, c.y); }); op(0x88, 2, c => { c.y = dec(c, c.y); });
  op(0xaa, 2, c => { c.x = c.nz(c.a); }); op(0x8a, 2, c => { c.a = c.nz(c.x); });
  op(0xa8, 2, c => { c.y = c.nz(c.a); }); op(0x98, 2, c => { c.a = c.nz(c.y); });
  op(0xba, 2, c => { c.x = c.nz(c.s); }); op(0x9a, 2, c => { c.s = c.x; });
  op(0x48, 3, c => { c.push(c.a); }); op(0x68, 4, c => { c.a = c.nz(c.pop()); });
  op(0x08, 3, c => { c.push(c.p | B | U); }); op(0x28, 4, c => { c.p = (c.pop() & ~B) | U; });
  op(0x18, 2, c => { c.p &= ~C; }); op(0x38, 2, c => { c.p |= C; });
  op(0x58, 2, c => { c.p &= ~I; }); op(0x78, 2, c => { c.p |= I; });
  op(0xd8, 2, c => { c.p &= ~D; }); op(0xf8, 2, c => { c.p |= D; });
  op(0xb8, 2, c => { c.p &= ~V; });
  op(0xea, 2, () => {});

  op(0x4c, 3, c => { c.pc = c.fetch16(); });
  op(0x6c, 5, c => { c.pc = c.rd16bug(c.fetch16()); });
  op(0x20, 6, c => { const t = c.fetch16(); const r = (c.pc - 1) & 0xffff; c.push(r >> 8); c.push(r & 0xff); c.pc = t; });
  op(0x60, 6, c => { const lo = c.pop(), hi = c.pop(); c.pc = (((hi << 8) | lo) + 1) & 0xffff; });
  op(0x40, 6, c => { c.p = (c.pop() & ~B) | U; const lo = c.pop(), hi = c.pop(); c.pc = (hi << 8) | lo; });
  op(0x00, 7, c => { const r = (c.pc + 1) & 0xffff; c.push(r >> 8); c.push(r & 0xff); c.push(c.p | B | U); c.p |= I; c.pc = c.rd16(0xfffe); });

  const br = (code, fn) => op(code, 2, c => { c.extra = c.branch(fn(c.p)); });
  br(0x10, p => !(p & N)); br(0x30, p => p & N); br(0x50, p => !(p & V)); br(0x70, p => p & V);
  br(0x90, p => !(p & C)); br(0xb0, p => p & C); br(0xd0, p => !(p & Z)); br(0xf0, p => p & Z);

  // undocumented NOPs so stray code doesn't stop the machine
  for (const o of [0x1a, 0x3a, 0x5a, 0x7a, 0xda, 0xfa]) op(o, 2, () => {});
  for (const o of [0x80, 0x82, 0x89, 0xc2, 0xe2]) op(o, 2, () => {}, 'imm');
  for (const o of [0x04, 0x44, 0x64]) op(o, 3, () => {}, 'zp');
  for (const o of [0x14, 0x34, 0x54, 0x74, 0xd4, 0xf4]) op(o, 4, () => {}, 'zpx');
  op(0x0c, 4, () => {}, 'abs');
  for (const o of [0x1c, 0x3c, 0x5c, 0x7c, 0xdc, 0xfc]) op(o, 4, () => {}, 'abx');

  P.step = function () {
    const code = this.fetch();
    const o = OPS[code];
    if (!o) { this.pc = (this.pc - 1) & 0xffff; this.bad = code; return 0; }
    this.extra = 0;
    if (o.mode) { const a = o.mode(this); o.fn(this, a); } else o.fn(this);
    const cyc = o.cyc + (o.pp || o.cyc === 2 && this.extra ? this.extra : 0);
    this.cycles += cyc;
    return cyc;
  };

  root.CPU6502 = CPU;
  if (typeof module !== 'undefined') module.exports = CPU;
})(typeof self !== 'undefined' ? self : this);
