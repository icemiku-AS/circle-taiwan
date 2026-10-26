export class SoloEngine {
  constructor(manifest, data, ids, landmarkRules) {
    this.init = { manifest, land: data.land, ids, ...(landmarkRules ? { landmarkRules: { ...landmarkRules } } : {}) };
    this.pending = new Map(); this.sequence = 0;
  }
  request(action, payload) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      // Bound a silent worker; the game retains the original points and submission time for retry.
      const timer = setTimeout(() => this.close(new Error('背景計分等候逾時，筆畫已保留，請重試')), 60000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, action, ...payload }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async ready() {
    if (!this.worker) {
      this.worker = new Worker(`/runtime/${this.init.manifest.runtimeVersion}/solo-worker.js`, { type: 'module' });
      this.worker.onmessage = ({ data }) => {
        const pending = this.pending.get(data.id); if (!pending) return;
        clearTimeout(pending.timer); this.pending.delete(data.id); if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data.value);
      };
      this.worker.onerror = event => { event.preventDefault(); this.close(new Error('背景計分停止，筆畫已保留，請重新計分')); };
      this.worker.onmessageerror = () => this.close(new Error('背景計分資料無法讀取，請重試'));
      this.initializing = this.request('init', this.init).catch(error => { this.close(error); throw error; });
    }
    return this.initializing;
  }
  async score(regionId, points, bounds) { await this.ready(); return this.request('score', { regionId, points, bounds }); }
  async prepare(regionId) { await this.ready(); return this.request('prepare', { regionId }); }
  async geometry(regionId) { await this.ready(); return this.request('geometry', { regionId }); }
  close(error = new Error('已取消背景計分')) {
    this.worker?.terminate(); this.worker = null; this.initializing = null;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear();
  }
}
