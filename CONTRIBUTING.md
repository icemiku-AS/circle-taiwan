# 參與貢獻

歡迎透過 [Issues](https://github.com/icemiku-AS/circle-taiwan/issues) 回報問題或提出建議，也歡迎提交 PR。

- 使用繁體中文（台灣用語）與 UTF-8。
- 回報問題請附重現步驟、預期結果與裝置／瀏覽器資訊；行政區建議請附官方來源。
- 每份 PR 聚焦一個問題，說明修改與驗收結果。
- 提交前執行 `npm run build`，並操作受影響流程。
- 沿用既有程式結構，保留圖資精度、錯誤回復與無障礙功能。
- 新增發布所需檔案時，同步更新 `SOLO_SOURCE_FILES` 或 `FREE_SOURCE_FILES`。

景點題庫的來源格式、Schema 與轉檔指令見 [data/SOURCES.md](data/SOURCES.md#景點題庫轉檔)。`npm test` 包含 S 曲線、點與圈選區域的關係、最近距離及轉檔測試；`npm run build` 另檢查 Cloudflare API 不引入幾何計分依賴。

程式碼貢獻採 AGPL-3.0-only，圖資保留原來源署名與授權。
