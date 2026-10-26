# 架構

```mermaid
flowchart LR
  Assets[Cloudflare Static Assets] -->|程式與圖資| UI[瀏覽器 Canvas]
  UI <-->|筆畫與計分| Scoring[瀏覽器 Web Worker]
  UI <-->|房間事件與交卷| API[Cloudflare Workers API]
  API <--> DB[(D1)]
```

| 入口 | 職責 |
| --- | --- |
| `public/app.js`、`map.js` | 畫面、圈選與地圖操作 |
| `public/solo-game.js`、`solo-engine.js`、`solo-worker.js` | 單人狀態與瀏覽器計分 |
| `public/multi-client.js` | 多人預載、交卷、重連與揭曉 |
| `shared/scoring.js`、`rules.js` | 行政區 IoU、景點 S 曲線／點命中與最近距離、遊戲規則與排名 |
| `server/free-rooms.js`、`free-schema.sql` | 房間、玩家與逐題收件 |
| `scripts/build-static.js`、`build-cloudflare.js` | 靜態圖資分包與 Worker 打包 |
| `scripts/prepare-landmarks.js`、`data/landmarks*.json` | 觀光署來源快照、原 100 題、自動縣市精選、離線投影與版本追溯 |

單人與多人都在瀏覽器計分。多人作答期間不做背景輪詢，全員交件後揭曉，由房主進入下一題。D1 保留房間狀態、成績與當題筆跡。

景點中繼資料使用 `level: 'landmark'`、`classicMainland`、`classicCounty`，答案以單一靜態壓縮包 `{ id, kind: 'landmark', point }` 提供。點資料不進入行政區多邊形處理；共用 Worker 依題型選擇 scorer，解包後只保留當局題目。

`scope` 與 `pool` 決定題池，`difficulty` 只決定邊界顯示。全島景點初階重用縣市包；縣市初階再讀取該縣鄉鎮包，高階只有所選外框。背景 canvas 快取邊界，鄉鎮包只保留最近使用的一縣；景點均不載入地形或 OSM 線索。

縣市 `areaM2` 在離線 catalog 建置時計算。`SoloEngine` 初始化保存本局景點規則，全島使用原尺度，縣市 A_max 等於縣市面積；預載、重試、重啟及揭曉比較共用相同規則。API 不取得面積表。結果圖片沿用已載入的外框，不重新下載圖資。

多人交卷欄位維持 `submissionId / points / status / score / elapsed`；API 僅檢查格式及數值範圍，接收瀏覽器成績。面積與最近距離由前端重算供當題比較，不新增 D1 欄位、請求或輪詢頻率。API 建置依賴白名單仍只有入口、`free-rooms.js`、`rules.js`，不載入景點座標或幾何依賴。這是朋友同樂的信任模型，公開答案與前端分數不能防止查題或改分。
