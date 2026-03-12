# ytm-dedupe

本工具為本機 Node.js CLI（不使用瀏覽器 DOM 或外掛腳本），使用 Google YouTube Data API v3 來掃描並清理重複的 playlists。

重複定義：

- `title` 完全相同
- `itemCount` 相同
- 內容 resource ID 列表（含順序）完全一致

快速模式（可選）：

- `--fast`：只比較 `title` 與 `itemCount`，不抓取 playlist 內曲目，速度較快但可能誤判

預設為 `dry-run`，不會刪除；只有加上 `--apply` 才會呼叫 `playlists.delete`。

`delete` 預設會優先使用本地快取，避免重複抓取所有 playlist；預設快取路徑 `~/.ytm-dedupe/scan-cache.json`，可用 `--cache` 指定，或加 `--refresh` 強制重抓。

---

## 1) 專案安裝

```bash
cd /Users/Irvin/Coding/yt-playlist-clean
npm install
```

---

## 2) 建立 Google Cloud 專案

1. 前往 [Google Cloud Console](https://console.cloud.google.com/)
2. 建立新專案（或選擇既有）

---

## 3) 啟用 YouTube Data API v3

1. 在 Cloud Console 進入 **APIs & Services** → **Library**
2. 搜尋 **YouTube Data API v3**
3. 點擊 **Enable**

---

## 4) 建立 OAuth client

1. 進入 **APIs & Services** → **Credentials**
2. 點 **Create Credentials** → **OAuth client ID**
3. 應用程式類型選 **Desktop app**
4. 取得 `client_id` / `client_secret`

---

## 5) 下載 credentials 檔並放到專案

1. 在憑證清單下載 JSON（如 `credentials.json`）
2. 將檔案放在專案根目錄
3. 複製 `.env.example` 為 `.env`，確認路徑正確

```bash
cp .env.example .env
```

---

## 6) 第一次授權

首次執行 `scan` 時會要求授權，程式會輸出授權網址。

請在瀏覽器開啟網址並取得授權碼，再貼回終端機。  
取得的 token 會儲存在本機（`YTM_TOKEN_PATH`，預設 `~/.ytm-dedupe/token.json`），方便之後重複執行時不用再次授權。

---

## 7) 執行掃描（dry-run）

```bash
npm run scan
# 或
node src/cli.js scan
node src/cli.js scan --refresh
```

限制單一 title 的掃描：

```bash
node src/cli.js scan --title "最愛搖滾"
```

快速模式掃描（不抓取 playlistItems）：

```bash
node src/cli.js scan --fast
```

---

## 8) 真正刪除（需明確加 `--apply`）

```bash
node src/cli.js delete --apply
node src/cli.js delete --apply --cache ./my-scan-cache.json
node src/cli.js delete --apply --refresh
```

指定 title：

```bash
node src/cli.js delete --title "最愛搖滾" --apply
```

快速刪除流程（先以 `--title` / `--fast` 過濾）：

```bash
node src/cli.js delete --fast
```

刪除前會先輸出一份 JSON 備份：

```json
{
  "generatedAt": "2026-03-11T10:00:00Z",
  "groups": [
    {
      "title": "最愛搖滾",
      "signature": "abc123",
      "keep": { "playlistId": "PLxxx1" },
      "delete": [
        { "playlistId": "PLxxx2" },
        { "playlistId": "PLxxx3" }
      ]
    }
  ]
}
```

---

## 指令說明

### scan

列出重複群組，不會刪除：

- `ytm-dedupe scan`
- `ytm-dedupe scan --title "<title>"`
- `ytm-dedupe scan --keep oldest|newest`（目前預設 oldest）
- `ytm-dedupe scan --fast`

### delete

規劃刪除清單，不加 `--apply` 時只列印不執行：

- `ytm-dedupe delete`
- `ytm-dedupe delete --apply`
- `ytm-dedupe delete --title "<title>" --apply`
- `ytm-dedupe delete --fast`（快速流程，直接執行刪除）
- `ytm-dedupe delete --apply --output ./backup.json`
- `ytm-dedupe delete --cache ./my-scan-cache.json`

---

## 輸出格式

每組重複 playlist 會輸出：

```
Duplicate group: 最愛搖滾
Keep:
PLxxxx1
Delete:
PLxxxx2
PLxxxx3
Reason:
same title, same item count, identical ordered resource IDs
```

快速模式輸出：

```
Reason:
same title, same item count (fast mode, no playlistItems check)
```

最後會輸出：

- 總 playlist 數
- 重複群組數
- 待刪除 playlist 數

---

## 風險提醒

- 本工具預設不刪除，請先確認 scan 結果。
- `playlists.delete` 會直接刪除 Playlist 本體與其訂閱關係，刪除後無法復原。
- 即使 `--apply`，每筆刪除失敗也不會中斷整體流程，錯誤會列在輸出中繼續處理其他項目。
- 請確保 OAuth 帳號有權限刪除目標 playlist（必須為該帳號擁有者）。
- 快速模式 `--fast` 只比對「同名 + 同歌曲數」，請先用一般模式或限制 title 小範圍做確認，再用快速模式大量刪除，避免同名但內容不同的清單被誤刪。

---

## 專案結構

- `package.json`：相依套件與 bin 指令
- `src/cli.js`：CLI 入口與指令邏輯
- `src/auth.js`：OAuth 2.0、token 本地儲存、token 更新
- `src/scanner.js`：分頁抓取、signature、重複群組與保留策略
- `.env.example`：環境變數範例
