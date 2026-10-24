export const TILE_CACHE_BYTES = 96 * 1024 * 1024;
export const intersects = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
export const tileLevels = pyramid => pyramid ? [...pyramid.levels, ...(pyramid.terrain?.levels || [])] : [];

export function tilePlan(pyramid, bounds, mpp, dpr = 1) {
  if (!pyramid || !Number.isFinite(mpp) || mpp <= pyramid.minMpp || mpp > pyramid.maxMpp) return null;
  const levels = pyramid.levels.filter(l => l.dpr === (dpr > 1 ? 2 : 1));
  const level = levels.reduce((best, l) => !best || Math.abs(Math.log(l.mpp / mpp)) < Math.abs(Math.log(best.mpp / mpp)) ? l : best, null);
  if (!level) return null;
  const span = pyramid.size * level.mpp, origin = pyramid.origin || [0, 0];
  const tiles = level.tiles.filter(t => intersects([origin[0] + t.x * span, origin[1] + t.y * span, origin[0] + (t.x + 1) * span, origin[1] + (t.y + 1) * span], bounds));
  const pixels = (pyramid.size + 2 * pyramid.gutter) ** 2 * level.dpr ** 2 * 4;
  const terrain = pyramid.terrain ? tilePlan(pyramid.terrain, bounds, 100, 1) : null;
  // Very large displays retain vectors rather than exceed the decoded image budget.
  if (new Set(tiles.map(t => t.url)).size * pixels + (terrain ? new Set(terrain.tiles.map(t => t.url)).size * terrain.pixels : 0) > TILE_CACHE_BYTES) return null;
  return { level, tiles, pixels, size: pyramid.size, gutter: pyramid.gutter, span, origin, terrain };
}

export function drawClueTiles(context, raster, bounds) {
  const { span, level, size, gutter, tiles, images, origin = [0, 0] } = raster, g = gutter * level.dpr, s = size * level.dpr;
  if (raster.terrain) drawClueTiles(context, { ...raster.terrain, images }, bounds);
  for (const tile of tiles) {
    if (!intersects([origin[0] + tile.x * span, origin[1] + tile.y * span, origin[0] + (tile.x + 1) * span, origin[1] + (tile.y + 1) * span], bounds)) continue;
    const image = images.get(tile.url)?.bitmap;
    // The terrain overview remains underneath while a new viewport replaces evicted tiles.
    if (!image) continue;
    context.save(); context.translate(origin[0] + tile.x * span, origin[1] + (tile.y + 1) * span); context.scale(1, -1);
    context.drawImage(image, g, g, s, s, 0, 0, span, span); context.restore();
  }
}
