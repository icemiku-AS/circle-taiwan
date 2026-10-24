import { drawPath } from './map.js';

export function challengeScope(data, settings) {
  if (settings.challenge === 'county') return '縣市挑戰 · 台灣本島與核准近岸範圍';
  const region = data.regions.find(r => r.id === (settings.challenge === 'village' ? settings.town : settings.county));
  return `${settings.challenge === 'village' ? '村里' : '鄉鎮'}挑戰 · ${region?.name || '全台灣（遊戲範圍）'}`;
}

export function roundScoreText(result) {
  if (!result) return '—';
  if (result.voided) return `本題作廢${result.status === 'calculation_failed' ? '（計分失敗）' : ''}`;
  const status = { forced_missing: '強制封存缺件', unanswered: '未作答', invalid: '無效筆畫', calculation_failed: '計分失敗' }[result.status];
  return `${result.points ? '+1' : '0'} 點 · ${result.score.toFixed(2)}%${status ? `（${status}）` : ''}`;
}

export function comparisonBounds(target, points) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const ring of [...target.flat(), points]) for (const [x, y] of ring) {
    box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
  }
  const span = Math.max(100, box[2] - box[0], box[3] - box[1]), margin = span * .12;
  return [box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin];
}

export function comparison(context, data, round, playerId, x, y, width, height) {
  const points = round.points, result = round.results[playerId], b = comparisonBounds(round.target, points);
  const scale = Math.min(width / (b[2] - b[0]), height / (b[3] - b[1]));
  context.save(); context.beginPath(); context.rect(x, y, width, height); context.clip();
  context.fillStyle = '#e6e9e3'; context.fillRect(x, y, width, height);
  context.translate(x + width / 2, y + height / 2); context.scale(scale, -scale); context.translate(-(b[0] + b[2]) / 2, -(b[1] + b[3]) / 2);
  const fill = (geometry, color) => { drawPath(context, geometry); context.fillStyle = color; context.fill('nonzero'); };
  fill(data.land, '#f6f4ed');
  for (const [key, color] of [['hit', '#b6975888'], ['extra', '#c56e4666'], ['miss', '#65798e55']]) if (result[key]) fill(result[key], color);
  if (round.neutral?.length) fill(round.neutral, '#D5D5D5');
  context.lineJoin = 'round'; context.lineWidth = 2 / scale;
  if (points.length) { drawPath(context, [[points]]); context.strokeStyle = '#c56e46'; context.stroke(); }
  drawPath(context, round.target); context.strokeStyle = '#3e654e'; context.setLineDash([6 / scale, 4 / scale]); context.stroke();
  context.restore();
}

export function scoreImage(data, state) {
  const mine = state.standings.find(p => p.id === state.you), rows = Math.ceil(state.history.length / 2);
  const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 330 + rows * 430;
  const c = canvas.getContext('2d'); c.fillStyle = '#f2efe7'; c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = '#1f2a23'; c.font = 'bold 40px sans-serif'; c.fillText('圈出台灣｜我的圈選與正確答案', 40, 65);
  c.font = '23px sans-serif'; c.fillText(challengeScope(data, state.settings), 40, 108, 1120);
  c.fillText(`${mine.name}・${state.settings.difficulty === 'easy' ? '初階' : '高階'}・不限時・${state.history.length} 題`, 40, 146, 1120);
  c.font = 'bold 34px sans-serif'; c.fillText(`平均 ${mine.score.toFixed(2)}%　作答 ${mine.time.toFixed(1)} 秒`, 40, 195);
  c.font = '20px sans-serif'; c.fillText('橙色實線：我的圈選　綠色虛線：正確邊界　金色：圈對　灰色：內部中立區', 40, 235);
  state.history.forEach((round, i) => {
    const x = 30 + (i % 2) * 585, y = 260 + Math.floor(i / 2) * 430, r = round.results[state.you];
    c.fillStyle = '#fffdf7'; c.fillRect(x, y, 555, 410); c.fillStyle = '#1f2a23'; c.font = 'bold 22px sans-serif';
    c.fillText(`${i + 1}. ${round.name}`, x + 14, y + 34, 525);
    c.font = '20px sans-serif'; c.fillText(`${r.score.toFixed(2)}%${r.status === 'skipped' ? '・已跳過' : ''}　${(Math.round(r.elapsed / 100) / 10).toFixed(1)} 秒`, x + 14, y + 65);
    comparison(c, data, round, state.you, x + 14, y + 82, 527, 287);
    c.fillStyle = '#657466'; c.font = '15px sans-serif';
    c.fillText(round.neutralNames?.length ? `${round.neutralNames.join('、')}不計分；海面不計分` : '海面不計分；兩條輪廓使用相同位置與比例', x + 14, y + 395, 525);
  });
  c.fillStyle = '#657466'; c.font = '15px sans-serif';
  c.fillText(`行政邊界：內政部國土測繪中心／政府資料開放授權條款第 1 版・${data.manifest.version}・單人內測版`, 40, canvas.height - 22, 1120);
  return canvas;
}

export function multiplayerScoreImage(data, state) {
  const canvas = document.createElement('canvas'), c = canvas.getContext('2d');
  const players = state.standings, groups = Math.ceil(players.length / 4), cellWidth = 840 / Math.min(4, players.length), lineHeight = 26;
  const wrap = (text, width) => {
    const lines = [''];
    for (const char of text) {
      if (lines.at(-1) && c.measureText(lines.at(-1) + char).width > width) lines.push('');
      lines[lines.length - 1] += char;
    }
    return lines;
  };
  const playerName = p => `${p.name}${p.id === state.you ? '（你）' : ''}${players.some(other => other.id !== p.id && other.name === p.name) ? ` #${p.id.slice(0, 4)}` : ''}`;
  c.font = '20px sans-serif';
  const blocks = Array.from({ length: groups }, (_, group) => {
    const entries = players.slice(group * 4, group * 4 + 4);
    const names = entries.map(p => wrap(playerName(p), cellWidth - 24));
    const rows = state.history.map((q, index) => {
      const title = wrap(`${index + 1}. ${q.name}`, 245), cells = entries.map(p => wrap(roundScoreText(p.perQuestion[index]), cellWidth - 24));
      return { title, cells, height: 24 + Math.max(title.length, ...cells.map(lines => lines.length)) * lineHeight };
    });
    return { entries, names, rows, headerHeight: 24 + Math.max(...names.map(lines => lines.length)) * lineHeight };
  });
  canvas.width = 1200;
  canvas.height = 330 + players.length * 64 + blocks.reduce((height, block) => height + 60 + block.headerHeight + block.rows.reduce((sum, row) => sum + row.height, 0), 0) + 65;
  c.fillStyle = '#f2efe7'; c.fillRect(0, 0, canvas.width, canvas.height);
  c.fillStyle = '#1f2a23'; c.font = 'bold 40px sans-serif'; c.fillText('圈出台灣｜多人結算', 40, 65);
  c.font = '23px sans-serif'; c.fillText(challengeScope(data, state.settings), 40, 108, 1120);
  c.fillText(`${state.settings.difficulty === 'easy' ? '初階' : '高階'} · ${state.history.length} 題 · 每題 ${state.settings.seconds} 秒 · ${players.length} 人`, 40, 146);
  c.font = '19px sans-serif'; c.fillText('原始吻合度 > 50% 得 1 點；同分依平均、總時間排序。作廢題不計入積分、平均與時間。', 40, 187, 1120);
  if (players.every(p => p.rank == null)) { c.fillStyle = '#8c3b19'; c.fillText('本局無有效題，不產生名次。', 40, 221); }
  c.fillStyle = '#657466'; c.font = '20px sans-serif';
  ['名次', '玩家', '達標積分', '平均吻合度', '總作答時間'].forEach((text, i) => c.fillText(text, [40, 128, 640, 815, 1005][i], 270));
  let y = 310;
  players.forEach(p => {
    c.fillStyle = '#1f2a23'; c.font = 'bold 25px sans-serif';
    c.fillText(p.rank == null ? '—' : `#${p.rank}`, 40, y);
    c.fillStyle = p.color; c.fillText(playerName(p), 128, y, 450);
    c.fillStyle = '#1f2a23'; c.fillText(`${p.points} 點`, 640, y);
    c.font = '23px sans-serif'; c.fillText(p.score == null ? '—' : `${p.score.toFixed(2)}%`, 815, y);
    c.fillText(p.time == null ? '—' : `${p.time.toFixed(1)} 秒`, 1005, y);
    c.strokeStyle = '#d9dfd4'; c.beginPath(); c.moveTo(40, y + 20); c.lineTo(1160, y + 20); c.stroke(); y += 64;
  });
  blocks.forEach((block, index) => {
    y += 30; c.fillStyle = '#1f2a23'; c.font = 'bold 26px sans-serif';
    c.fillText(`逐題成績${groups > 1 ? `（${index * 4 + 1}–${index * 4 + block.entries.length} 位玩家）` : ''}`, 40, y); y += 30;
    c.font = '20px sans-serif';
    block.names.forEach((lines, column) => { c.fillStyle = block.entries[column].color; lines.forEach((line, i) => c.fillText(line, 320 + column * cellWidth, y + 24 + i * lineHeight)); });
    y += block.headerHeight;
    block.rows.forEach(row => {
      c.fillStyle = '#1f2a23'; row.title.forEach((line, i) => c.fillText(line, 40, y + 24 + i * lineHeight));
      row.cells.forEach((lines, column) => lines.forEach((line, i) => c.fillText(line, 320 + column * cellWidth, y + 24 + i * lineHeight)));
      y += row.height; c.strokeStyle = '#d9dfd4'; c.beginPath(); c.moveTo(40, y); c.lineTo(1160, y); c.stroke();
    });
  });
  c.fillStyle = '#657466'; c.font = '15px sans-serif';
  c.fillText(`行政邊界：內政部國土測繪中心／政府資料開放授權條款第 1 版 · ${data.manifest.version}`, 40, canvas.height - 22, 1120);
  return canvas;
}
