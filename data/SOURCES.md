# 資料來源與授權

## 景點題庫轉檔

來源為交通部觀光署的[景點－觀光資訊資料庫](https://data.gov.tw/dataset/7777)，依[政府資料開放授權條款第 1 版](https://data.gov.tw/license)使用。繁體中文下載為 [Attraction-json.zip](https://media.taiwan.net.tw/XMLReleaseAll_public/v2.0/Zh_tw/Attraction-json.zip)。先保存來源快照，再離線轉檔，不在遊玩時呼叫觀光 API。

`scripts/prepare-landmarks.js` 讀取 ZIP 內的 `AttractionList.json`，或已解開的同格式 JSON；根物件須含非空 `Attractions` 陣列。每筆來源紀錄依 [landmarks-source.schema.json](landmarks-source.schema.json) 的必要欄位驗證，經緯度必須為 JSON number。先依有效座標、本島最大連通面與所屬縣市篩選全量紀錄，再套用全島經典 100 題的名稱與錨點覆寫。輸出格式見 [landmarks.schema.json](landmarks.schema.json)。正式題庫 [landmarks.json](landmarks.json) 為 `landmarks-2026-10-26-05`，收錄本島 19 縣市共 5,554 筆，全島 classic 100 題，各縣 classic 自動補足 20 題，排除金門、連江、澎湖及其他分離島嶼。

正式來源快照為 [landmarks-source.zip](landmarks-source.zip)，2026-10-26 取得，3,111,006 bytes、6,182 筆 Attractions；SHA-256 為 `b929a8c8b64f1fa107aedcd04ecaba6e3aba4d10b6213dd652813bc747ba1246`。來源資訊及選題分別保存於 [landmarks-source-info.json](landmarks-source-info.json)、[landmarks-selection.json](landmarks-selection.json)。新批次先在 `.cache/landmarks/` 保存並核對。來源資訊格式如下，時間與雜湊須填入該次快照的實際值；若輸入已解開的 JSON，雜湊也須改為該 JSON 的雜湊。

```json
{
  "sourceUrl": "https://media.taiwan.net.tw/XMLReleaseAll_public/v2.0/Zh_tw/Attraction-json.zip",
  "retrievedAt": "2026-10-26T07:16:03.222Z",
  "sourceSha256": "<來源檔案的 64 位 SHA-256>"
}
```

選題清單 `landmarks-selection.json` 為下列物件的陣列；全島經典 100 題納入 17 個園區／場館替換，保留鹿野高台。縣市 classic 先保留這些題目，再按來源 ID 排序自動補足 20 題，避免同縣同名；不另增人工審查。範例只說明格式；正式收錄前須核對題名、代表點、縣市及遊戲覆蓋範圍。題目優先顯示整理後的 `name`，缺少時才使用 `officialName`；錨點仍保存在資料中，玩法說明交代代表點判定。大型景區採官方代表點時不能未查核就改稱某個入口或核心設施。

```json
[
  {
    "id": "lm-taipei-101",
    "recordId": "Attraction_379000000A_000217",
    "name": "台北101",
    "county": "63000",
    "anchorLabel": "主塔",
    "reviewedAt": "2026-10-26"
  }
]
```

在專案根目錄執行：

```sh
npm run data:landmarks -- --source data/landmarks-source.zip --selection data/landmarks-selection.json --source-info data/landmarks-source-info.json --version landmarks-2026-10-26-05
```

工具驗證來源與行政圖資雜湊，沿用 `data/manifest.json` 的投影，把 `[PositionLon, PositionLat]` 轉為 EPSG:3826 公尺座標，不另外四捨五入。100 題選中紀錄缺漏或不合格時停止，不靜默遺失經典題；自動來源將無效欄位、非本島縣市、bounds 外、本島面外與所屬縣市不符分類排除。此快照從 6,182 筆依序排除非 19 縣市 450 筆、bounds 外 1 筆、本島面外 152 筆、所屬縣市不符 25 筆，產出 5,554 筆；必要欄位無效為 0。遮罩只扣海洋，沒有扣內陸湖泊，並不代表排除點都經現地判定為海面。

代表點以官方紀錄的原始座標為準；100 題已核對題名、描述、縣市與定位對象，新增的 17 題標註「官方代表點」。清境農場保留農場整體題義，仍只以指定代表點判定命中；不宣稱該點為某個入口。自動補充題與 all 其餘題直接使用「官方登錄代表點」，不填人工審查日期。這是資料及圖資檢查，並非現地測量。公園、園區及博物館複合建物仍以資料所定代表點出題，不能把整座景區任何位置都算命中；沒有自行吸附、移動座標或使用 Google 擷取座標。

預設輸出到**全新**的 `.cache/landmarks/<version>/`，亦可用 `--output <全新目錄>` 指定位置。先完整驗證才寫入暫存檔，題庫改名完成後最後寫入 manifest；目錄已存在就停止，不覆寫已產出的版本。中斷目錄不可拿來發布，重建請指定新的空間。輸出為：

- `landmarks.json`：按穩定 ID 排序的題庫，保留 WGS84 原值、投影座標、代表點說明、官方名稱、來源、classicMainland／classicCounty 旗標；只有人工核對的原題保留審查日期。
- `landmarks-manifest.json`：題數、版本、來源網址與取得時間，以及來源、選題、投影、腳本和產物 SHA-256，以及來源排除數與各縣題數。

相同輸入與版本可重建相同產物；修改選題、座標或計分規則時須依版本規則更新題庫或引擎版本。確認固定數量、排除報告與重建測試後把兩個產物放回 `data/`，`build-static.js` 會核對雜湊並建立獨立的景點答案包，將題庫版本納入 `dataVersion`／fingerprint。瀏覽器 Worker 取得點答案；API 不載入景點座標或幾何 scorer。

`.gitattributes` 將景點 JSON 與轉檔腳本固定為 LF 換行，避免 Windows checkout 改寫換行後使來源或產物雜湊失效。

`test/fixtures/landmarks-tourism.json` 僅摘錄 2026-10-26 官方快照中台北101與奇美博物館的必要欄位，來源、時間及原 ZIP 雜湊記於 `_source`，沿用上述開放資料授權。它用於格式及座標轉換測試，不代表這兩個代表點已通過正式出題審查。

## 遊戲範圍

遊戲範圍為臺灣本島，加旗津本體、和平島主要陸塊、漁光島主要陸塊、彰濱鹿港區主要陸塊、布袋商港主要分離陸塊及三仙台主島，共六組，新增約 22.367276 km²。其他沿岸島塊、沙洲、遠方離島與未核准部件不自動納入；海洋水面不補成土地，也不畫連接陸橋。

`nearshore-manifest.json` 記錄三份行政 ZIP、海洋 ZIP 與來源紀錄的 SHA-256，以及六組經海洋面扣除後的精確部件雜湊、面積、範圍與定位參考。來源改變、部件缺少或重複均停止產製；不按行政代碼整包納入旗津所轄的東沙／南沙島嶼。沿用原始幾何與既有公分投影精度，沒有額外簡化。

其他未納入的分離部件不因距岸較近而自動加入。正射影像有不同拍攝年代，圖資核對不代替現地測量。

## 顯示專用分層圖塊

`display-tiles/manifest.json` 與 WebP 為既有線索的顯示衍生物，不是新的行政邊界或計分輸入。海岸、玩家筆畫與答案繼續以原向量繪製。

- 地形：原有 100 m `terrainPixels` RGBA 畫布按原始網格切為 27 張圖塊，原點 `[150930, 2422210]`、EPSG:3826；沒有重取樣。原始地形網格共有 7,566,390 個像素。
- 水域／道路／河川：沿用原始座標、既有 detail 1 線索與色彩，產製 40／50／64／80／100／128／160／200 m／CSS px、DPR 1／2 的透明圖塊，共 756 張。圖塊只影響顯示，不能送入 IoU 或取代正式幾何。
- 編碼：Pillow 無損 WebP、`lossless=True`、`exact=True`，共 783 張影像。全套約 56.13 MB，正常遊玩按視野取用，並非每局下載量；各檔 SHA-256、原始線索版本與編碼版本記錄於索引。
- 地形繼續依政府開放資料條款，OSM 衍生線索與其圖塊繼續依下列 ODbL／署名條件；自有程式的 AGPL 不取代圖資授權。原始線索仍提供重建下載。

原生倍率及中間倍率的向量／圖塊畫面可能有抗鋸齒與重採樣差異；無損編碼不等於任意倍率下逐像素等同向量。專案已含圖塊產物，正常安裝不必重製。

## 原始資料及授權

資料來源：內政部國土測繪中心，政府資料開放授權條款第 1 版。

- 縣市：https://data.gov.tw/dataset/7442，來源 COUNTY_MOI_1140318。
- 鄉鎮市區：https://data.gov.tw/dataset/7441，來源 TOWN_MOI_1140318，含壓縮檔內其他分塊。
- 村里：https://data.gov.tw/dataset/7438，來源 VILLAGE_NLSC_1150817；匯入所有與本島加核准近岸遮罩有面積交集的村里。
- 授權：https://data.gov.tw/license。圖資另依該條款，自有程式碼的 AGPL 不改變圖資授權。

`npm run data:prepare` 下載官方 ZIP、保留原檔於 `.cache/maps/`，解析所有 SHP 分塊並依行政代碼合併，再轉為 EPSG:3826 公尺制座標。來源網址、座標系、檔名、SHA-256 與產出雜湊記錄在 `manifest.json`。原始 TWD97[2020] 經緯度依 GRS80 橢球處理，未做不同地殼參考框架間的精密改正。

目前海洋裁切加核准近岸陸塊後包含 19 個縣市、349 個鄉鎮市區與 7,656 筆村里紀錄。題庫入口沿用排除空白名稱或名稱退回鄉鎮的規則，排除 45 筆後可出題 7,611；349 個鄉鎮有具名稱的村里題庫，大安 53、竹北 31、清水 32。旗津恢復 13 個具名稱村里，和平島恢復社寮／和憲／平寮三里，漁光里恢復；既有旗津本島邊緣仍保留。`manifest.counts` 是裁切後的全部紀錄數，公開 regions／pool 才是可出題清單；`byId` 仍保留無名稱紀錄。

名稱篩選只影響出題資格；目前地理修正另外更新海洋裁切遮罩與各行政區裁切產物。坐標沿用公分投影精度，畫面與計分使用同一批幾何，沒有額外簡化或手繪容錯；資料不作為正式測量用途。

圖資版本為 `nlsc-mainland-nearshore-2026-10-22`，行政答案 JSON 為 75,487,166 bytes（約 75.49 MB），由建置工具讀取；瀏覽器以版本分包按需取得，首次首頁不會載入所有村里幾何。另提供 gzip 原始資料供重建，正常遊玩不會下載該原始整包。三份官方行政 ZIP 的來源 SHA-256 與前批一致，答案 manifest 另記海洋來源包與 coast-manifest 的 SHA-256。

本島遮罩以排除澎湖、金門、連江後的行政區聯集，扣除 NLSC 經建版地形圖 CoastA／FCsubtype 0 海洋面，再取本島最大連通陸域，僅補回上列六組精確雜湊匹配的主要陸塊；其他分離部件不因橋梁或行政隸屬而自動接回。行政區只對遊戲範圍內部分出題與計分。只扣海洋，不扣獨立的河川、湖泊、水庫或池塘圖層，內陸水域規則維持。

海洋來源為 [NLSC 官方目錄](https://maps.nlsc.gov.tw/pro/download.jsp)，272 張逐圖幅最新 1:25,000 CoastA（民國 110～114 年批次，含內陸空圖層），5 張 1:50,000 原始海洋面僅裁到缺少的 25k 範圍：94203NW、94204NE、95161NE、95223NE、98233SW。後者使用原始 97232 圖框外延，沒有外推資料。[25k](https://data.gov.tw/dataset/176020)／[50k](https://data.gov.tw/dataset/176503)依政府資料開放授權條款第 1 版。原始包 `coast-source.zip` 為 1,061,546 bytes／1,106 檔；逐來源 ZIP／檔案雜湊、年份、原始路徑與限定補缺矩形見 `coast-manifest.json`。兩筆 CoastA／subtype 海洋但 f_code 為 BH140 的原始紀錄，僅依已核對的檔案雜湊與 GlobalID 開放；不全面放行其他分類。

另以國家公園署 114 年第 2 期自然／人工海岸線作獨立對照（https://www.nps.gov.tw/ch/listicle/scope/91；資料開放宣告 https://www.nps.gov.tw/ch/sglarticle/opendata）。其 TWD67 線段轉換約 7 m 精度，沒有用猜測補線生成本島面。圖幅覆蓋與港區對照不代表現地測量。來源年份、比例尺、參考框架、潮位及填海變化仍有差異；旗津南側約 7,654 m² 行政邊緣與本島相接，缺少足夠證據判定錯誤，依既定部分本島規則保留，不把這段邊緣宣稱為已核實乾陸；目前另依精確部件補回旗津本體。

不同年份的行政界線可能有微小接縫，不為對齊而強制吸附或增加容錯；資料不代替正式地理測量。

## 初階線索底圖

行政區初階使用真實地形、道路及水系，高階保留海岸輪廓。景點兩種難度皆有行政區界線：全島顯示縣市界，指定縣市顯示所選外框與鄉鎮界；景點初階另載入地形、河川與道路，高階不載入這些線索。線索**不參與計分、不改動陸域及行政邊界**。不因繪出河川或湖泊而排除內陸水面計分。

- 地形：[內政部 2025 年版 20 公尺網格 DTM](https://data.gov.tw/dataset/176927)。來源 ZIP `不分幅_全台20MDEM(2025).zip`，實際 TIFF 名為 `DEM_tawiwan_V2025.tif`，10035×18852，20 m 網格，NoData -32767。
- 地形 TIFF 為 TM2／121°、中央經線比例 .9999，PixelIsPoint；檔內橢球標為 WGS84。顯示沿用公尺制座標，未做精密參考框架改正。以 5 倍間距取樣為 **100 m 顯示網格**（2007×3770），保留原本 NoData，不人工補山形；輸出的 bounds 依網格中心轉為像元外緣。
- 道路／水系：[Geofabrik 台灣 OSM 摘錄](https://download.geofabrik.de/asia/taiwan.html)，本批釘選 `taiwan-261017-free.shp.zip`。由 WGS84 轉為 EPSG:3826，保留 222889 段道路、53947 段水道及 11544 個水域面。
- 道路包含高速／主要道路、次要道路與住宅街道；水系包含河流、溪流、運河及面狀水域。全島以主要道路、大河與較大水面為主，次要道路隨放大顯示，住宅街道及細支流在更近視野顯示。
- 僅匯入幾何、類別及視野索引，沒有地名、路名、POI 或行政界線。顯示線條使用約 4～10 m 的簡化，**答案資料仍無額外簡化或手繪容錯**。
- 來源網址、來源及產物 SHA-256、投影、數量與限制見 [basemap-manifest.json](basemap-manifest.json)。產物為 `basemap.json.gz`（約 15.5 MB）及 `terrain.bin.gz`（約 4.9 MB）。單人與多人均由瀏覽器按視野載入靜態分包，不一次下載全台線段。

地形依 [政府資料開放授權條款第 1 版](https://data.gov.tw/license)；OSM 道路／水系衍生資料維持 [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/)，署名為 **© OpenStreetMap contributors / Geofabrik**，並連到 [OSM 版權頁](https://www.openstreetmap.org/copyright)。自有程式碼的 AGPL 不取代這些資料授權。頁尾提供「資料來源與授權」入口，該頁首頁區塊列出上述署名與連結；成績分享圖只畫行政邊界／海岸與圈選，未嵌入 OSM 或地形底圖。

`npm run data:basemap` 重新產製線索，原始 ZIP／解開的 TIFF 只快取於 `.cache/basemap/`。啟動與遊玩使用已產出的本機資料，不向政府、OSM 或 Geofabrik 逐題請求圖磚。細村里地形解析度、來源更新時間差、NoData、海岸裁切與手機實機效能仍待檢查。
