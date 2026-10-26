import { sha256 } from './sha256.js';
import { terrainPixels } from './basemap.js';
import { tilePlan, TILE_CACHE_BYTES } from './clue-tiles.js';

export async function compressedBytes(asset, signal) {
  let response;
  try { response = await fetch(asset.url, { signal }); }
  catch (error) { if (error.name === 'AbortError') throw error; throw new Error('圖資下載中斷，請檢查網路並重試'); }
  if (!response.ok) throw new Error('必要圖資載入失敗，請重試');
  const bytes = await response.arrayBuffer();
  if (await sha256(bytes) !== asset.sha256) throw new Error('圖資雜湊不符，請重試載入');
  if (!globalThis.DecompressionStream) throw new Error('此瀏覽器不支援圖資解壓縮，請使用新版瀏覽器');
  const decoded = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  if (decoded.byteLength !== asset.decodedBytes) throw new Error('圖資資料大小不符，請重試載入');
  return decoded;
}
export async function compressedJSON(asset, signal) {
  return JSON.parse(new TextDecoder().decode(await compressedBytes(asset, signal)));
}
export class SoloAssets {
  constructor(manifest) { this.manifest = manifest; this.cache = new Map(); this.cacheBytes = 0; this.terrain = null; this.tileCache = new Map(); this.tileBytes = 0; this.tileRevision = 0; this.boundaryPacks = new Map(); this.landmarkViews = new Map(); }
  tileKey(bounds, mpp, dpr) {
    if (typeof createImageBitmap !== 'function') return null;
    return tilePlan(this.manifest.clues.tiles, bounds, mpp, dpr)?.level.id || null;
  }
  clearTiles() {
    for (const value of this.tileCache.values()) value.bitmap.close();
    this.tileCache.clear(); this.tileBytes = 0; this.tileRevision++;
  }
  async tileView(bounds, mpp, dpr, signal) {
    const plan = tilePlan(this.manifest.clues.tiles, bounds, mpp, dpr);
    if (!plan) throw new Error('目前視野沒有對應圖塊');
    const layers = [plan, ...(plan.terrain ? [plan.terrain] : [])];
    const downloads = [...new Map(layers.flatMap(layer => layer.tiles.map(tile => [tile.url, { tile, layer }]))).values()];
    const pinned = new Set(downloads.map(t => t.tile.url)), controller = new AbortController();
    const abort = () => controller.abort(signal.reason); signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true });
    let next = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(3, downloads.length) }, async () => {
        while (next < downloads.length) {
          controller.signal.throwIfAborted(); const { tile, layer } = downloads[next++];
          let value = this.tileCache.get(tile.url);
          if (!value) {
            const response = await fetch(tile.url, { signal: controller.signal });
            if (!response.ok) throw new Error('地圖圖塊下載失敗，請重試');
            const bytes = await response.arrayBuffer(); controller.signal.throwIfAborted();
            if (bytes.byteLength !== tile.bytes || await sha256(bytes) !== tile.sha256) throw new Error('地圖圖塊雜湊不符，請重試');
            const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/webp' }));
            if (controller.signal.aborted || bitmap.width !== (layer.size + 2 * layer.gutter) * layer.level.dpr || bitmap.height !== bitmap.width) {
              bitmap.close(); controller.signal.throwIfAborted(); throw new Error('地圖圖塊尺寸不符');
            }
            value = { bitmap, bytes: layer.pixels };
            for (const [key, item] of this.tileCache) {
              if (this.tileBytes + value.bytes <= TILE_CACHE_BYTES) break;
              if (!pinned.has(key)) { this.tileCache.delete(key); this.tileBytes -= item.bytes; item.bitmap.close(); }
            }
            this.tileBytes += value.bytes; this.tileRevision++;
          } else this.tileCache.delete(tile.url);
          this.tileCache.set(tile.url, value);
        }
      }));
      controller.signal.throwIfAborted();
      const key = layers.map(layer => layer.level.id + ':' + layer.tiles.map(t => `${t.x}:${t.y}:${t.url}`).join(',')).join('|') + ':' + this.tileRevision;
      return { ...plan, images: this.tileCache, key };
    } catch (error) { controller.abort(); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }
  async catalog() { return compressedJSON(this.manifest.catalog); }
  async boundaryPack(key) {
    if (!this.boundaryPacks.has(key)) {
      const asset = this.manifest.answerPacks[key];
      if (!asset) throw new Error('範圍邊界資料不完整，請重新載入');
      if (key.startsWith('town-') && key !== `town-${this.townBoundaryCounty}`) return compressedJSON(asset);
      const loading = compressedJSON(asset).catch(error => { if (this.boundaryPacks.get(key) === loading) this.boundaryPacks.delete(key); throw error; });
      this.boundaryPacks.set(key, loading);
    }
    return this.boundaryPacks.get(key);
  }
  async countyBoundaries() {
    if (!this.counties) this.counties = this.boundaryPack('county')
      .then(regions => regions.flatMap(r => r.geometry)).catch(error => { this.counties = null; throw error; });
    return this.counties;
  }
  async landmarkBoundaries({ scope, county, difficulty }) {
    const key = `${scope === 'county' ? county : 'mainland'}:${difficulty}`;
    if (scope === 'county' && difficulty === 'easy' && this.townBoundaryCounty !== county) {
      // A county's detailed town lines can decode to several MB; retain only the latest county.
      this.boundaryPacks.delete(`town-${this.townBoundaryCounty}`); this.landmarkViews.delete(`${this.townBoundaryCounty}:easy`);
      this.townBoundaryCounty = county;
    }
    if (!this.landmarkViews.has(key)) {
      const loading = (async () => {
        if (scope !== 'county') return { scopeOutline: [], internalBoundaries: difficulty === 'easy' ? await this.countyBoundaries() : [] };
        const regions = await this.boundaryPack('county'), selected = regions.find(r => r.id === county);
        if (!selected?.geometry?.length) throw new Error('所選縣市邊界資料不完整，請重新載入');
        const towns = difficulty === 'easy' ? await this.boundaryPack(`town-${county}`) : [];
        return { scopeOutline: selected.geometry, internalBoundaries: towns.flatMap(r => r.geometry) };
      })().catch(error => { if (this.landmarkViews.get(key) === loading) this.landmarkViews.delete(key); throw error; });
      this.landmarkViews.set(key, loading);
    }
    return this.landmarkViews.get(key);
  }
  async terrainCanvas(overview = false) {
    const info = this.manifest.clues, asset = overview ? info.overviewTerrain : info.terrainAsset;
    const bytes = await compressedBytes(asset), { width, height } = overview ? asset : info.terrain;
    if (info.crs !== 'EPSG:3826' || bytes.byteLength !== width * height * (overview ? 4 : 2) || (!overview && await sha256(bytes) !== info.terrainSha256)) throw new Error('地形版本或資料大小不符');
    let pixels = new Uint8ClampedArray(bytes);
    if (!overview) {
      const view = new DataView(bytes), heights = new Uint16Array(bytes.byteLength / 2);
      for (let i = 0; i < heights.length; i++) heights[i] = view.getUint16(i * 2, true);
      pixels = terrainPixels(heights, width, height, info.terrain.cell);
    }
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    return canvas;
  }
  async clues(detail = 0) {
    if (!this.terrain) this.terrain = (async () => {
      const info = this.manifest.clues, overview = Boolean(info.overviewTerrain);
      return { ...info, canvas: await this.terrainCanvas(overview), terrainDetail: overview ? 0 : 1, features: [], generation: 0, bounds: null, detail: -1 };
    })().catch(error => { this.terrain = null; throw error; });
    const clues = await this.terrain;
    if (detail > 0 && clues.terrainDetail === 0) {
      if (!this.fullTerrain) this.fullTerrain = this.terrainCanvas().then(canvas => {
        clues.canvas.width = clues.canvas.height = 0; clues.canvas = canvas; clues.terrainDetail = 1; clues.generation++;
      }).catch(error => { this.fullTerrain = null; throw error; });
      await this.fullTerrain;
    }
    return clues;
  }
  async features(bounds, detail, signal, onProgress = () => {}) {
    const intersects = b => b[0] <= bounds[2] && b[2] >= bounds[0] && b[1] <= bounds[3] && b[3] >= bounds[1];
    const chunks = this.manifest.clues.chunks.filter(c => c.detail <= detail && intersects(c.bounds)), parts = [];
    const controller = new AbortController(), abort = () => controller.abort(signal.reason);
    signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true });
    let next = 0, completed = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, async () => {
        while (next < chunks.length) {
          controller.signal.throwIfAborted(); const index = next++, chunk = chunks[index]; let value = this.cache.get(chunk.url);
          const downloaded = !value;
          if (!value) {
            value = { features: await compressedJSON(chunk, controller.signal), bytes: chunk.decodedBytes };
            controller.signal.throwIfAborted();
            this.cache.set(chunk.url, value); this.cacheBytes += value.bytes;
          } else { this.cache.delete(chunk.url); this.cache.set(chunk.url, value); }
          // Byte budget avoids evicting small visible tiles just because there are more than sixteen.
          while (this.cacheBytes > 32 * 1024 * 1024) {
            const key = this.cache.keys().next().value; this.cacheBytes -= this.cache.get(key).bytes; this.cache.delete(key);
          }
          controller.signal.throwIfAborted(); parts[index] = value.features.filter(f => intersects(f.bounds)); completed++;
          if (downloaded && (completed === 1 || completed % 3 === 0)) onProgress(parts.flat());
        }
      }));
      controller.signal.throwIfAborted();
      return parts.flat();
    } catch (error) { controller.abort(); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }
}
