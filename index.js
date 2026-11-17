// 小克音量均衡器 —— EchoMusic 插件
//
// 自带的「音量均衡」只按整首歌的平均响度调一次音量；这个插件实时测量正在播放的响度，
// 把它保持在用户设定的「最低～最高响度」之间：小声的段落抬起来，大声的段落压下去。
//
// 实现要点：
// 1. 测量：订阅播放器自己的音频快照（ctx 声明 audioSpectrum，数据来自播放器输出，不是系统录音），
//    对波形做 BS.1770 K 加权，得到近似 LUFS 的短时响度。
// 2. 调节：通过播放器的「响度增益」级（自带音量均衡用的同一级，原生按缓冲区平滑过渡，无爆音）
//    设置增益。不动音量滑块，滑块仍然是总音量。
// 3. 测到的电平已经包含当前增益和音量，所以先除掉它们，按「歌曲本身的响度」算目标增益——
//    属于前馈估计，不会因为反馈而振荡。
// 4. 和自带音量均衡共存（1.1.0 起）：不碰它的开关。本插件开着时由本插件掌管那一级增益，
//    自带均衡在切歌等时机发的整首增益会被立刻盖回；本插件关掉时把增益还给自带均衡该有的值。
// 5. 离线处理：给小克音乐下载器用。整首歌可以「往前看」，压大声段在声音到来之前就完成，
//    再过一道 -1 dBFS 前瞻限幅，最后编码成 FLAC（纯 JS 编码器，无损保存处理结果）。
//    接口挂在 globalThis.__ClaudeVolumeLeveler。

// ============================================================================
// 通用参数
// ============================================================================

export const DEFAULT_SETTINGS = {
  enabled: true,
  minLufs: -20, // 低于它就抬
  maxLufs: -14, // 高于它就压
  maxBoost: 12, // 最多抬多少 dB
  maxCut: 18, // 最多压多少 dB
  speed: 'normal',
};

export const PRESETS = {
  gentle: { label: '温和', minLufs: -24, maxLufs: -12, speed: 'slow' },
  standard: { label: '标准', minLufs: -20, maxLufs: -14, speed: 'normal' },
  night: { label: '夜间 / 戴耳机', minLufs: -19, maxLufs: -16, speed: 'fast' },
};

// window：按多长一段来判断「这段有多响」（太短会跟着鼓点、乐句一下下动，听起来像歌自己在忽大忽小）
// ratio：柔和压缩比。超出范围的部分只拉回 1 - 1/ratio（3 → 拉回 2/3），大声的段落仍然比安静段落响，只是没那么猛
// attack / release：实时模式下往下压 / 往回放的时间常数
// lead：预听模式下提前多久开始慢慢推推子（秒）
export const SPEEDS = {
  slow: { label: '慢（最自然）', window: 3.0, attack: 0.9, release: 4.0, ratio: 2.5, lead: 1.6 },
  normal: { label: '中（推荐）', window: 2.0, attack: 0.6, release: 2.5, ratio: 3, lead: 1.2 },
  fast: { label: '快（最稳）', window: 1.2, attack: 0.35, release: 1.5, ratio: 4, lead: 0.8 },
};
const KNEE_DB = 3; // 软拐点：范围边上不是一刀切，而是慢慢开始管
const BLAST_DB = 8; // 护耳：（短时）响度比最高响度还高这么多的部分，不讲柔和，直接全压

const GATE_LUFS = -50; // 低于这个当作静音/间隙：保持增益，不去放大底噪
const LIMIT_CEILING = Math.pow(10, -1 / 20); // 离线限幅 -1 dBFS
const API_VERSION = 1;

export const normalizeSettings = (raw) => {
  const s = { ...DEFAULT_SETTINGS, ...(raw || {}) };
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  s.enabled = s.enabled !== false;
  s.minLufs = Math.min(-6, Math.max(-40, num(s.minLufs, DEFAULT_SETTINGS.minLufs)));
  s.maxLufs = Math.min(-6, Math.max(-40, num(s.maxLufs, DEFAULT_SETTINGS.maxLufs)));
  if (s.maxLufs < s.minLufs) [s.minLufs, s.maxLufs] = [s.maxLufs, s.minLufs];
  s.maxBoost = Math.min(24, Math.max(0, num(s.maxBoost, DEFAULT_SETTINGS.maxBoost)));
  s.maxCut = Math.min(30, Math.max(0, num(s.maxCut, DEFAULT_SETTINGS.maxCut)));
  if (!SPEEDS[s.speed]) s.speed = DEFAULT_SETTINGS.speed;
  s.prelisten = s.prelisten !== false;
  return s;
};

/** 软拐点：超出量 x（dB）在 ±knee/2 内平滑过渡，之外就是 x 本身（负数为 0）。 */
const softExcess = (x, knee = KNEE_DB) => (x <= -knee / 2 ? 0 : x >= knee / 2 ? x : ((x + knee / 2) ** 2) / (2 * knee));

/**
 * 某一段歌曲本身的响度为 lufs 时，应该加多少 dB（柔和压缩）：
 * 比最高响度大的部分只拉回 1 - 1/ratio，比最低响度小的部分只抬回 1 - 1/ratio；
 * 但无论如何不让结果比最高响度高出 BLAST_DB 以上（护耳）。
 */
export const desiredGainDb = (lufs, s) => {
  const sp = SPEEDS[s.speed] || SPEEDS.normal;
  const k = 1 - 1 / sp.ratio;
  let g = k * softExcess(s.minLufs - lufs) - k * softExcess(lufs - s.maxLufs);
  g = Math.min(g, s.maxLufs + BLAST_DB - lufs);
  return Math.min(s.maxBoost, Math.max(-s.maxCut, g));
};

// ---------- K 加权（BS.1770，任意采样率，系数公式同 libebur128） ----------
export const kWeightingCoefs = (fs) => {
  let f0 = 1681.974450955533;
  const G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  return { shelf, hp };
};

/** 一段样本做 K 加权（两级双二阶级联），返回均方值；跳过前 skip 个样本让滤波器稳定。 */
const biquadMeanSquare = (samples, coefs, skip) => {
  const { shelf: s, hp: h } = coefs;
  let sx1 = 0, sx2 = 0, sy1 = 0, sy2 = 0;
  let hx1 = 0, hx2 = 0, hy1 = 0, hy2 = 0;
  let sum = 0, count = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = s.b0 * x + s.b1 * sx1 + s.b2 * sx2 - s.a1 * sy1 - s.a2 * sy2;
    sx2 = sx1; sx1 = x; sy2 = sy1; sy1 = y;
    const z = h.b0 * y + h.b1 * hx1 + h.b2 * hx2 - h.a1 * hy1 - h.a2 * hy2;
    hx2 = hx1; hx1 = y; hy2 = hy1; hy1 = z;
    if (i >= skip) {
      sum += z * z;
      count += 1;
    }
  }
  return count ? sum / count : 0;
};

const energyToLufs = (e) => (e > 1e-12 ? -0.691 + 10 * Math.log10(e) : -120);

// ============================================================================
// 离线处理：计算增益曲线 → 应用 → 前瞻限幅
// ============================================================================

const HOP_SECONDS = 0.05;

/** 一个声道的一段样本做 K 加权，平方累加进各 hop；state 保存滤波器状态，可以分段接着算。 */
const accumulateHopEnergy = (ch, from, to, coefs, hop, hopEnergy, hopPeak, st) => {
  const { shelf: s, hp: h } = coefs;
  let { sx1, sx2, sy1, sy2, hx1, hx2, hy1, hy2 } = st;
  for (let i = from; i < to; i++) {
    const x = ch[i];
    const y = s.b0 * x + s.b1 * sx1 + s.b2 * sx2 - s.a1 * sy1 - s.a2 * sy2;
    sx2 = sx1; sx1 = x; sy2 = sy1; sy1 = y;
    const z = h.b0 * y + h.b1 * hx1 + h.b2 * hx2 - h.a1 * hy1 - h.a2 * hy2;
    hx2 = hx1; hx1 = y; hy2 = hy1; hy1 = z;
    const k = (i / hop) | 0;
    hopEnergy[k] += z * z;
    const a = x < 0 ? -x : x;
    if (a > hopPeak[k]) hopPeak[k] = a;
  }
  Object.assign(st, { sx1, sx2, sy1, sy2, hx1, hx2, hy1, hy2 });
};

/**
 * 按 50 ms 一格测整首歌：energy[i] 为该格各声道 K 加权平方和，peak[i] 为该格最大样本绝对值。
 * yieldEvery > 0 时是 async，每处理这么多样本让出一次主线程（预听时用，不卡界面）。
 */
export const measureHops = (channels, sampleRate, yieldEvery = 0) => {
  const n = channels[0].length;
  const hop = Math.max(1, Math.round(sampleRate * HOP_SECONDS));
  const hops = Math.ceil(n / hop);
  const energy = new Float64Array(hops);
  const peak = new Float32Array(hops);
  const coefs = kWeightingCoefs(sampleRate);
  const result = { energy, peak, hop, n, sampleRate };
  const fresh = () => ({ sx1: 0, sx2: 0, sy1: 0, sy2: 0, hx1: 0, hx2: 0, hy1: 0, hy2: 0 });
  if (!yieldEvery) {
    for (const ch of channels) accumulateHopEnergy(ch, 0, n, coefs, hop, energy, peak, fresh());
    return result;
  }
  return (async () => {
    for (const ch of channels) {
      const st = fresh();
      for (let from = 0; from < n; from += yieldEvery) {
        accumulateHopEnergy(ch, from, Math.min(n, from + yieldEvery), coefs, hop, energy, peak, st);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    return result;
  })();
};

/** 由 hop 能量算以每个 hop 为中心、windowSeconds 长的滑动窗口响度（LUFS）。 */
export const windowLufs = ({ energy, hop, n }, windowSeconds) => {
  const hops = energy.length;
  const half = Math.max(1, Math.round(windowSeconds / HOP_SECONDS / 2));
  const prefix = new Float64Array(hops + 1);
  for (let i = 0; i < hops; i++) prefix[i + 1] = prefix[i] + energy[i];
  const lufs = new Float32Array(hops);
  for (let i = 0; i < hops; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(hops, i + half + 1);
    const samples = Math.min(n, b * hop) - a * hop;
    lufs[i] = energyToLufs((prefix[b] - prefix[a]) / Math.max(1, samples));
  }
  return lufs;
};

/** K 加权各声道，按 hop 求能量，返回每个 hop 中心的短时响度（LUFS）。 */
export const measureLoudnessCurve = (channels, sampleRate, windowSeconds) => {
  const m = measureHops(channels, sampleRate);
  return { lufs: windowLufs(m, windowSeconds), hop: m.hop, hops: m };
};

// 滑动窗口最小值（窗口 [i - back, i + ahead]），单调队列 O(n)
const slidingMin = (src, back, ahead) => {
  const n = src.length;
  const out = new Float32Array(n);
  const dq = new Int32Array(n);
  let head = 0, tail = 0, j = 0;
  for (let i = 0; i < n; i++) {
    while (j < n && j <= i + ahead) {
      while (tail > head && src[dq[tail - 1]] >= src[j]) tail--;
      dq[tail++] = j++;
    }
    while (dq[head] < i - back) head++;
    out[i] = src[dq[head]];
  }
  return out;
};

// 对称滑动平均（半窗 w 个点）
const movingAverage = (src, w) => {
  const n = src.length;
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + src[i];
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w);
    const b = Math.min(n, i + w + 1);
    out[i] = (pre[b] - pre[a]) / (b - a);
  }
  return out;
};

/**
 * 由整首歌的响度算「推推子」增益曲线（dB，每个 hop 一个点）。整首都知道，所以可以往前看：
 * 1. 按段落响度（window 长）定柔和压缩的目标；
 * 2. 往前看 lead 秒取最小值：要压就提前开始，下降在大声到来之前完成；往回放按 release 慢慢来；
 * 3. 对称平滑成缓坡，听起来像有人提前、轻轻地推推子，而不是先炸一下再缩；
 * 4. 护耳：短时（0.4 s）响度仍比最高响度高 BLAST_DB 以上的地方，同样提前、平滑地压到位；
 * 5. 有峰值数据时让 增益 + 峰值 ≤ +0.5 dBFS（输出端还有限幅兜底）。
 * shortLufs、peakDb 可选（下载器的离线处理只传 lufs，峰值交给后面的前瞻限幅器）。
 */
export const computeGainCurve = (lufs, settings, extra = {}) => {
  const s = normalizeSettings(settings);
  const sp = SPEEDS[s.speed];
  const hops = lufs.length;
  const raw = new Float32Array(hops);
  // 1. 目标增益；静音/间隙保持前一个值（开头的静音取后面第一个有效值）
  let firstValid = -1;
  for (let i = 0; i < hops; i++) {
    if (lufs[i] >= GATE_LUFS) {
      raw[i] = desiredGainDb(lufs[i], s);
      if (firstValid < 0) firstValid = i;
    } else raw[i] = NaN;
  }
  if (firstValid < 0) return new Float32Array(hops); // 全是静音
  for (let i = 0; i < firstValid; i++) raw[i] = raw[firstValid];
  for (let i = firstValid + 1; i < hops; i++) if (Number.isNaN(raw[i])) raw[i] = raw[i - 1];
  // 淡入 / 淡出不抬：找到歌的「主体」（段落响度不低于整首较响部分 12 dB 的第一个和最后一个点），
  // 主体前后如果只是短短的淡入淡出（≤ 12 s / 15 s），增益不比主体边上更高——不然淡出会被抬平
  {
    const gated = Array.from(lufs).filter((v) => v >= GATE_LUFS).sort((a, b) => a - b);
    if (gated.length) {
      const ref = gated[Math.floor(gated.length * 0.9)] - 12;
      let a = 0, b = hops - 1;
      while (a < hops && !(lufs[a] >= ref)) a++;
      while (b > 0 && !(lufs[b] >= ref)) b--;
      if (a < b) {
        // 边界点自己可能已经在淡入/淡出里了：取主体头/尾 5 s 内最小的增益当上限
        const span = Math.round(5 / HOP_SECONDS);
        let headCap = Infinity, tailCap = Infinity;
        for (let i = a; i <= Math.min(b, a + span); i++) headCap = Math.min(headCap, raw[i]);
        for (let i = Math.max(a, b - span); i <= b; i++) tailCap = Math.min(tailCap, raw[i]);
        if (a * HOP_SECONDS <= 12) for (let i = 0; i <= a; i++) raw[i] = Math.min(raw[i], headCap);
        if ((hops - 1 - b) * HOP_SECONDS <= 15) for (let i = b; i < hops; i++) raw[i] = Math.min(raw[i], tailCap);
      }
    }
  }
  // 4（先算好合进来）. 护耳上限：短时响度 + 增益 ≤ 最高响度 + BLAST_DB；峰值上限
  const { shortLufs, peakDb } = extra;
  if (shortLufs || peakDb) {
    for (let i = 0; i < hops; i++) {
      if (shortLufs && shortLufs[i] >= GATE_LUFS) raw[i] = Math.min(raw[i], s.maxLufs + BLAST_DB - shortLufs[i]);
      if (peakDb && peakDb[i] > -60) raw[i] = Math.min(raw[i], 0.5 - peakDb[i]);
      raw[i] = Math.max(-s.maxCut, raw[i]);
    }
  }
  // 2. 往前看 lead 秒取最小值，下降立即跟随（已经提前了），上升按 release 慢慢恢复
  const lead = Math.max(1, Math.round(sp.lead / HOP_SECONDS));
  const ahead = slidingMin(raw, 0, lead);
  const rel = 1 - Math.exp(-HOP_SECONDS / sp.release);
  const smooth = new Float32Array(hops);
  let g = ahead[0];
  for (let i = 0; i < hops; i++) {
    g = ahead[i] < g ? ahead[i] : g + (ahead[i] - g) * rel;
    smooth[i] = g;
  }
  // 3. 对称平滑（半窗 = lead 的一半：坡在大声到来前 0.5～1.5 个 lead 之间走完，到点时已经压到位）
  return movingAverage(smooth, Math.max(1, Math.round(lead / 2)));
};

/** 按增益曲线（hop 中心线性插值）就地处理所有声道。 */
export const applyGainCurve = (channels, gainDb, hop) => {
  const n = channels[0].length;
  const hops = gainDb.length;
  const lin = new Float32Array(hops);
  for (let i = 0; i < hops; i++) lin[i] = Math.pow(10, gainDb[i] / 20);
  const halfHop = hop / 2;
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      const pos = (i - halfHop) / hop;
      const k = Math.floor(pos);
      let g;
      if (k < 0) g = lin[0];
      else if (k >= hops - 1) g = lin[hops - 1];
      else {
        const t = pos - k;
        g = lin[k] + (lin[k + 1] - lin[k]) * t;
      }
      ch[i] *= g;
    }
  }
};

/** 立体声联动的前瞻峰值限幅（保证输出样本绝对值不超过 ceiling），就地处理。 */
export const lookaheadLimit = (channels, sampleRate, ceiling = LIMIT_CEILING) => {
  const n = channels[0].length;
  const L = Math.max(1, Math.round(sampleRate * 0.005)); // 5 ms
  const relCoef = 1 - Math.exp(-1 / (sampleRate * 0.08)); // 80 ms 恢复
  const size = 2 * L + 4;
  const req = new Float32Array(size); // g_req 环形
  const aRing = new Float32Array(size); // A 环形
  const dq = new Int32Array(size); // 单调队列（存绝对下标）
  let head = 0, tail = 0; // dq 使用环形下标
  let sumA = 0;
  let r = 1;
  const reqAt = (k) => req[k % size];
  for (let t = 0; t < n + L; t++) {
    // 计算 g_req[t]
    let need = 1;
    if (t < n) {
      let peak = 0;
      for (const ch of channels) {
        const v = Math.abs(ch[t]);
        if (v > peak) peak = v;
      }
      need = peak > ceiling ? ceiling / peak : 1;
    }
    req[t % size] = need;
    // A[t] = min(g_req[t-L .. t])
    while (tail > head && reqAt(dq[(tail - 1) % size]) >= need) tail--;
    dq[tail % size] = t;
    tail++;
    while (dq[head % size] < t - L) head++;
    const A = reqAt(dq[head % size]);
    aRing[t % size] = A;
    sumA += A;
    if (t - L - 1 >= 0) sumA -= aRing[(t - L - 1) % size];
    // B[m] = mean(A[m .. m+L])，m = t - L
    const m = t - L;
    if (m >= 0) {
      const B = sumA / (L + 1);
      r = B < r ? B : r + (B - r) * relCoef;
      if (r < 1) for (const ch of channels) ch[m] *= r;
      // 浮点误差兜底
      for (const ch of channels) {
        if (ch[m] > ceiling) ch[m] = ceiling;
        else if (ch[m] < -ceiling) ch[m] = -ceiling;
      }
    }
  }
};

// ============================================================================
// FLAC 编码器（固定预测器 + 分区 Rice，支持立体声去相关，16/24 bit）
// ============================================================================

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let k = 0; k < 8; k++) d = d & 0x8000 ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}

class BitWriter {
  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(capacity);
    this.pos = 0;
    this.acc = 0;
    this.nbits = 0;
  }
  reset() {
    this.pos = 0;
    this.acc = 0;
    this.nbits = 0;
  }
  ensure(extra) {
    if (this.pos + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.pos + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
  }
  /** 写入 n 位（n ≤ 24），value 取低 n 位。 */
  bits(value, n) {
    if (n === 0) return;
    this.acc = ((this.acc << n) | (value & ((1 << n) - 1))) >>> 0;
    this.nbits += n;
    if (this.nbits >= 8) {
      this.ensure(4);
      while (this.nbits >= 8) {
        this.nbits -= 8;
        this.buf[this.pos++] = (this.acc >>> this.nbits) & 0xff;
      }
      this.acc &= (1 << this.nbits) - 1;
    }
  }
  /** 写入最多 32 位的有符号/无符号值。 */
  bitsLong(value, n) {
    if (n <= 24) return this.bits(value, n);
    const hi = n - 16;
    this.bits(Math.floor(value / 65536), hi);
    this.bits(value & 0xffff, 16);
  }
  zeros(n) {
    while (n > 24) {
      this.bits(0, 24);
      n -= 24;
    }
    this.bits(0, n);
  }
  alignByte() {
    if (this.nbits) this.bits(0, 8 - this.nbits);
  }
  bytes() {
    return this.buf.subarray(0, this.pos);
  }
}

/** 预测阶 0..4 的残差绝对值和，返回 [sum0..sum4]（从下标 4 开始统计，避免越界）。 */
const fixedOrderCosts = (x, n) => {
  const s = [0, 0, 0, 0, 0];
  if (n <= 4) return s.map(() => 0);
  let a = x[3], b = x[3] - x[2], c = b - (x[2] - x[1]), d = c - (x[2] - x[1] - (x[1] - x[0]));
  for (let i = 4; i < n; i++) {
    const e0 = x[i];
    const e1 = e0 - a;
    const e2 = e1 - b;
    const e3 = e2 - c;
    const e4 = e3 - d;
    a = e0; b = e1; c = e2; d = e3;
    s[0] += Math.abs(e0);
    s[1] += Math.abs(e1);
    s[2] += Math.abs(e2);
    s[3] += Math.abs(e3);
    s[4] += Math.abs(e4);
  }
  return s;
};

const fixedResidual = (x, n, order, out) => {
  for (let i = order; i < n; i++) {
    let e;
    switch (order) {
      case 0: e = x[i]; break;
      case 1: e = x[i] - x[i - 1]; break;
      case 2: e = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: e = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: e = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4];
    }
    out[i - order] = e;
  }
  return n - order;
};

const riceBits = (sum, count, k) => count * (k + 1) + Math.floor(sum / Math.pow(2, k));

const bestRiceParam = (sum, count, maxParam) => {
  if (count === 0) return { k: 0, bits: 0 };
  const mean = sum / count;
  let k0 = mean > 1 ? Math.floor(Math.log2(mean)) : 0;
  let best = { k: 0, bits: Infinity };
  for (let k = Math.max(0, k0 - 1); k <= Math.min(maxParam, k0 + 1); k++) {
    const b = riceBits(sum, count, k);
    if (b < best.bits) best = { k, bits: b };
  }
  return best;
};

export class FlacEncoder {
  constructor({ sampleRate, channels, bitsPerSample, totalSamples, blockSize = 4096 }) {
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.bps = bitsPerSample;
    this.totalSamples = totalSamples;
    this.blockSize = blockSize;
    this.frameIndex = 0;
    this.w = new BitWriter(blockSize * channels * 4 + 1024);
    this.res = new Int32Array(blockSize);
    this.u = new Uint32Array(blockSize);
    this.mid = new Int32Array(blockSize);
    this.side = new Int32Array(blockSize);
  }

  header({ tags = {}, picture = null } = {}) {
    const blocks = [];
    // STREAMINFO
    const si = new BitWriter(64);
    si.bits(this.blockSize, 16);
    si.bits(this.blockSize, 16);
    si.bits(0, 24);
    si.bits(0, 24);
    si.bits(this.sampleRate, 20);
    si.bits(this.channels - 1, 3);
    si.bits(this.bps - 1, 5);
    si.bits(Math.floor(this.totalSamples / 2 ** 32) & 0xf, 4);
    si.bits(Math.floor(this.totalSamples / 65536) & 0xffff, 16);
    si.bits(this.totalSamples & 0xffff, 16);
    for (let i = 0; i < 16; i++) si.bits(0, 8); // MD5 未知
    blocks.push([0, si.bytes().slice()]);
    // VORBIS_COMMENT
    const enc = new TextEncoder();
    const vendor = enc.encode('Claude Volume Leveler');
    const entries = Object.entries(tags)
      .filter(([, v]) => v !== undefined && v !== null && String(v) !== '')
      .map(([k, v]) => enc.encode(`${k}=${v}`));
    const vcLen = 4 + vendor.length + 4 + entries.reduce((a, e) => a + 4 + e.length, 0);
    const vc = new Uint8Array(vcLen);
    const dv = new DataView(vc.buffer);
    let p = 0;
    dv.setUint32(p, vendor.length, true); p += 4;
    vc.set(vendor, p); p += vendor.length;
    dv.setUint32(p, entries.length, true); p += 4;
    for (const e of entries) {
      dv.setUint32(p, e.length, true); p += 4;
      vc.set(e, p); p += e.length;
    }
    blocks.push([4, vc]);
    // PICTURE
    if (picture?.data?.length && picture.data.length < 8 * 1024 * 1024) {
      const mime = enc.encode(picture.mime || 'image/jpeg');
      const pic = new Uint8Array(32 + mime.length + picture.data.length);
      const pv = new DataView(pic.buffer);
      let q = 0;
      pv.setUint32(q, 3); q += 4; // front cover
      pv.setUint32(q, mime.length); q += 4;
      pic.set(mime, q); q += mime.length;
      pv.setUint32(q, 0); q += 4; // description
      q += 16; // width/height/depth/colors = 0
      pv.setUint32(q, picture.data.length); q += 4;
      pic.set(picture.data, q);
      blocks.push([6, pic]);
    }
    const total = 4 + blocks.reduce((a, [, d]) => a + 4 + d.length, 0);
    const out = new Uint8Array(total);
    out.set([0x66, 0x4c, 0x61, 0x43], 0); // "fLaC"
    let o = 4;
    blocks.forEach(([type, data], i) => {
      out[o] = (i === blocks.length - 1 ? 0x80 : 0) | type;
      out[o + 1] = (data.length >>> 16) & 0xff;
      out[o + 2] = (data.length >>> 8) & 0xff;
      out[o + 3] = data.length & 0xff;
      out.set(data, o + 4);
      o += 4 + data.length;
    });
    return out;
  }

  /** 估算一个声道信号用固定预测器编码的代价（位）与最佳阶数。 */
  analyze(x, n, bps) {
    let allSame = true;
    for (let i = 1; i < n; i++) if (x[i] !== x[0]) { allSame = false; break; }
    if (allSame) return { constant: true, bits: bps, order: 0 };
    if (n <= 4) return { verbatim: true, bits: n * bps, order: 0 };
    const costs = fixedOrderCosts(x, n);
    let order = 0;
    for (let k = 1; k <= 4; k++) if (costs[k] < costs[order]) order = k;
    const count = n - 4;
    const est = bestRiceParam(costs[order] * 2, count, 30).bits + order * bps;
    return { order, bits: est };
  }

  writeSubframe(x, n, bps, info) {
    const w = this.w;
    if (info.constant) {
      w.bits(0, 1);
      w.bits(0, 6);
      w.bits(0, 1);
      w.bitsLong(x[0], bps);
      return;
    }
    if (info.verbatim) {
      w.bits(0, 1);
      w.bits(1, 6);
      w.bits(0, 1);
      for (let i = 0; i < n; i++) w.bitsLong(x[i], bps);
      return;
    }
    const order = info.order;
    w.bits(0, 1);
    w.bits(0b001000 | order, 6);
    w.bits(0, 1);
    for (let i = 0; i < order; i++) w.bitsLong(x[i], bps);
    const count = fixedResidual(x, n, order, this.res);
    const u = this.u;
    for (let i = 0; i < count; i++) {
      const e = this.res[i];
      u[i] = e >= 0 ? e * 2 : -e * 2 - 1;
    }
    // 选分区阶数
    let maxP = 0;
    while (maxP < 8 && n % (1 << (maxP + 1)) === 0 && n >> (maxP + 1) > order) maxP++;
    let best = null;
    for (let p = 0; p <= maxP; p++) {
      const parts = 1 << p;
      const len = n >> p;
      const params = new Array(parts);
      let bits = 0;
      let idx = 0;
      for (let part = 0; part < parts; part++) {
        const cnt = part === 0 ? len - order : len;
        let sum = 0;
        for (let i = 0; i < cnt; i++) sum += u[idx + i];
        idx += cnt;
        const r = bestRiceParam(sum, cnt, 30);
        params[part] = r.k;
        bits += r.bits + 5;
      }
      if (!best || bits < best.bits) best = { p, params, bits };
    }
    const rice2 = best.params.some((k) => k > 14);
    const paramBits = rice2 ? 5 : 4;
    w.bits(rice2 ? 1 : 0, 2);
    w.bits(best.p, 4);
    const len = n >> best.p;
    let idx = 0;
    for (let part = 0; part < best.params.length; part++) {
      const k = best.params[part];
      const cnt = part === 0 ? len - order : len;
      w.bits(k, paramBits);
      for (let i = 0; i < cnt; i++) {
        const v = u[idx + i];
        const q = Math.floor(v / Math.pow(2, k));
        if (q + 1 + k <= 24) {
          w.bits((1 << k) | (v & ((1 << k) - 1)), q + 1 + k);
        } else {
          w.zeros(q);
          w.bits(1, 1);
          if (k > 0) w.bitsLong(v % Math.pow(2, k), k);
        }
      }
      idx += cnt;
    }
  }

  /** 编码一帧；chans 为 Int32Array 数组，n 为本帧样本数。返回帧字节（内部缓冲的视图）。 */
  encodeFrame(chans, n) {
    const w = this.w;
    w.reset();
    const bps = this.bps;
    // 选择声道模式
    let mode = this.channels === 2 ? 1 : this.channels - 1;
    let plan;
    if (this.channels === 2) {
      const [L, R] = chans;
      const M = this.mid, S = this.side;
      for (let i = 0; i < n; i++) {
        S[i] = L[i] - R[i];
        M[i] = (L[i] + R[i]) >> 1;
      }
      const aL = this.analyze(L, n, bps);
      const aR = this.analyze(R, n, bps);
      const aM = this.analyze(M, n, bps);
      const aS = this.analyze(S, n, bps + 1);
      const options = [
        { mode: 1, bits: aL.bits + aR.bits, subs: [[L, bps, aL], [R, bps, aR]] },
        { mode: 8, bits: aL.bits + aS.bits, subs: [[L, bps, aL], [S, bps + 1, aS]] },
        { mode: 9, bits: aS.bits + aR.bits, subs: [[S, bps + 1, aS], [R, bps, aR]] },
        { mode: 10, bits: aM.bits + aS.bits, subs: [[M, bps, aM], [S, bps + 1, aS]] },
      ];
      plan = options.reduce((a, b) => (b.bits < a.bits ? b : a));
      mode = plan.mode;
    } else {
      plan = { subs: chans.map((c) => [c, bps, this.analyze(c, n, bps)]) };
    }
    // 帧头
    w.bits(0xfff8, 16);
    const bsCode = n === this.blockSize && this.blockSize === 4096 ? 12 : 7;
    w.bits(bsCode, 4);
    w.bits(0, 4); // 采样率取 STREAMINFO
    w.bits(mode, 4);
    w.bits(bps === 24 ? 0b110 : bps === 16 ? 0b100 : 0, 3);
    w.bits(0, 1);
    // UTF-8 帧号
    const fn = this.frameIndex++;
    if (fn < 0x80) w.bits(fn, 8);
    else {
      const nb = fn < 0x800 ? 2 : fn < 0x10000 ? 3 : fn < 0x200000 ? 4 : fn < 0x4000000 ? 5 : 6;
      w.bits(((0xff << (8 - nb)) & 0xff) | (fn >>> (6 * (nb - 1))), 8);
      for (let k = nb - 2; k >= 0; k--) w.bits(0x80 | ((fn >>> (6 * k)) & 0x3f), 8);
    }
    if (bsCode === 7) w.bits(n - 1, 16);
    // CRC-8
    {
      let c = 0;
      const b = w.buf;
      for (let i = 0; i < w.pos; i++) c = CRC8[c ^ b[i]];
      w.bits(c, 8);
    }
    for (const [x, sbps, info] of plan.subs) this.writeSubframe(x, n, sbps, info);
    w.alignByte();
    let c = 0;
    const b = w.buf;
    for (let i = 0; i < w.pos; i++) c = ((c << 8) & 0xffff) ^ CRC16[(c >> 8) ^ b[i]];
    w.bits(c >> 8, 8);
    w.bits(c & 0xff, 8);
    return w.bytes();
  }
}

/** 把字节流切成不超过 chunkSize 的块（宿主单次写文件上限 8 MiB）。 */
class ChunkSink {
  constructor(chunkSize = 8_000_000) {
    this.chunkSize = chunkSize;
    this.chunks = [];
    this.cur = new Uint8Array(chunkSize);
    this.pos = 0;
    this.total = 0;
  }
  write(bytes) {
    let off = 0;
    while (off < bytes.length) {
      const n = Math.min(bytes.length - off, this.chunkSize - this.pos);
      this.cur.set(bytes.subarray(off, off + n), this.pos);
      this.pos += n;
      off += n;
      if (this.pos === this.chunkSize) {
        this.chunks.push(this.cur);
        this.cur = new Uint8Array(this.chunkSize);
        this.pos = 0;
      }
    }
    this.total += bytes.length;
  }
  finish() {
    if (this.pos) this.chunks.push(this.cur.slice(0, this.pos));
    this.cur = null;
    return this.chunks;
  }
}

const defaultYield = () =>
  new Promise((resolve) => {
    // MessageChannel 不受后台计时器节流影响（窗口最小化时也能跑完）
    if (typeof MessageChannel === 'function') {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolve();
      ch.port2.postMessage(0);
    } else setTimeout(resolve, 0);
  });

/**
 * 完整离线流程：增益曲线 → 应用 → 限幅 → FLAC。
 * channels: Float32Array[]（会被就地修改）
 */
export const levelAndEncodeFlac = async ({
  channels,
  sampleRate,
  bitsPerSample = 16,
  settings,
  tags,
  picture,
  onProgress,
  signal,
  yieldFn = defaultYield,
}) => {
  const s = normalizeSettings(settings);
  const n = channels[0].length;
  const check = () => {
    if (signal?.aborted) throw Object.assign(new Error('已取消'), { canceled: true });
  };
  const progress = (p, phase) => onProgress?.(Math.min(1, Math.max(0, p)), phase);

  progress(0, '分析响度');
  const { lufs, hop, hops } = measureLoudnessCurve(channels, sampleRate, SPEEDS[s.speed].window);
  await yieldFn();
  check();
  // 峰值交给后面的前瞻限幅器，这里只加短时护耳
  const gain = computeGainCurve(lufs, s, { shortLufs: windowLufs(hops, 0.4) });
  progress(0.08, '调整音量');
  applyGainCurve(channels, gain, hop);
  await yieldFn();
  check();
  progress(0.15, '限幅保护');
  lookaheadLimit(channels, sampleRate);
  await yieldFn();
  check();

  const bps = bitsPerSample > 16 ? 24 : 16;
  const enc = new FlacEncoder({ sampleRate, channels: channels.length, bitsPerSample: bps, totalSamples: n });
  const sink = new ChunkSink();
  sink.write(enc.header({ tags, picture }));
  const scale = bps === 24 ? 8388607 : 32767;
  const minV = bps === 24 ? -8388608 : -32768;
  const block = enc.blockSize;
  const ints = channels.map(() => new Int32Array(block));
  const dither = bps === 16;
  let lastYield = Date.now();
  for (let start = 0; start < n; start += block) {
    const len = Math.min(block, n - start);
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c];
      const dst = ints[c];
      for (let i = 0; i < len; i++) {
        let v = src[start + i] * scale;
        if (dither) v += Math.random() - Math.random(); // TPDF ±1 LSB
        v = Math.round(v);
        dst[i] = v > scale ? scale : v < minV ? minV : v;
      }
    }
    sink.write(enc.encodeFrame(ints, len));
    if (Date.now() - lastYield > 40) {
      progress(0.15 + 0.85 * (start / n), '编码 FLAC');
      await yieldFn();
      check();
      lastYield = Date.now();
    }
  }
  const chunks = sink.finish();
  progress(1, '完成');
  return {
    chunks,
    bytes: sink.total,
    sampleRate,
    bitsPerSample: bps,
    channels: channels.length,
    gainRange: gain.length ? [Math.min(...gain), Math.max(...gain)] : [0, 0],
  };
};

// ---------- 解码前从文件头读采样率/位深（decodeAudioData 会重采样到上下文采样率） ----------
export const probeAudioFormat = (bytes) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const str = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  // FLAC（可能前面有 ID3）
  let off = 0;
  if (str(0, 3) === 'ID3' && u8.length > 10) {
    off = 10 + ((u8[6] & 0x7f) << 21) + ((u8[7] & 0x7f) << 14) + ((u8[8] & 0x7f) << 7) + (u8[9] & 0x7f);
  }
  if (str(off, 4) === 'fLaC' && u8.length > off + 26) {
    const p = off + 8 + 10;
    const sr = (u8[p] << 12) | (u8[p + 1] << 4) | (u8[p + 2] >> 4);
    const ch = ((u8[p + 2] >> 1) & 7) + 1;
    const bps = (((u8[p + 2] & 1) << 4) | (u8[p + 3] >> 4)) + 1;
    return { format: 'flac', sampleRate: sr, channels: ch, bitsPerSample: bps };
  }
  // WAV
  if (str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE' && u8.length > 36) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    return { format: 'wav', sampleRate: dv.getUint32(24, true), bitsPerSample: dv.getUint16(34, true) };
  }
  const isMp4 = str(4, 4) === 'ftyp';
  // MP3：找第一个帧同步
  const mp3Rates = [
    [11025, 12000, 8000], // MPEG 2.5
    null,
    [22050, 24000, 16000], // MPEG 2
    [44100, 48000, 32000], // MPEG 1
  ];
  for (let i = off; !isMp4 && i < Math.min(u8.length - 4, off + 65536); i++) {
    if (u8[i] === 0xff && (u8[i + 1] & 0xe0) === 0xe0) {
      const ver = (u8[i + 1] >> 3) & 3;
      const layer = (u8[i + 1] >> 1) & 3;
      const sri = (u8[i + 2] >> 2) & 3;
      const bri = u8[i + 2] >> 4;
      if (ver !== 1 && layer !== 0 && sri !== 3 && bri !== 15 && bri !== 0 && mp3Rates[ver]) {
        return { format: 'mp3', sampleRate: mp3Rates[ver][sri], bitsPerSample: 16 };
      }
    }
  }
  // MP4/M4A：找 mp4a / alac / fLaC 采样条目
  for (const tag of ['mp4a', 'alac', 'fLaC']) {
    for (let i = 4; i < Math.min(u8.length - 36, 4 * 1024 * 1024); i++) {
      if (u8[i] === tag.charCodeAt(0) && str(i, 4) === tag) {
        const p = i + 4 + 6 + 2 + 8; // reserved(6) + dataRefIdx(2) + reserved(8)
        const bits = (u8[p + 2] << 8) | u8[p + 3];
        const sr = (u8[p + 8] << 8) | u8[p + 9];
        if (sr >= 8000 && sr <= 192000) {
          return { format: 'm4a', sampleRate: sr, bitsPerSample: tag === 'mp4a' ? 16 : bits || 16 };
        }
      }
    }
  }
  return { format: 'unknown', sampleRate: 44100, bitsPerSample: 16 };
};

/** 浏览器环境：解码 → 处理 → FLAC。返回 levelAndEncodeFlac 的结果。 */
export const processAudioBytes = async (arrayBuffer, options = {}) => {
  const info = probeAudioFormat(new Uint8Array(arrayBuffer, 0, Math.min(arrayBuffer.byteLength, 4 * 1024 * 1024)));
  const sampleRate = Math.min(192000, Math.max(8000, info.sampleRate || 44100));
  options.onProgress?.(0, '解码');
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Offline) throw new Error('当前环境不支持音频解码');
  const ctx = new Offline(2, 1, sampleRate);
  const audio = await ctx.decodeAudioData(arrayBuffer.slice(0));
  const channels = [];
  const chCount = Math.min(2, audio.numberOfChannels);
  for (let c = 0; c < chCount; c++) channels.push(new Float32Array(audio.getChannelData(c)));
  return levelAndEncodeFlac({
    ...options,
    channels,
    sampleRate: audio.sampleRate,
    bitsPerSample: info.bitsPerSample || 16,
  });
};

// ============================================================================
// 插件入口
// ============================================================================

export function activate(ctx) {
  const { defineComponent, h, reactive, ref, onMounted, onBeforeUnmount, watch } = ctx.vue;
  const val = (x) => (x && typeof x === 'object' && 'value' in x ? x.value : x);

  const settings = reactive({ ...DEFAULT_SETTINGS });
  const live = reactive({
    running: false,
    srcLufs: null, // 歌曲本身的短时响度
    outLufs: null, // 加增益后的响度（不含音量滑块）
    gainDb: 0,
    frozen: '',
    error: '',
    monitorSrc: null, // 监视用的原曲响度（关着也有）
    prelisten: '', // 预听状态说明
  });
  let monitorOpen = 0; // 监视页开着几个：均衡器关着时只在看图时订阅

  let disposed = false;
  let subscription = null;
  let gainDb = 0; // 当前应用的增益
  let lastSentDb = null;
  let lastSentAt = 0;
  let energy = null; // 源响度能量 EMA
  let shortE = null; // 0.4 s 短时能量（护耳用）
  let peakHoldDb = -120;
  let lastFrameAt = 0;
  let lastTimePos = null;
  let freezeUntil = 0;
  let lastTrackId = null;
  let lastPlaying = false;
  let coefs = kWeightingCoefs(48000);
  let coefsRate = 48000;

  const setNativeGain = (db) => {
    const api = globalThis.window?.electron?.player;
    if (typeof api?.setNormalizationGain !== 'function') {
      live.error = '当前 EchoMusic 版本没有响度增益接口';
      return;
    }
    const value = Math.round(db * 100) / 100;
    lastSentDb = value;
    lastSentAt = Date.now();
    Promise.resolve(api.setNormalizationGain(value)).catch(() => {});
  };

  // ---------- 和自带音量均衡共存 ----------
  // 两者用的是播放器同一级增益。自带均衡只在切歌/起播/改设置时按整首响度发一次增益，
  // 本插件开着时：不去动它的开关，它发了就立刻用我们的增益盖回去（下面的 reassert）。
  // 本插件关掉时：把增益还给「自带均衡这首歌该有的值」（它没开就是 0），和它内部记的状态一致，不留幽灵增益。
  // 计算公式抄自宿主 PlayerEngine（Vy）：ref 夹在 -20..-8，峰值留 0.5 dB，结果夹在 -40..+9.54 dB。
  const builtinGainDb = () => {
    try {
      if (!ctx.settings?.volumeNormalization) return 0;
      const loud = ctx.player?.store?.currentResolvedAudioLoudness;
      const lufs = Number(loud?.lufs);
      if (!loud || !Number.isFinite(lufs)) return 0;
      const ref = Math.min(-8, Math.max(-20, Number(ctx.settings?.volumeNormalizationLufs ?? -14) || -14));
      let g = ref - lufs;
      const peak = loud.peak;
      if (peak !== null && peak !== undefined && Number.isFinite(Number(peak))) g = Math.min(g, -0.5 - Number(peak));
      return Math.min(20 * Math.log10(3), Math.max(-40, g));
    } catch {
      return 0;
    }
  };

  // 盖回窗口：这段时间里每 40 ms 把我们的增益再发一次，压住自带均衡可能插进来的那一下
  let reassertUntil = 0;
  let reassertTimer = 0;
  const reassert = (ms = 2000) => {
    reassertUntil = Math.max(reassertUntil, Date.now() + ms);
    if (reassertTimer || disposed || !settings.enabled) return;
    reassertTimer = setInterval(() => {
      if (disposed || !settings.enabled || Date.now() > reassertUntil) {
        clearInterval(reassertTimer);
        reassertTimer = 0;
        return;
      }
      setNativeGain(gainDb);
    }, 40);
  };
  ctx.dispose(() => {
    if (reassertTimer) clearInterval(reassertTimer);
  });

  // ---------- 实时控制 ----------
  let energyAt = 0; // 上次更新响度估计的时间
  let snapUntil = 0;
  let soundFrames = 0; // 重置后测到的有声帧数
  const resetLevelState = () => {
    energy = null;
    shortE = null;
    soundFrames = 0;
    peakHoldDb = -120;
  };

  // ---------- 换歌 ----------
  // 无缝播放时，宿主在两首歌交界处直接在原生层换上「自带均衡给下一首的增益」（没开自带均衡就是 0 dB），
  // 而 currentTrackId 要晚一会儿才变。以前要等到 trackId 变了、再冻结 1.2 s、再用上一首的响度估计慢慢挪，
  // 新歌开头就有一段「没均衡」。现在：一发现换歌（播放位置从上一首末尾跳回开头，或 trackId 变了）就
  // ① 立刻把我们的增益重新发一遍（原生层被换掉的增益马上盖回来，测量也重新对得上）；
  // ② 不把上一首的抬高带进新歌（只保留压低）；③ 丢掉上一首的响度估计，头几秒用很快的速度追新歌；
  // ④ 宿主给出新歌的整首响度时直接拿来当起点。
  let transitionAt = 0;
  let transitionFrames = 0; // 换歌后已经测了几帧
  const beginTransition = (now) => {
    slowTrackId = null;
    transitionAt = now;
    transitionFrames = 0;
    resetLevelState();
    freezeUntil = Math.max(freezeUntil, now + 150); // 跳过交界处几帧
    snapUntil = Math.max(snapUntil, now + 3000);
    gainDb = Math.min(gainDb, 0);
    if (!settings.enabled || disposed) return;
    live.gainDb = gainDb;
    setNativeGain(gainDb);
    reassert(2500);
  };
  // 宿主给出新歌整首响度（LUFS + 峰值 dBFS）：换歌后还没测到几帧时，拿它当起点一步到位
  const seedFromMetadata = () => {
    if (!settings.enabled || disposed) return;
    const now = Date.now();
    if (now - transitionAt > 4000 || transitionFrames > 8) return;
    const loud = ctx.player?.store?.currentResolvedAudioLoudness;
    const lufs = Number(loud?.lufs);
    if (!loud || !Number.isFinite(lufs) || lufs < -70) return;
    const peak = Number(loud.peak);
    if (loud.peak != null && Number.isFinite(peak)) peakHoldDb = Math.max(peakHoldDb, peak);
    energy = Math.pow(10, (lufs + 0.691) / 10);
    energyAt = now;
    gainDb = targetGainDb(lufs, currentVolDb());
    live.gainDb = gainDb;
    setNativeGain(gainDb);
    reassert(1500);
  };

  const currentVolDb = () => {
    const volume = Number(val(ctx.player?.volume) ?? 100);
    return volume > 0.5 ? 20 * Math.log10(volume / 100) : 0;
  };

  // 源响度 → 目标增益（含防削波和上下限）
  const targetGainDb = (src, volDb) => {
    let target = desiredGainDb(src, settings);
    // 防削波：峰值 + 增益 + 音量 不超过约 0.5 dBFS（输出端还有软限幅兜底）
    target = Math.min(target, 0.5 - (peakHoldDb + volDb));
    return Math.max(-settings.maxCut, Math.min(settings.maxBoost, target));
  };

  // ---------- 预听（A）：后台把整首歌先听一遍，知道哪里要变响，提前轻轻推推子 ----------
  // 规矩：不跟播放抢——起播后等几秒再开始；下载期间播放器一卡（加载中）或者 25 s 还没下完就放弃，
  // 这首歌放完之前都只用实时模式（B），下一首再试。预听没好之前、做不了的歌，一直用实时模式顶着。
  const PRELISTEN_DELAY_MS = 4000;
  const PRELISTEN_TIMEOUT_MS = 25000;
  const analyses = new Map(); // trackId → 分析结果（最近 8 首）
  const failedTracks = new Set();
  let prelistenJob = null; // { trackId, controller, reason }
  let slowTrackId = null; // 这首因为网慢 / 卡顿放弃了预听；换歌（含单曲循环重新开始）时清掉
  let playStartAt = 0;
  const prelistenState = { trackId: null, verdict: '', diff: 0, seconds: 0 };

  const abortPrelisten = (reason) => {
    if (!prelistenJob) return;
    prelistenJob.reason = reason;
    try {
      prelistenJob.controller.abort();
    } catch {}
  };

  const analyzeAudio = async (buffer, signal) => {
    const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
    if (!Offline) throw new Error('当前环境不支持音频解码');
    // 24 kHz 足够算响度：解码更快、占内存更少
    const audio = await new Offline(2, 1, 24000).decodeAudioData(buffer);
    if (signal.aborted) throw new Error('aborted');
    const chans = [audio.getChannelData(0)];
    // 单声道在播放器里是两个声道一样响，按两路算才和实时测量对得上
    chans.push(audio.numberOfChannels > 1 ? audio.getChannelData(1) : chans[0]);
    const m = await measureHops(chans, audio.sampleRate, 400000);
    if (signal.aborted) throw new Error('aborted');
    const peakDb = new Float32Array(m.peak.length);
    for (let i = 0; i < peakDb.length; i++) peakDb[i] = m.peak[i] > 1e-6 ? 20 * Math.log10(m.peak[i]) : -120;
    return { m, short: windowLufs(m, 0.4), peakDb, duration: audio.duration, key: '', lufs: null, gain: null };
  };

  const runPrelisten = async (trackId, url) => {
    const job = { trackId, controller: new AbortController(), reason: '' };
    prelistenJob = job;
    live.prelisten = '预听中…（先用实时模式）';
    const timer = setTimeout(() => abortPrelisten('slow'), PRELISTEN_TIMEOUT_MS);
    try {
      if (typeof ctx.net?.request !== 'function') throw new Error('没有网络接口');
      const res = await ctx.net.request({
        url,
        method: 'GET',
        responseType: 'arrayBuffer',
        maxResponseBytes: 64 * 1024 * 1024,
        timeoutMs: PRELISTEN_TIMEOUT_MS,
        signal: job.controller.signal,
      });
      if (job.reason) throw new Error(job.reason);
      if (!(res?.status >= 200 && res.status < 300)) throw new Error(`HTTP ${res?.status}`);
      clearTimeout(timer);
      const data = res.data instanceof ArrayBuffer ? res.data : res.data?.buffer;
      if (!data) throw new Error('没有数据');
      const a = await analyzeAudio(data, job.controller.signal);
      if (job.reason) throw new Error(job.reason);
      analyses.set(String(trackId), a);
      while (analyses.size > 8) analyses.delete(analyses.keys().next().value);
      if (String(val(ctx.player?.currentTrackId)) === String(trackId)) live.prelisten = '已预听：会提前调音量';
    } catch {
      if (job.reason === 'slow' || job.reason === 'stall') {
        slowTrackId = String(trackId);
        live.prelisten = job.reason === 'stall' ? '播放有点卡，这首歌不预听了，只用实时模式' : '网络较慢，这首歌不预听了，只用实时模式';
      } else if (job.reason === 'track' || job.reason === 'off') {
        live.prelisten = '';
      } else {
        failedTracks.add(String(trackId));
        live.prelisten = '这首歌预听不了，用实时模式';
      }
    } finally {
      clearTimeout(timer);
      if (prelistenJob === job) prelistenJob = null;
    }
  };

  // 每帧调用（很便宜）：条件都满足才开始预听当前这首
  const maybeStartPrelisten = (now, trackId) => {
    if (!settings.enabled || !settings.prelisten || disposed || prelistenJob || trackId == null) return;
    const id = String(trackId);
    if (analyses.has(id) || failedTracks.has(id)) return;
    if (id === slowTrackId) return;
    if (now - transitionAt < PRELISTEN_DELAY_MS || now - playStartAt < PRELISTEN_DELAY_MS) return;
    const store = ctx.player?.store;
    if (!store || String(store.currentTrackId ?? '') !== id) return;
    const url = String(store.currentAudioUrl || '');
    if (!/^https?:\/\//i.test(url)) {
      failedTracks.add(id);
      live.prelisten = '不是在线音源，用实时模式';
      return;
    }
    const dur = Number(val(ctx.player?.duration));
    if (Number.isFinite(dur) && dur > 0 && lastTimePos != null && dur - lastTimePos < 25) return; // 快放完了，不值得
    runPrelisten(trackId, url);
  };

  // 取这首歌的预听曲线（设置或音量变了就按新设置重算，几毫秒）
  const curveFor = (trackId) => {
    if (!settings.prelisten || trackId == null) return null;
    const a = analyses.get(String(trackId));
    if (!a) return null;
    if (prelistenState.trackId !== String(trackId)) Object.assign(prelistenState, { trackId: String(trackId), verdict: '', diff: 0, seconds: 0 });
    const volDb = Math.round(currentVolDb());
    const key = `${settings.minLufs}|${settings.maxLufs}|${settings.maxBoost}|${settings.maxCut}|${settings.speed}|${volDb}`;
    if (a.key !== key) {
      const sp = SPEEDS[settings.speed] || SPEEDS.normal;
      a.lufs = windowLufs(a.m, sp.window);
      const peak = new Float32Array(a.peakDb.length);
      for (let i = 0; i < peak.length; i++) peak[i] = a.peakDb[i] + volDb; // 峰值上限要算上音量
      a.gain = computeGainCurve(a.lufs, settings, { shortLufs: a.short, peakDb: peak });
      a.key = key;
    }
    return a;
  };
  const curveAt = (arr, pos) => {
    if (!arr || !Number.isFinite(pos)) return 0;
    const x = Math.max(0, pos / HOP_SECONDS - 0.5);
    const k = Math.min(arr.length - 1, Math.floor(x));
    const t = Math.min(1, x - k);
    return k + 1 < arr.length ? arr[k] + (arr[k + 1] - arr[k]) * t : arr[k];
  };
  const curveGainAt = (a, pos) => curveAt(a.gain, pos);
  const curveLufsAt = (a, pos) => curveAt(a.lufs, pos);
  // 核对：实时测到的段落响度和预听算的应该差不多；持续差 6 dB 以上说明不是同一段音频（换了音源等），不用它
  const checkCurve = (a, liveLufs, sp, dt) => {
    if (prelistenState.verdict) return;
    const expect = curveLufsAt(a, (lastTimePos ?? 0) - sp.window); // 实时估计是滞后的
    if (expect < GATE_LUFS) return;
    const k = 1 - Math.exp(-dt / 5);
    prelistenState.diff += (liveLufs - expect - prelistenState.diff) * k;
    prelistenState.seconds += dt;
    if (prelistenState.seconds < 12) return;
    if (Math.abs(prelistenState.diff) > 6) {
      prelistenState.verdict = 'bad';
      live.prelisten = '预听结果和实际播放对不上，改用实时模式';
    } else prelistenState.verdict = 'ok';
  };

  // ---------- 监视页用的「歌曲时间轴」记录 ----------
  // 按歌曲播放位置（不是现实时间）存，每 0.1 秒一格：拖进度条、暂停都不会错位。
  // 不放进 reactive：每秒写 30 次，没必要触发 Vue 更新。
  const TL_STEP = 0.1;
  const timeline = { trackId: null, src: [], out: [], lastIdx: -1 };
  let dispSrcE = null; // 监视用的轻度平滑（0.3 s），只为曲线好看，不参与控制
  let dispOutE = null;
  // 播放头：最近一帧的位置 + 收到它的时刻，绘制时据此插值，60 fps 顺滑移动
  const playhead = { pos: null, at: 0, playing: false, rate: 1 };

  const resetTimeline = (trackId) => {
    timeline.trackId = trackId;
    timeline.src = [];
    timeline.out = [];
    timeline.lastIdx = -1;
    dispSrcE = null;
    dispOutE = null;
  };

  // outLufs 为 null：均衡器关着，只记原曲
  const recordTimeline = (pos, srcLufs, outLufs, dt) => {
    if (!Number.isFinite(pos) || pos < 0) return;
    const k = 1 - Math.exp(-dt / 0.3);
    const es = Math.pow(10, (srcLufs + 0.691) / 10);
    dispSrcE = dispSrcE == null ? es : dispSrcE + (es - dispSrcE) * k;
    if (outLufs == null) dispOutE = null;
    else {
      const eo = Math.pow(10, (outLufs + 0.691) / 10);
      dispOutE = dispOutE == null ? eo : dispOutE + (eo - dispOutE) * k;
    }
    const s = Math.max(-70, energyToLufs(dispSrcE));
    const o = dispOutE == null ? null : Math.max(-70, energyToLufs(dispOutE));
    live.monitorSrc = s;
    const idx = Math.floor(pos / TL_STEP);
    // 正常播放时补上相邻的空格（帧率抖动），跳跃（拖动）时不连线
    const from = timeline.lastIdx >= 0 && idx > timeline.lastIdx && idx - timeline.lastIdx <= 5 ? timeline.lastIdx + 1 : idx;
    for (let i = from; i <= idx; i++) {
      timeline.src[i] = s;
      timeline.out[i] = o;
    }
    timeline.lastIdx = idx;
  };

  const onFrame = (frame) => {
    if (disposed || !frame) return;
    const now = Date.now();
    const dt = lastFrameAt ? Math.min(0.5, (now - lastFrameAt) / 1000) : 1 / 30;
    lastFrameAt = now;

    const playing = Boolean(val(ctx.player?.isPlaying)) && frame.state === 'playing';
    const loading = Boolean(val(ctx.player?.isLoading));
    const trackId = val(ctx.player?.currentTrackId) ?? null;
    const volume = Number(val(ctx.player?.volume) ?? 100);
    const fadeMs = ctx.settings?.volumeFade ? Number(ctx.settings?.volumeFadeTime) || 300 : 0;

    const rateNow = Number(val(ctx.player?.playbackRate)) || 1;
    const posNow = Number.isFinite(frame.timePos) ? frame.timePos : Number(val(ctx.player?.currentTime));
    // 换歌模式（无缝 / 淡入淡出 / 自然衔接 / 节奏融合）都走「预备下一首」：交界处原生层直接换上
    // 自带均衡给下一首的增益，播放位置从上一首末段跳回新歌开头（可能跳过开头静音，所以放宽到 20 s），
    // trackId 可能早一点也可能晚一点变。两件事谁先到都算换歌；位置跳回时增益一定被换掉了，必须重发。
    const dur = Number(val(ctx.player?.duration));
    const wrapped =
      Number.isFinite(posNow) &&
      lastTimePos != null &&
      posNow < 20 &&
      lastTimePos - posNow > 3 &&
      (!Number.isFinite(dur) || dur <= 0 || lastTimePos > dur - 20 || now - transitionAt < 5000); // trackId 先变时时长可能已是新歌的
    const recent = now - transitionAt < 3000;
    if (trackId !== lastTrackId) {
      lastTrackId = trackId;
      if (!recent) beginTransition(now);
      else if (settings.enabled) reassert(2500); // 刚处理过这次换歌：只盖回自带均衡此刻可能发的增益
    } else if (wrapped) {
      if (!recent) beginTransition(now);
      else if (settings.enabled) {
        // trackId 先变、原生层后换：之前测到的还是上一首的尾巴，清掉重测；
        // 有新歌的整首响度就拿来当起点；被换掉的增益再发回去
        transitionAt = now;
        transitionFrames = 0;
        resetLevelState();
        freezeUntil = Math.max(freezeUntil, now + 150);
        snapUntil = Math.max(snapUntil, now + 3000);
        seedFromMetadata();
        setNativeGain(gainDb);
        reassert(2500);
      }
    }
    if (timeline.trackId !== trackId) resetTimeline(trackId);
    if (playing && !lastPlaying) {
      freezeUntil = Math.max(freezeUntil, now + Math.max(700, fadeMs + 400));
      playStartAt = now;
    }
    // 预听：换歌了就停掉上一首的；下载期间播放器卡住（加载中）就放弃，别跟播放抢网速
    if (prelistenJob) {
      if (String(prelistenJob.trackId) !== String(trackId)) abortPrelisten('track');
      else if (loading) abortPrelisten('stall');
    } else if (playing && !loading) maybeStartPrelisten(now, trackId);
    // 换歌后冻结（起播淡入）结束了也还要快追一阵
    if (now - transitionAt < 4000) snapUntil = Math.max(snapUntil, freezeUntil + 2500);
    lastPlaying = playing;
    if (Number.isFinite(posNow) && lastTimePos != null && playing) {
      const jump = Math.abs(posNow - lastTimePos - dt * rateNow);
      if (jump > 1.5 && !wrapped) {
        freezeUntil = Math.max(freezeUntil, now + 800); // 拖动进度
        dispSrcE = null;
        dispOutE = null;
        timeline.lastIdx = -1;
      }
    }
    lastTimePos = Number.isFinite(posNow) ? posNow : null;
    // 播放器上报的位置几 Hz 才变一次：只在值真的变了时记时间戳，否则插值会「停—跳—停」
    if (lastTimePos != null) {
      if (lastTimePos !== playhead.pos) Object.assign(playhead, { pos: lastTimePos, at: performance.now() });
      playhead.playing = playing;
      playhead.rate = rateNow;
    }

    const volDb = volume > 0.5 ? 20 * Math.log10(volume / 100) : null;
    if (!playing || loading || volDb === null) {
      live.frozen = !playing ? '暂停中' : loading ? '加载中' : '已静音';
      return;
    }

    // 测这一帧的响度（播放器输出 = 源 × 当前增益 × 音量）
    const rate = Number(frame.sampleRate) || 48000;
    if (rate !== coefsRate) {
      coefs = kWeightingCoefs(rate);
      coefsRate = rate;
    }
    let ms;
    if (Array.isArray(frame.waveform) && frame.waveform.length >= 512) {
      // 快照是两个声道里绝对值较大的那一路；按双声道相同近似，能量 ×2
      ms = 2 * biquadMeanSquare(frame.waveform, coefs, Math.min(480, frame.waveform.length >> 2));
    } else {
      ms = 2 * (Number(frame.rms) || 0) ** 2;
    }
    // 用上一次真正发给播放器的增益扣除（增益在输出端按缓冲区平滑生效，误差很小）
    // 关着时增益是自带均衡设的（没开就是 0），按它的公式算出来扣掉
    const appliedDb = settings.enabled ? lastSentDb ?? 0 : builtinGainDb();
    const measuredLufs = energyToLufs(ms);
    const srcInstant = measuredLufs - appliedDb - volDb;
    const peakDb = (Number(frame.peak) || 0) > 1e-6 ? 20 * Math.log10(frame.peak) - appliedDb - volDb : -120;
    peakHoldDb = peakDb > peakHoldDb ? peakDb : peakHoldDb - dt * 2; // 峰值保持，每秒回落 2 dB
    // 监视曲线：灰 = 歌曲本身，橙 = 实际听到的（已含增益、不含音量滑块），都是这一刻真实测到的
    recordTimeline(lastTimePos, srcInstant, settings.enabled ? measuredLufs - volDb : null, dt);
    const frozenNow = now < freezeUntil;
    const fast = now < snapUntil; // 刚打开且还没有响度估计：先用很快的速度追上
    const sp = SPEEDS[settings.speed] || SPEEDS.normal;
    // 响度估计关着也一直在算（订阅着的话），这样一打开就能直接用对的增益
    if (!frozenNow && srcInstant >= GATE_LUFS) {
      const e = Math.pow(10, (srcInstant + 0.691) / 10);
      energy = energy == null ? e : energy + (e - energy) * (1 - Math.exp(-dt / (fast ? 0.25 : sp.window)));
      energyAt = now;
      transitionFrames++;
      soundFrames++;
    }
    // 短时响度（0.4 s），只用来护耳。以前按单帧（约 40 ms）判断：一个鼓点就触发猛压、再慢慢放回来，
    // 副歌里一拍一拍地忽大忽小。0.4 s 能躲开单个鼓点，真正突然变很响时仍然半秒内压住。
    if (srcInstant >= GATE_LUFS || shortE != null) {
      const e = Math.pow(10, (Math.max(srcInstant, -70) + 0.691) / 10);
      shortE = shortE == null ? e : shortE + (e - shortE) * (1 - Math.exp(-dt / 0.4));
    }
    const shortLufs = shortE == null ? -120 : energyToLufs(shortE);
    const blastLimit = settings.maxLufs + BLAST_DB;
    // 返回 true 表示这一帧护耳动作改了增益
    const guardEars = () => {
      if (shortLufs < GATE_LUFS || shortLufs + gainDb <= blastLimit) return false;
      gainDb = Math.max(-settings.maxCut, blastLimit - 2 - shortLufs);
      return true;
    };

    // 预听结果：只在它和这首歌对得上时用
    const curve = curveFor(trackId);
    if (curve && !frozenNow && srcInstant >= GATE_LUFS && energy != null) checkCurve(curve, energyToLufs(energy), sp, dt);

    if (!settings.enabled) {
      live.frozen = '';
      return; // 只画图，不碰增益
    }

    if (frozenNow) {
      live.frozen = '切歌/起播稳定中';
      if (guardEars()) {
        live.gainDb = gainDb;
        setNativeGain(gainDb);
      }
      return;
    }
    live.frozen = '';

    const usable = curve && prelistenState.verdict !== 'bad' ? curve : null;
    if (usable) {
      // 预听模式：照着整首歌的「推推子」曲线走。原生增益按缓冲区生效，往前看 0.25 s 对齐
      const target = Math.min(curveGainAt(usable, lastTimePos + 0.25), 0.5 - (peakHoldDb + volDb));
      gainDb += (target - gainDb) * (1 - Math.exp(-dt / 0.08));
      guardEars();
      live.srcLufs = curveLufsAt(usable, lastTimePos);
    } else {
      // 实时模式（柔和压缩）
      if (energy == null) return;
      const src = energyToLufs(energy);
      let target = targetGainDb(src, volDb);
      // 刚开始听这首（< 2 s 有声音）或者最后 15 s：只压不抬——淡入的前奏、淡出的尾巴不该被抬起来
      const durNow = Number(val(ctx.player?.duration));
      const nearEnd = Number.isFinite(durNow) && durNow > 30 && lastTimePos != null && durNow - lastTimePos < 15;
      if (soundFrames < 60 || nearEnd) target = Math.min(target, Math.max(gainDb, 0));
      if (srcInstant >= GATE_LUFS) {
        // 快追只用来往下压；往上抬一律慢慢来（不然淡入的前奏会被猛抬，正歌一进来就太响）
        const tau = target < gainDb ? (fast ? 0.1 : sp.attack) : sp.release;
        gainDb += (target - gainDb) * (1 - Math.exp(-dt / tau));
      }
      guardEars();
      live.srcLufs = src;
    }

    if (lastSentDb === null || Math.abs(gainDb - lastSentDb) >= 0.05 || now - lastSentAt > 1000) {
      setNativeGain(gainDb);
    }
    live.outLufs = live.srcLufs == null ? null : live.srcLufs + gainDb;
    live.gainDb = gainDb;
  };

  const subscribe = () => {
    if (subscription) return;
    const options = { fps: 30, binCount: 8, includeWaveform: true };
    const raw = globalThis.window?.electron?.audioSpectrum;
    try {
      if (typeof raw?.subscribe === 'function') {
        // 直接订阅：宿主的托管订阅会在窗口最小化时暂停，而均衡器最小化时也得继续工作
        const handle = raw.subscribe(options, (frame) => {
          try {
            onFrame(frame);
          } catch (error) {
            live.error = String(error?.message || error);
          }
        }, { pluginId: ctx.manifest?.id });
        subscription = () => handle?.dispose?.();
      } else {
        subscription = ctx.audio.spectrum.subscribe(options, onFrame);
      }
      live.running = true;
    } catch (error) {
      live.error = `无法读取播放电平：${error?.message || error}`;
    }
  };

  const unsubscribe = () => {
    try {
      subscription?.();
    } catch {}
    subscription = null;
    live.running = false;
  };

  // 开着 → 一直订阅；关着 → 只在监视页打开时订阅（只画原曲）
  const syncSubscription = () => {
    if (disposed) return;
    if (settings.enabled || monitorOpen > 0) subscribe();
    else unsubscribe();
  };

  // 打开：直接从「对的增益」开始，不从 0 慢慢爬（否则会有一瞬间听到没均衡的音量）
  const start = () => {
    const now = Date.now();
    const base = builtinGainDb(); // 此刻播放器上实际的增益（自带均衡的或 0）
    lastSentDb = base;
    lastTrackId = val(ctx.player?.currentTrackId) ?? null; // 不当成切歌，不进 1.2 s 冻结
    const curve = curveFor(lastTrackId);
    if (curve && lastTimePos != null && prelistenState.verdict !== 'bad') {
      // 这首歌已经预听过：直接照曲线
      gainDb = curveGainAt(curve, lastTimePos + 0.25);
      snapUntil = 0;
    } else if (energy != null && now - energyAt < 1500) {
      // 关着时监视页一直在测：响度已知，一步到位
      gainDb = targetGainDb(energyToLufs(energy), currentVolDb());
      snapUntil = 0;
    } else {
      // 没有现成的响度：从当前实际增益出发（不跳变），头 2 秒用很快的速度追到目标
      resetLevelState();
      gainDb = base;
      snapUntil = now + 2000;
    }
    live.gainDb = gainDb;
    subscribe();
    setNativeGain(gainDb);
    reassert(600);
  };

  // 关闭：增益立刻还给自带均衡这首歌该有的值（没开就是 0），不留「幽灵」均衡
  const stop = () => {
    abortPrelisten('off');
    live.prelisten = '';
    syncSubscription();
    reassertUntil = 0;
    snapUntil = 0;
    live.gainDb = 0;
    live.srcLufs = null;
    live.outLufs = null;
    setNativeGain(builtinGainDb());
  };

  const saveSettings = async (patch) => {
    const wasEnabled = settings.enabled;
    Object.assign(settings, normalizeSettings({ ...settings, ...patch }));
    await ctx.storage.set('settings', { ...settings });
    if (!settings.prelisten) {
      abortPrelisten('off');
      live.prelisten = '';
    }
    if (settings.enabled && !wasEnabled) await start();
    else if (!settings.enabled && wasEnabled) await stop();
  };

  const toggle = async () => {
    await saveSettings({ enabled: !settings.enabled });
    ctx.toast.success(settings.enabled ? '小克音量均衡器已开启' : '小克音量均衡器已关闭');
  };

  // 自带均衡可能发增益的时机：切歌、换音源/响度数据、起播、改它的开关或目标响度 → 开盖回窗口
  if (typeof watch === 'function') {
    const stops = [
      [() => val(ctx.player?.currentTrackId), 2500],
      [() => ctx.player?.store?.currentResolvedAudioLoudness, 1500, seedFromMetadata],
      [() => val(ctx.player?.isPlaying), 1500],
      [() => ctx.settings?.volumeNormalization, 1500],
      [() => ctx.settings?.volumeNormalizationLufs, 1500],
    ].map(([getter, ms, extra]) => {
      try {
        return watch(getter, () => {
          if (!settings.enabled || disposed) return;
          extra?.();
          reassert(ms);
        });
      } catch {
        return null;
      }
    });
    ctx.dispose(() => stops.forEach((s) => s?.()));
  }

  ctx.dispose(() => {
    disposed = true;
    abortPrelisten('off');
    unsubscribe();
    if (globalThis.__ClaudeVolumeLeveler?.owner === leveler.owner) delete globalThis.__ClaudeVolumeLeveler;
    if (settings.enabled) setNativeGain(builtinGainDb());
    try {
      rangeStyleEl?.remove();
    } catch {}
  });

  (async () => {
    Object.assign(settings, normalizeSettings(await ctx.storage.get('settings')));
    if (disposed) return;
    // 1.1.0 及以前会替用户关掉自带均衡：现在不再动它，把当时关掉的还回去（只做一次）
    if (await ctx.storage.get('builtinWasOn')) {
      await ctx.storage.set('builtinWasOn', false);
      try {
        if (ctx.settings && !ctx.settings.volumeNormalization) ctx.settings.volumeNormalization = true;
      } catch {}
    }
    if (settings.enabled) start();
  })();

  // ---------- 给下载器的接口 ----------
  const leveler = {
    owner: Symbol('Claude-Volume-Leveler'),
    apiVersion: API_VERSION,
    version: ctx.manifest?.version || '1.0.0',
    name: '小克音量均衡器',
    getSettings: () => ({ ...settings }),
    /** arrayBuffer: 原始音频文件；返回 { chunks: Uint8Array[], bytes, ... }，FLAC 格式 */
    processToFlac: (arrayBuffer, options = {}) =>
      processAudioBytes(arrayBuffer, { ...options, settings: options.settings || { ...settings } }),
  };
  globalThis.__ClaudeVolumeLeveler = leveler;

  // ---------- UI ----------
  const fmt = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
  const fmtGain = (v) => (Math.abs(v) < 0.05 ? '0.0' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`);
  const smallBtn =
    'padding:3px 10px;border-radius:6px;border:1px solid var(--color-border, #8884);background:transparent;color:inherit;cursor:pointer;font-size:12px;white-space:nowrap;';
  const activeBtn = smallBtn + 'background:var(--color-primary, #d97757);border-color:transparent;color:#fff;';
  const row = 'display:flex;align-items:center;justify-content:space-between;gap:12px;';
  const PAGE_ID = 'monitor';
  const monitorPath = () => `/main/plugin/${encodeURIComponent(ctx.manifest.id)}/${PAGE_ID}`;
  const openMonitor = () => ctx.router.push(monitorPath());
  // 退出监视页：回到上一页；没有上一页（比如直接打开的）就回首页
  const closeMonitor = () => {
    const before = globalThis.location?.href;
    try {
      if (typeof ctx.router.back === 'function') ctx.router.back();
      else globalThis.history?.back();
    } catch {}
    setTimeout(() => {
      if (globalThis.location?.href === before) ctx.router.push('/');
    }, 250);
  };

  // EchoMusic 的全局样式把原生滑块轨道藏没了：自己画一条看得见的轨道（左边已选部分用主题色）
  const RANGE_CLASS = 'xk-lev-range';
  let rangeStyleEl = null;
  try {
    rangeStyleEl = document.createElement('style');
    rangeStyleEl.textContent = `
.${RANGE_CLASS}{-webkit-appearance:none;appearance:none;width:100%;height:18px;margin:0;padding:0;background:transparent;cursor:pointer;}
.${RANGE_CLASS}:focus{outline:none;}
.${RANGE_CLASS}::-webkit-slider-runnable-track{height:6px;border-radius:3px;border:none;
  background:linear-gradient(to right,var(--color-primary,#d97757) 0,var(--color-primary,#d97757) var(--p,0%),rgba(128,128,128,.32) var(--p,0%),rgba(128,128,128,.32) 100%);}
.${RANGE_CLASS}::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;margin-top:-5px;border-radius:50%;
  background:var(--color-primary,#d97757);border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.35);}
.${RANGE_CLASS}:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 4px rgba(128,128,128,.3);}
.xk-lev-num{width:64px;padding:2px 6px;border-radius:6px;border:1px solid var(--color-border,#8884);background:transparent;color:inherit;
  font:inherit;text-align:right;font-variant-numeric:tabular-nums;outline:none;}
.xk-lev-num:focus{border-color:var(--color-primary,#d97757);}
.xk-lev-num.bad{border-color:#ff3b30;color:#ff3b30;background:rgba(255,59,48,.1);}`;
    document.head.appendChild(rangeStyleEl);
  } catch {}

  // 数值框：只收有效数值；非法时标红，失焦/回车/Esc 时退回上一次的有效值
  const fieldError = (key, v, min, max) => {
    if (!Number.isFinite(v)) return '请输入数字';
    if (v < min || v > max) return `范围 ${min} ~ ${max}`;
    if (key === 'minLufs' && v > settings.maxLufs) return `不能高于最高响度 ${settings.maxLufs}`;
    if (key === 'maxLufs' && v < settings.minLufs) return `不能低于最低响度 ${settings.minLufs}`;
    return '';
  };
  const parseField = (text) => (/^\s*[-+]?(\d+(\.\d*)?|\.\d+)\s*$/.test(text) ? Number(text) : NaN);
  const NumField = defineComponent({
    props: { k: String, min: Number, max: Number, unit: String },
    setup(props) {
      const draft = ref(null); // null = 没在编辑，显示设置里的值
      const shown = () => (draft.value ?? String(settings[props.k]));
      const error = () => (draft.value == null ? '' : fieldError(props.k, parseField(draft.value), props.min, props.max));
      const commit = () => {
        if (draft.value == null) return;
        const v = parseField(draft.value);
        if (!fieldError(props.k, v, props.min, props.max)) {
          const rounded = Math.round(v * 10) / 10;
          if (rounded !== settings[props.k]) saveSettings({ [props.k]: rounded });
        }
        draft.value = null; // 有效就用新值，非法就退回上一次的值
      };
      return () => {
        const err = error();
        return h('span', { style: 'display:inline-flex;align-items:center;gap:6px;' }, [
          err ? h('span', { style: 'font-size:12px;color:#ff3b30;' }, err) : null,
          h('input', {
            class: ['xk-lev-num', err ? 'bad' : ''],
            type: 'text',
            inputmode: 'decimal',
            value: shown(),
            title: `${props.min} ~ ${props.max}`,
            onInput: (e) => {
              draft.value = e.target.value;
            },
            onBlur: commit,
            onKeydown: (e) => {
              if (e.key === 'Enter') e.target.blur();
              else if (e.key === 'Escape') {
                draft.value = null;
                e.target.value = String(settings[props.k]);
                e.target.blur();
              }
            },
          }),
          h('span', { style: 'opacity:.75;' }, props.unit),
        ]);
      };
    },
  });

  const slider = (label, key, min, max, step, unit, hint) =>
    h('div', { style: 'display:grid;gap:6px;' }, [
      h('div', { style: row }, [h('span', label), h(NumField, { k: key, min, max, unit })]),
      h('input', {
        type: 'range',
        class: RANGE_CLASS,
        min,
        max,
        step,
        value: settings[key],
        style: `--p:${(((Math.min(max, Math.max(min, settings[key])) - min) / (max - min)) * 100).toFixed(2)}%;`,
        onInput: (e) => {
          settings[key] = Number(e.target.value);
        },
        onChange: (e) => saveSettings({ [key]: Number(e.target.value) }),
      }),
      hint ? h('div', { style: 'font-size:12px;opacity:.55;' }, hint) : null,
    ]);

  const statusLine = () => {
    if (!settings.enabled) return '已关闭';
    if (live.error) return `出错：${live.error}`;
    if (live.frozen) return `${live.frozen} · 当前增益 ${fmtGain(live.gainDb)} dB`;
    const base = `歌曲响度 ${fmt(live.srcLufs)} → 调整后 ${fmt(live.outLufs)} LUFS · 增益 ${fmtGain(live.gainDb)} dB`;
    return settings.prelisten && live.prelisten ? `${base} · ${live.prelisten}` : base;
  };

  const SettingsPanel = defineComponent({
    setup() {
      return () =>
        h('div', { style: 'display:grid;gap:16px;font-size:13px;' }, [
          h('div', { style: row }, [
            h('span', { style: 'font-weight:600;' }, '启用实时均衡'),
            h(
              'button',
              { style: settings.enabled ? activeBtn : smallBtn, onClick: toggle },
              settings.enabled ? '已开启' : '已关闭',
            ),
          ]),
          h('div', { style: 'font-size:12px;opacity:.7;' }, statusLine()),
          h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;' }, [
            h('span', '预设：'),
            ...Object.entries(PRESETS).map(([id, p]) =>
              h(
                'button',
                {
                  style:
                    settings.minLufs === p.minLufs && settings.maxLufs === p.maxLufs && settings.speed === p.speed
                      ? activeBtn
                      : smallBtn,
                  onClick: () => saveSettings({ minLufs: p.minLufs, maxLufs: p.maxLufs, speed: p.speed }),
                },
                p.label,
              ),
            ),
          ]),
          slider('最低响度', 'minLufs', -40, -6, 1, 'LUFS', '比这个还小声的段落会被抬起来'),
          slider('最高响度', 'maxLufs', -40, -6, 1, 'LUFS', '比这个还大声的段落会被压下去（-14 ≈ 流媒体标准音量）'),
          h('div', { style: row }, [
            h('span', '反应速度'),
            h(
              'select',
              {
                style:
                  'padding:4px 8px;border-radius:6px;border:1px solid var(--color-border, #8884);background:transparent;color:inherit;',
                value: settings.speed,
                onChange: (e) => saveSettings({ speed: e.target.value }),
              },
              Object.entries(SPEEDS).map(([id, s]) => h('option', { value: id, selected: settings.speed === id }, s.label)),
            ),
          ]),
          h('div', { style: 'display:grid;gap:4px;' }, [
            h('div', { style: row }, [
              h('span', '预听整首歌（更自然）'),
              h(
                'button',
                { style: settings.prelisten ? activeBtn : smallBtn, onClick: () => saveSettings({ prelisten: !settings.prelisten }) },
                settings.prelisten ? '已开启' : '已关闭',
              ),
            ]),
            h(
              'div',
              { style: 'font-size:12px;opacity:.55;line-height:1.6;' },
              '每首歌开始几秒后在后台把整首歌听一遍，知道哪里要变响，就提前轻轻把音量带下来，不会先炸一下再缩。' +
                '预听好之前、网太慢或播放卡顿时，自动只用实时模式（柔和压缩）。会多下载一遍正在听的歌。',
            ),
          ]),
          slider('最多抬高', 'maxBoost', 0, 24, 1, 'dB', '太大会把很安静的前奏、底噪也抬起来'),
          slider('最多压低', 'maxCut', 0, 30, 1, 'dB'),
          h(
            'p',
            { style: 'margin:0;opacity:.65;line-height:1.6;' },
            '音量滑块仍然是总音量：插件只管把歌曲本身的响度压在上面这个范围里。不会去动自带的「音量均衡」开关：本插件开着时由它说了算，关掉后就回到自带均衡（或原始音量）。',
          ),
          h('div', { style: 'display:flex;justify-content:center;' }, [
            h('button', { style: smallBtn + 'padding:6px 18px;font-size:13px;', onClick: openMonitor }, '打开实时监视'),
          ]),
        ]);
    },
  });

  ctx.ui.settings.define({ title: '小克音量均衡器设置', component: SettingsPanel });

  // 实时监视页：跟着歌曲进度走的响度曲线，屏幕宽度 = 30 秒
  const SPAN = 30;
  const fmtTime = (sec) => {
    const s = Math.max(0, Math.floor(sec));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const MonitorPage = defineComponent({
    setup() {
      const canvas = ref(null);
      let raf = 0;
      const clock = { t: null, at: 0 };
      const draw = () => {
        raf = requestAnimationFrame(draw);
        const el = canvas.value;
        if (!el) return;
        const dpr = window.devicePixelRatio || 1;
        const w = el.clientWidth;
        const hgt = el.clientHeight;
        if (el.width !== Math.round(w * dpr)) el.width = Math.round(w * dpr);
        if (el.height !== Math.round(hgt * dpr)) el.height = Math.round(hgt * dpr);
        const g = el.getContext('2d');
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        g.clearRect(0, 0, w, hgt);
        const top = 0, bottom = -45; // 上限 0：有的歌片段能响到 -5 以上
        const y = (l) => ((top - Math.max(bottom, Math.min(top, l))) / (top - bottom)) * hgt;
        const style = getComputedStyle(el);
        const text = style.color || '#888';
        // 目标范围
        g.fillStyle = 'rgba(217,119,87,0.16)';
        g.fillRect(0, y(settings.maxLufs), w, y(settings.minLufs) - y(settings.maxLufs));
        g.strokeStyle = 'rgba(128,128,128,0.25)';
        g.fillStyle = text;
        g.globalAlpha = 0.6;
        g.font = '11px sans-serif';
        g.lineWidth = 1;
        for (let l = -10; l >= -40; l -= 10) {
          g.beginPath();
          g.moveTo(0, y(l));
          g.lineTo(w, y(l));
          g.stroke();
          g.fillText(`${l}`, 4, y(l) - 3);
        }
        g.globalAlpha = 1;

        // ---- 时间轴：和歌曲进度条同一个时间 ----
        const duration = Number(val(ctx.player?.duration)) || 0;
        const storeTime = Number(val(ctx.player?.currentTime));
        // 自己走的时钟：每帧按真实流逝时间前进，再轻轻往播放器上报的位置靠（误差 >1 s 视为拖动，直接跳过去）
        const nowMs = performance.now();
        const realDt = clock.at ? Math.min(0.1, (nowMs - clock.at) / 1000) : 0;
        clock.at = nowMs;
        const live2 = playhead.pos != null && playhead.playing && nowMs - playhead.at < 1500;
        let reported;
        if (live2) reported = playhead.pos + ((nowMs - playhead.at) / 1000) * playhead.rate;
        else reported = Number.isFinite(storeTime) ? storeTime : playhead.pos ?? 0;
        if (clock.t == null || !live2 || Math.abs(reported - clock.t) > 1) clock.t = reported;
        else clock.t += realDt * playhead.rate + (reported - clock.t) * Math.min(1, realDt * 2);
        let t = clock.t;
        if (duration > 0) t = Math.min(t, duration);
        t = Math.max(0, t);
        // 当前位置固定在正中间；只有开头和结尾那半屏，竖线才会离开中心
        let left = t - SPAN / 2;
        if (duration > SPAN) left = Math.min(left, duration - SPAN);
        left = Math.max(0, left);
        const xOf = (sec) => ((sec - left) / SPAN) * w;

        // 时间刻度
        g.fillStyle = text;
        g.globalAlpha = 0.5;
        g.strokeStyle = 'rgba(128,128,128,0.18)';
        for (let s = Math.ceil(left / 5) * 5; s <= left + SPAN; s += 5) {
          const x = xOf(s);
          g.beginPath();
          g.moveTo(x, 0);
          g.lineTo(x, hgt - 16);
          g.stroke();
          if (s % 10 === 0) g.fillText(fmtTime(s), x + 3, hgt - 4);
        }
        g.globalAlpha = 1;

        // 曲线（只画屏幕里这一段；没播过的地方留空）
        if (timeline.trackId === (val(ctx.player?.currentTrackId) ?? null)) {
          const i0 = Math.max(0, Math.floor(left / TL_STEP) - 1);
          const i1 = Math.ceil((left + SPAN) / TL_STEP) + 1;
          const line = (arr, color, width) => {
            g.strokeStyle = color;
            g.lineWidth = width;
            g.lineJoin = 'round';
            g.beginPath();
            let started = false;
            for (let i = i0; i <= i1; i++) {
              const v = arr[i];
              if (v == null) {
                started = false;
                continue;
              }
              const x = xOf((i + 0.5) * TL_STEP);
              if (!started) g.moveTo(x, y(v));
              else g.lineTo(x, y(v));
              started = true;
            }
            g.stroke();
          };
          line(timeline.src, 'rgba(128,128,128,0.85)', 1.5);
          line(timeline.out, '#d97757', 2.5);
        }

        // 播放头：像录音机那样的一根竖线，上下各一个小圆点
        const px = Math.round(xOf(t)) + 0.5;
        g.strokeStyle = '#ff3b30';
        g.fillStyle = '#ff3b30';
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(px, 6);
        g.lineTo(px, hgt - 6);
        g.stroke();
        for (const cy of [5, hgt - 5]) {
          g.beginPath();
          g.arc(px, cy, 4, 0, Math.PI * 2);
          g.fill();
        }
        g.font = '11px sans-serif';
        const label = fmtTime(t);
        const lw = g.measureText(label).width;
        const lx = px + 8 + lw < w - 4 ? px + 8 : px - 8 - lw;
        g.fillText(label, lx, 22);
      };
      onMounted(() => {
        monitorOpen++;
        syncSubscription();
        raf = requestAnimationFrame(draw);
      });
      onBeforeUnmount(() => {
        cancelAnimationFrame(raf);
        monitorOpen = Math.max(0, monitorOpen - 1);
        syncSubscription();
      });
      return () =>
        h('div', { style: 'padding:24px;display:flex;flex-direction:column;gap:16px;' }, [
          h('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;' }, [
            h('div', [
              h('h2', { style: 'margin:0;font-size:22px;' }, '音量均衡 · 实时监视'),
              h(
                'div',
                { style: 'font-size:12px;opacity:.6;margin-top:4px;' },
                settings.enabled ? statusLine() : '均衡器已关闭（点右下角小天平开启）· 只画原曲响度',
              ),
            ]),
            h('button', { style: smallBtn + 'padding:6px 16px;font-size:13px;', onClick: closeMonitor }, '关闭'),
          ]),
          h('div', { style: 'display:flex;gap:28px;flex-wrap:wrap;' }, (settings.enabled
            ? [
                ['歌曲本身', fmt(live.srcLufs), 'LUFS'],
                ['调整后', fmt(live.outLufs), 'LUFS'],
                ['当前增益', fmtGain(live.gainDb), 'dB'],
                ['目标范围', `${settings.minLufs} ~ ${settings.maxLufs}`, 'LUFS'],
              ]
            : [
                ['歌曲本身', fmt(live.monitorSrc), 'LUFS'],
                ['目标范围（参考）', `${settings.minLufs} ~ ${settings.maxLufs}`, 'LUFS'],
              ]
          ).map(([label, value, unit]) =>
            h('div', [
              h('div', { style: 'font-size:12px;opacity:.6;' }, label),
              h('div', { style: 'font-size:24px;font-variant-numeric:tabular-nums;' }, [
                value,
                h('span', { style: 'font-size:12px;opacity:.6;margin-left:4px;' }, unit),
              ]),
            ]),
          )),
          h('canvas', {
            ref: canvas,
            style: 'width:100%;height:260px;border-radius:12px;border:1px solid var(--color-border, #8883);',
          }),
          h(
            'div',
            { style: 'font-size:12px;opacity:.6;line-height:1.7;' },
            '横轴就是歌曲进度（一屏 30 秒），红色竖线是现在播到的位置，拖进度条它会跟着走。灰线：歌曲本身的响度；橙线：调整后你实际听到的响度（均衡器关着时没有）；橙色区域：你设定的范围。没播过的地方是空的，往回拖能看到刚才的记录。也可以从标题栏「更多应用」里的天平打开这一页。',
          ),
        ]);
    },
  });

  ctx.ui.addPage({ id: PAGE_ID, title: '音量均衡', icon: 'tabler:scale', component: MonitorPage });

  // 标题栏「更多应用」里的天平：打开实时监视
  try {
    ctx.ui.titlebar?.register({
      id: 'leveler-monitor',
      title: '音量实时监视',
      icon: 'tabler:scale',
      tooltip: '小克音量均衡器 · 实时监视',
      defaultPlacement: 'more',
      order: 850,
      onClick: openMonitor,
    });
  } catch (error) {
    console.warn('[小克音量均衡器] 标题栏入口注册失败', error);
  }

  ctx.ui.playerbar.register({
    id: 'leveler-toggle',
    title: '小克音量均衡器',
    icon: 'tabler:scale',
    tooltip: '小克音量均衡器：点击开关',
    defaultPlacement: 'right',
    order: 850,
    badge: () => {
      if (!settings.enabled) return '关';
      return Math.abs(live.gainDb) >= 0.5 ? fmtGain(live.gainDb).replace('.0', '') : null;
    },
    badgeTitle: '当前增益',
    onClick: toggle,
  });
}
