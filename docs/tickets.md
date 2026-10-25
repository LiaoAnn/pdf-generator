# PDF Fixtures 產生器：票

> 2026-10-23 · 由開票草稿整理。26 張票，分 4 波。

## 開票規則

- 一張票 = 一個 worktree = 一個分支 = 一個 PR，約 500～2000 行。超過 2000 行就拆票，不到 300 行就併票。
- 每張票：先 plan → 切 3～5 個 slice → 每個 slice 先寫失敗測試再實作（TDD）→ 全部完成後多角度 code review。
- 平台是 monorepo。本機服務（T04、T11、T17、T19、T21）是獨立專案、在 Mac 上另外跑，只透過 T02 的契約（匯出成 JSON Schema）和上傳 API 跟平台溝通。
- 共用契約（T02）先定好；要改契約就先開一張小票 merge，不在功能票裡順便改。
- 還沒做好的依賴用 stub 替代，不要等。
- D1 migration 一律用 Drizzle 產生，不手寫；撞到就 rebase 後重新產生。lockfile 也一樣。
- 這些開發規則會寫進 T01 的 `AGENTS.md` 與開發用 skill。

## 平行波次

同一波的票互不依賴。一張票只要它的 blocked by 都 merge 了就能開始，不用等整波做完。

1. **第 0 波：打地基**：T01 → T02 依序；T03、T04 是實驗，同時跑
2. **第 1 波：各模組核心**：T05～T11
3. **第 2 波：功能串起來**：T12～T19
4. **第 3 波：畫面與樣板**：T20～T26

第一個看得到成果的點：T22 公司月報完成，「上傳 → 產生 → 看結果」整條路跑通。

## 派工撞車表

只列「互相沒有依賴、但同一波同時做會改到同一處」的票。

| 波次 | 會撞的票 | 撞在哪裡 | 怎麼派 |
| --- | --- | --- | --- |
| 1 | T07、T08 | 都要決定 Paged.js 分頁完成的時間點 | 可同時派；都照 T03 結論做 |
| 1 | T06、T10 | 都在定「樣板包長怎樣」 | 可同時派；一律以 T02 契約為準 |
| 2 | T15、T16 | 同一個網站的路由、導覽列、D1 資料表 | 先派 T15；T16 可同時做後端（Workflows），網頁等 T15 merge 後再接 |
| 2 | T13、T14 | 同一個標準答案套件 | 可同時派；T14 只讀 gt.json，不改擷取邏輯 |
| 3 | T20、T22～T26 | 樣板票可能順手修網頁 | 樣板票發現網頁問題就開新票，不在樣板 PR 裡改 |
| 全部 | 所有平台票 | lockfile、D1 migration | 衝突時 rebase 後重新產生 |

---

## 第 0 波：打地基

### T01 專案骨架
- **目標**：monorepo、TS v7、lint、測試工具、每個 worktree 用的 docker compose、CI；`AGENTS.md` + 開發用 skill（plan → slice → TDD → 多角度 review、Drizzle migration、撞車處理）
  - `AGENTS.md` 與 `.claude/skills/`（`coordinate-tickets`、`work-ticket`、`cross-model-delegate`）已先寫好；T01 只補上實際的套件結構與指令（`AGENTS.md` 的「Where things are」「Commands」），流程規則的修改提給 coordinator
- **Blocked by**：—
- **Blocks**：T02
- **撞車風險**：無（第一張）
- **驗收測試**：新 worktree 一行指令起環境；兩個 worktree 同時跑不搶 port；CI 綠；agent 照 skill 做一個小改動能走完整流程
- **不做**：任何功能
- **預估行數**：900

### T01-1 開發環境小修
- **目標**：本機 dev cron 排程器拿掉自動探測（掃 socket、探 port、猜哪個是 wrangler dev），改成只照 `.devcontainer/cron-targets.jsonc` 明列的網址觸發（每個 Worker 的 port 是固定的）；沒列網址的 Worker 不排程並印出提示；`.devcontainer/docker-compose.yml` 的 `app` service 加 `init: true`；README 的 cron 說明跟著改
- **Blocked by**：T01
- **Blocks**：—
- **撞車風險**：無（只動 `.devcontainer/`、README）；merge 後各 worktree 要重跑 `wt-up` 才生效
- **驗收測試**：排程器不再對任何 port 發探測（workerd 不再印 RPC 警告）；照表觸發 `/cdn-cgi/local/scheduled` 有測試；`localhost` 先解析成 IPv6 時也能照表觸發；停掉 dev server 後沒有 `<defunct>` 程序
- **不做**：新增平台的 cron；改 VM／homelab 設定
- **預估行數**：400（刪除為主，小於 300 行的規則對這張例外）

### T02 共用契約
- **目標**：zod 定義樣板包 manifest、規則檔格式、gt.json、區塊清單、API 型別；匯出 JSON Schema 給本機服務用
- **Blocked by**：T01
- **Blocks**：T05、T06、T07、T08、T09、T10、T11
- **撞車風險**：無
- **驗收測試**：每個契約有一份合格、一份不合格的範例，驗證結果正確；JSON Schema 可匯出
- **不做**：任何實作
- **預估行數**：800

### T02-2 契約：表格儲存格內的勾選框
- **目標**：gt.json 的表格儲存格（`cellSchema`）加一個選填的 `checkboxes` 陣列：`{ checked: boolean, text: string, bbox }`，依框在儲存格內出現的順序；`text` 是該選項的標籤（例如「是」），`bbox` 是勾選框元素的框；superRefine 加一條：每個勾選框的框要落在頁面內（不綁儲存格的框，避免捨入誤差）；重新匯出 JSON Schema，補合格／不合格範例
- **Blocked by**：T02
- **Blocks**：T13 的最後一個 slice（儲存格內勾選框）、T23
- **撞車風險**：契約變更；T13 進行中，merge 後通知 T13 rebase
- **驗收測試**：一份含「□是 □否」兩個框的儲存格範例通過 gtSchema；勾選框框超出頁面的範例被擋下；JSON Schema 已重新匯出且 staleness 測試通過
- **不做**：讀取邏輯（T13）
- **預估行數**：150

### T03 實驗：雲端印 PDF
- **目標**：Browser Rendering + Paged.js 印中文 A4，讀回元素位置；寫一頁結論（字型、限制、分頁後讀座標的時機）
- **Blocked by**：—
- **Blocks**：T07、T08（需要結論）
- **撞車風險**：無（程式用完就丟）
- **驗收測試**：中文不缺字、文字可選取；框框座標跟 PDF 對得上；記下一分鐘能印幾份
- **不做**：正式程式
- **預估行數**：500

### T04 實驗：MinerU（本機專案）
- **目標**：在 M1 Pro 裝 MinerU 跑 3 份文件；寫一頁結論
- **Blocked by**：—
- **Blocks**：T11
- **撞車風險**：無
- **驗收測試**：切得出區塊；記下每頁秒數與記憶體用量
- **不做**：正式程式
- **預估行數**：300

---

## 第 1 波：各模組核心

### T05 假資料核心
- **目標**：規則引擎 + seed；台灣欄位（姓名、身分證、統編、地址、電話、公司、日期）、金額；產出先過 zod
- **Blocked by**：T02
- **Blocks**：T12、T16
- **撞車風險**：無
- **驗收測試**：同 seed 兩次結果相同；身分證、統編檢查碼正確；不合格資料會報錯
- **不做**：衍生欄位（T12）
- **預估行數**：1500

### T06 樣板工具
- **目標**：Handlebars 把資料填進 HTML；檢查樣板包（檔案齊全、範例資料合格、`data-gt` 沒漏標）；平台與本機共用
- **Blocked by**：T02
- **Blocks**：T15、T18
- **撞車風險**：T10（都在定樣板包長怎樣，以 T02 為準）
- **驗收測試**：10 個故意弄壞的樣板包都被抓到，錯誤訊息指出位置
- **不做**：上傳 API（T15）
- **預估行數**：1200

### T07 印 PDF 服務
- **目標**：Worker 用 Browser Rendering 把 HTML 印成 PDF（直／橫向）、內嵌中文字型、Paged.js 分頁
- **Blocked by**：T02、T03
- **Blocks**：T14、T16
- **撞車風險**：T08（分頁完成的時間點，照 T03 結論）
- **驗收測試**：固定 HTML 印出的 PDF 頁數正確、文字可抽取、跨頁表頭有重複
- **不做**：標準答案
- **預估行數**：1200

### T08 標準答案：基本
- **目標**：在印好的頁面上讀區塊類型、文字、頁碼、位置框、閱讀順序
- **Blocked by**：T02、T03
- **Blocks**：T13、T14、T16
- **撞車風險**：T07（同上）
- **驗收測試**：用本機 Playwright 對固定 HTML 跑，輸出跟預先寫好的 gt.json 一致
- **不做**：表格細節（T13）
- **預估行數**：1200

### T09 網站骨架
- **目標**：TanStack Start + shadcn 部署到 Workers；D1 + Drizzle、R2、Cloudflare Access、Effect 基礎寫法
- **Blocked by**：T02
- **Blocks**：T15、T16
- **撞車風險**：無
- **驗收測試**：未登入被擋；帶 service token 可呼叫 API；本機與線上都能建表
- **不做**：功能頁
- **預估行數**：1500

### T10 樣板包規格書
- **目標**：規格書、`data-gt` 標記清單、Word 風格 CSS（A4、預設邊界、字型、表格）、一個最小範例包
- **Blocked by**：T02
- **Blocks**：T18
- **撞車風險**：T06（以 T02 為準）
- **驗收測試**：範例包通過 T02 契約驗證；印出來跟 Word 轉的 PDF 並排相似
- **不做**：skill 包裝（T18）
- **預估行數**：800

### T11 本機切區塊（本機專案）
- **目標**：Python 環境、PDF 轉圖、跑 MinerU、輸出統一格式區塊清單、畫對照圖
- **Blocked by**：T02、T04
- **Blocks**：T17、T19
- **撞車風險**：無（獨立專案）
- **驗收測試**：測試 PDF 輸出的清單通過契約 JSON Schema；對照圖有框
- **不做**：去機敏化（T17）
- **預估行數**：1200

---

## 第 2 波：功能串起來

### T12 假資料進階
- **目標**：衍生欄位（加總、逐筆餘額、百分比）、表格列數範圍、勾選框隨機、空白機率、中文假文與中英混排
- **Blocked by**：T05
- **Blocks**：T23、T26
- **撞車風險**：無
- **驗收測試**：對帳單餘額逐筆算對；100 份裡列數與勾選有變化
- **不做**：AI 生成假資料
- **預估行數**：1200

### T13 標準答案：表格與特殊項
- **目標**：列、欄、合併儲存格、跨頁表格；勾選狀態、空白欄位、公式 LaTeX、圖片內文字
- **Blocked by**：T08
- **Blocks**：T23、T24、T25
- **撞車風險**：T14（T14 只讀 gt.json）
- **驗收測試**：每種情況各有一份固定 HTML，輸出跟預期一致
- **不做**：自我檢查（T14）
- **預估行數**：1500

### T14 自動自我檢查
- **目標**：從印好的 PDF 抽文字與位置，跟 gt.json 比對並報告差異
- **Blocked by**：T07、T08
- **Blocks**：T22、T23、T24、T25、T26
- **撞車風險**：T13
- **驗收測試**：故意做錯的 gt.json 會被抓到
- **不做**：改擷取邏輯
- **預估行數**：700
- **派工備註**：Chrome 印出的 PDF MediaBox 不是宣告的尺寸（A4 印成 594.96 × 841.92 pt，gt.json 用宣告的 595.28 × 841.89），比對頁面尺寸要有容差（PR #7）；儲存格文字與勾選框標籤要忽略空白差異比對（儲存格文字可能有連續空白，PDF 文字層是換行）；T03 的「字型壞掉時掉列」從 DOM 抓不到，只能由 T14 從 PDF 抓；KaTeX 隱藏的 MathML 副本可能出現在 PDF 文字層（PR #10）

### T15 樣板管理
- **目標**：上傳 API（zip → T06 檢查 → R2 + D1）、上傳頁、樣板列表、樣板預覽頁、版本
- **Blocked by**：T06、T09
- **Blocks**：T21、T22、T23、T24、T25、T26
- **撞車風險**：T16（同一網站，T15 先派）
- **驗收測試**：壞包被擋且訊息看得懂；重傳變新版、舊版還在
- **不做**：網頁上編輯 HTML
- **預估行數**：1800（接近上限，plan 時超過就拆）

### T16 批次產出
- **目標**：Workflows + Queues：產資料 → 印 PDF → 讀答案 → 存 R2；「產生 N 份」、進度、整批 zip、重做同一批
- **Blocked by**：T05、T07、T08、T09
- **Blocks**：T20、T22、T23、T24、T25、T26
- **撞車風險**：T15（網頁部分等 T15 merge 後再接）
- **驗收測試**：產 100 份全部完成；失敗會重試；重做結果一模一樣
- **不做**：結果檢視頁（T20）
- **預估行數**：1800（接近上限，plan 時超過就拆）

### T17 本機去機敏（本機專案）
- **目標**：文字換假字（保留字數與型態）、線框圖、送出前比對有沒有原文
- **Blocked by**：T11
- **Blocks**：T21
- **撞車風險**：無
- **驗收測試**：故意留一個原字會被擋下；線框圖看不出原字
- **不做**：寫 HTML（T21）
- **預估行數**：1000

### T18 agent skill
- **目標**：把 T10 規格書 + T06 檢查工具包成 skill
- **Blocked by**：T06、T10
- **Blocks**：T21
- **撞車風險**：無
- **驗收測試**：給 Claude 一句版面描述，做出的包一次過檢查
- **不做**：讓 agent 直接上傳
- **預估行數**：500

### T19 本機模型比較（本機專案）
- **目標**：同一組文件跑 MinerU、PP-StructureV3、Docling，產出比較表
- **Blocked by**：T11
- **Blocks**：—
- **撞車風險**：無
- **驗收測試**：比較表含準確度與速度，並決定主力模型
- **不做**：換掉 T11 的預設模型（另開票）
- **預估行數**：600

---

## 第 3 波：畫面與樣板

### T20 結果檢視
- **目標**：批次列表、PDF 預覽（pdf.js）、疊畫框框（依類型上色、可開關）、答案清單與框框互相對應、單份下載
- **Blocked by**：T16
- **Blocks**：—
- **撞車風險**：T22～T26（樣板票不改網頁）
- **驗收測試**：框框跟內容對齊；點一邊另一邊會亮
- **不做**：疊 OCR 結果比對
- **預估行數**：1800（接近上限，plan 時超過就拆）

### T21 `pdf2tpl` 一鍵指令（本機專案）
- **目標**：切區塊 → 去機敏 → Claude Code 用 skill 寫樣板包 → 檢查 → 上傳
- **Blocked by**：T15、T17、T18
- **Blocks**：—
- **撞車風險**：無
- **驗收測試**：一個指令從 PDF 到平台上看得到樣板；送出的網路封包裡沒有原文
- **不做**：網頁介面
- **預估行數**：1000

### T22 公司月報
- **目標**：列點、圖文、表格、頁首頁尾
- **Blocked by**：T14、T15、T16
- **Blocks**：—
- **撞車風險**：T20
- **驗收測試**：產 10 份，T14 自我檢查全過
- **不做**：改平台程式
- **預估行數**：600

### T23 通報單
- **目標**：大表格、合併格、空格、勾選框
- **Blocked by**：T12、T13、T14、T15、T16
- **Blocks**：—
- **撞車風險**：T20
- **驗收測試**：同上；勾選與空白記錄正確
- **不做**：改平台程式
- **預估行數**：700

### T24 財務明細
- **目標**：橫向 A4、多層表頭、跨頁表格
- **Blocked by**：T13、T14、T15、T16
- **Blocks**：—
- **撞車風險**：T20
- **驗收測試**：同上；每頁表頭重複
- **不做**：改平台程式
- **預估行數**：600

### T25 論文
- **目標**：LaTeX 風格、雙欄、KaTeX 公式、參考文獻、註腳
- **Blocked by**：T13、T14、T15、T16
- **Blocks**：—
- **撞車風險**：T20
- **驗收測試**：同上；公式記成 LaTeX
- **不做**：真的跑 LaTeX
- **預估行數**：800

### T26 銀行對帳單
- **目標**：logo、條碼、客服框、無框線交易明細
- **Blocked by**：T12、T14、T15、T16
- **Blocks**：—
- **撞車風險**：T20
- **驗收測試**：同上；餘額逐筆對
- **不做**：改平台程式
- **預估行數**：700

---

## 風險

| 風險 | 為什麼要擔心 | 先驗證的票 |
| --- | --- | --- |
| Browser Rendering 限制 | 同時能開的瀏覽器有限；不夠就改用 Containers | T03 |
| 中文字型 | 不內嵌會缺字；Word 字型有授權問題，用免費替代 | T03 |
| Paged.js 後的框框位置 | 分頁會重排，座標要分頁完成後才讀 | T03 |
| MinerU 在 16GB Mac 的速度 | 太慢就改 PP-StructureV3 | T04 |
| T15、T16、T20 接近 2000 行 | 可能要拆 | plan 階段 |

## 待確認

- [ ] 結果保存多久（影響 T16「重做同一批」）

---

## 待辦

不擋任何票的強化與小票。coordinator 在有空位、且關鍵路徑上沒有可派的票時派出。

### T02-1 契約強化
- **目標**：表格儲存格的框要落在所屬頁面內；日期做曆法檢查（擋 02-31）；規則檔與產出紀錄加大小與巢狀深度上限（避免深度巢狀讓 `safeParse` 丟 `RangeError`；T05 目前在引擎裡自設每筆紀錄最多 100,000 個值，契約定好後改用契約的上限）；正規式結尾改成 JS 與 Python 都視為字串結尾的寫法（不用 `$`）；補頂層引用與匯出指令的測試
- **Blocked by**：T02
- **Blocks**：—（建議在 T11 與 T15 之前完成）
- **撞車風險**：契約變更；同時進行的票若用到受影響的 schema，rebase 後重跑測試
- **驗收測試**：每項各有一份會被擋下的不合格範例；重新匯出的 JSON Schema 在 Python 端對結尾換行同樣拒絕
- **不做**：新增契約欄位
- **來源**：PR #3 的 review（Hardening）

### T05-1 郵遞區號與電話資料校正
- **目標**：把 `packages/fake-data` 的郵遞區號／鄉鎮市區表對照中華郵政公開的官方清單逐筆校正（目前是憑記憶寫的，只核對過 25 組）；市話開頭碼對應到地區；路名改用真實路名清單
- **Blocked by**：T05
- **Blocks**：—（建議在 T22 之前完成）
- **撞車風險**：T12 同時在改 `packages/fake-data`；兩張不要同時派
- **驗收測試**：資料表與官方清單逐筆比對無差異（比對腳本與來源版本一併提交）；同 seed 產出仍穩定（資料變更後更新快照）
- **不做**：門牌號碼真實性
- **來源**：PR #5 的 open risks

### T09-1 線上環境設定（暫緩：使用者 2026-10-24 決定目前只在本機自用，上線前再決定 auth 方式）
- **目標**：把 T09 的網站接上真的 Cloudflare 帳號：wrangler 登入加 `d1:write`（使用者操作）；建立 D1 `pdf-generator`、R2 `pdf-generator-files`；線上跑 migration；部署 `pdf-generator-web`；在後台為 workers.dev 網址開 Cloudflare Access（允許使用者 email 與一組 service token，使用者操作）；帶 Access 設定重新部署；建立 R2 `pdf-generator-print-pack-files`（T07-3 的列印暫存檔）並設定清掉孤兒檔的 lifecycle 規則
- **Blocked by**：T09
- **Blocks**：—（建議跟 T15、T16 第一次部署一起做，使用者只需登入與進後台各一次）
- **撞車風險**：`apps/web/wrangler.jsonc`（database id、Access vars）
- **驗收測試**：線上能建表；沒帶憑證被 Access 擋下；帶 service token 呼叫 `/api/me` 回 200；`/api/templates` 讀到線上的表
- **不做**：自訂網域
- **來源**：T09 的 ASK（步驟 0～7 與各步的還原方式見 T09 的 thread）；每一步都是外部服務呼叫，執行前要使用者同意

### T07-1 印 PDF：雲端 Chrome 152 驗收
- **目標**：在真的 Browser Rendering（Chrome 152）上跑 T07 的 3 份驗收文件：部署 `pdf-generator-print`、設 `PRINT_TOKEN`、最多 12 份（含 session 重用），記錄啟動與渲染時間，跑完刪除 Worker；排版有問題就另開修正票；並確認 T07-8 的做法在真的平台可用：每次列印建立的 browser context 帶 `proxyServer`（指向不通的本機埠、只放行列印 Worker 自己的網址）能建立、能載入列印 Worker 的檔案，外部 `@import` 仍得 422；以及 T07-18 的 PDF 縮放檢查（假設 Chrome／Skia 為每個繪圖寫入完整的變換矩陣）在真的平台成立，正常樣板不會被誤擋成 `page_box_moved`
- **Blocked by**：T07
- **Blocks**：—（建議在 T16 部署前完成）
- **撞車風險**：無
- **驗收測試**：3 份文件在 Chrome 152 上頁數、A4 尺寸、每列只出現一次、每頁表頭都對；Worker 刪除後網址 404
- **不做**：正式部署（T16）
- **來源**：T07 的 ASK（步驟與指令見 T07 的 thread）；外部服務，執行前要使用者同意

### T08-1 標準答案：只算 Paged.js 產生的頁面
- **目標**：`readGroundTruth` 只計 Paged.js 產生的 `.pagedjs_page`（樣板自己用到這個 class 的元素會讓 `gt.pages` 變多，已重現）；瀏覽器端蒐集器不要強迫使用者的 tsconfig 載入 DOM lib
- **Blocked by**：T08
- **Blocks**：—（建議在 T16 之前）
- **撞車風險**：T13 正在改 `packages/ground-truth`；等 T13 merge 後再派
- **驗收測試**：一份樣板內含 `.pagedjs_page` 元素的 fixture，`gt.pages` 數量正確；apps/print 不需 DOM lib 也能 typecheck
- **不做**：改區塊讀取規則
- **來源**：PR #8 的 open risks

### T07-2 印 PDF：位元組完全相同
- **目標**：同一份 HTML 重印時 PDF 位元組一模一樣：固定或移除 Chrome 寫入的 `/CreationDate`、`/ModDate`，以及 tagged-PDF 結構樹裡的 DOM node-id 字串（必要時關掉 tagged PDF 或在印完後正規化）
- **Blocked by**：T07
- **Blocks**：—（T16「重做結果一模一樣」目前 data.json、gt.json 已相同，PDF 只差這些欄位）
- **撞車風險**：`apps/print`
- **驗收測試**：同一份文件連印兩次 sha256 相同；T16 重做 100 份 PDF 100/100 相同
- **不做**：改排版
- **來源**：PR #11

### T07-3 印 PDF：送進樣板包自己的檔案，並擋掉其他請求
- **目標**：`/print` 接收樣板包的檔案（路徑 → 內容），讓頁面用網址載入這些檔案（字型、圖片、CSS）；**依 T03 Must not 3，不要用 puppeteer request interception 把檔案塞給瀏覽器**（雲端 4 次有 3 次 error 1102），改由 print Worker 用自己的網址提供（例如以批次／session 為範圍的路徑，資料放 R2 或 Worker 記憶體）；interception 只用來中止不是樣板包檔案的請求（含 CSS、SVG `<set>`、圖片）；維持 JavaScript 關閉；作為 T06 白名單之外的第二層防護。T15 預覽與 T16 批次都要把樣板包檔案一起送進來
- **Blocked by**：T07
- **Blocks**：T22、T26（帶自己字型或圖片的樣板）
- **撞車風險**：`apps/print`；T07-2 也改這裡，兩張不要同時派
- **驗收測試**：T06 的 valid 範例包（自帶 `report.woff2`、`logo.svg`、`report.css`）印得出來且字型已載入；樣板包外的網址（http、data: CSS、SVG `<set>` 改 href）在列印時都沒有發出請求
- **不做**：改 T06 的檢查
- **來源**：PR #12

### T06-1 樣板工具強化
- **目標**：勾選框與公式的後援判斷要考慮 `{{#if}}` 分支；block tag 字串內含 `}}` 時正確切分；字型使用改成依字重／樣式（face）檢查；`{{lookup}}` 用物件當 key 不丟例外；與 T13 對齊三種 checkPack 接受、但 T13 列印時會擋下的儲存格勾選框寫法；JSON 樹快取、URL 裁切與瀏覽器一致；T16 的 `inlineStyles` 只認字面上的 `</head>`，`</head >` 或沒有 `</head>` 的樣板包會過 `checkPack` 卻在批次失敗：兩邊對齊（接受這兩種寫法，或 `checkPack` 要求 `</head>`）；valid 範例包的 `assets/report.woff2` 是 27 位元組的佔位檔、永遠載不進來，換成真的子集字型；子集要涵蓋規則會產生的字，不只是範例資料的字（`apps/print/src/test-fixtures/pack-font/report.woff2` 不夠，批次會退回系統字型而被自我檢查標出）
- **Blocked by**：T06
- **Blocks**：—（建議在 T15 之後、樣板票之前）
- **撞車風險**：`packages/template-tools`
- **驗收測試**：每一項各有一份樣板包 fixture，結果符合預期
- **不做**：放寬白名單
- **來源**：PR #12 的 Hardening；`</head>` 一項來自 PR #14

### T06-2 樣板輔助函式：民國年
- **目標**：`fill` 內建日期格式輔助函式（民國年、中文月份等台灣表單常見格式）；樣板包不能帶 JavaScript，所以只能內建
- **Blocked by**：T06
- **Blocks**：—（T23、T26 可能用到）
- **撞車風險**：`packages/template-tools`；與 T06-1 不要同時派
- **驗收測試**：每種格式有測試；在 workerd 內跑過
- **不做**：自訂輔助函式
- **來源**：PR #12

### T16-1 批次接上自我檢查
- **目標**：批次每一份產完後用 `@pdf-generator/self-check` 的 `checkPdf(pdf, gt, { fonts })` 檢查，結果存進 R2（`check.json`）與 D1；批次進度顯示通過／失敗數；API 可查每份的差異；整批 zip 帶上檢查結果
- **Blocked by**：T14、T16
- **Blocks**：T22、T23、T24、T25、T26（驗收要「T14 自我檢查全過」）
- **撞車風險**：`apps/web` 批次程式；T15 進行中也在改 `apps/web`，等 T15 merge 後再派
- **驗收測試**：產 10 份全部通過；故意弄錯一份的 gt.json 時，那一份標為失敗且差異可查
- **不做**：結果檢視頁（T20）
- **來源**：PR #13

### T07-4 印 PDF：不把 KaTeX 的 MathML 副本當成應出現的文字
- **目標**：print runtime 檢查「`data-gt` 文字都在 PDF 裡」時，排除 KaTeX 隱藏的 MathML 副本，只比對可見的 `.katex-html`；與 T13 讀取規則一致
- **Blocked by**：T07
- **Blocks**：T25（論文；目前真的 KaTeX 公式會 `text_missing`，已重現）
- **撞車風險**：`apps/print`；與 T07-2、T07-3 不要同時派（可併進 T07-3 一起做）
- **驗收測試**：含 KaTeX 公式的文件印得出來；故意刪掉可見公式文字仍會被擋
- **不做**：改 T13
- **來源**：PR #13

### T14-1 自我檢查：相鄰的行內區塊
- **目標**：兩個相鄰、中間無空白、同字型的行內 `data-gt` 區塊，Chrome 會把文字合併成一個 PDF 文字項目，造成誤判；改成可以拆分比對。順帶：旋轉文字的框、公式結尾容差收緊；`bbox` 差異在文字延伸出去時的訊息不對（PR #17 的 flawed fixture：說文字在框外，但回報的 `textBox` 其實在框內；差異本身是真的，後面跟著 `unmarked_text`）
- **Blocked by**：T14
- **Blocks**：—（表單類樣板 T23 可能碰到）
- **撞車風險**：`packages/self-check`
- **驗收測試**：相鄰行內區塊的 fixture 不再誤報，故意弄錯的仍被抓到
- **不做**：改擷取邏輯
- **來源**：PR #13

### T15-1 樣板上傳強化
- **目標**：拒絕只產生空 deflate 區塊的項目（區塊數或壓縮比檢查；目前 10 MiB、約 90 萬個空區塊的項目會被接受，解壓約花 2.4 秒 CPU）；zip 目錄裡重複的檔名也算進 1,000 個項目的上限；補 20 MiB 邊界測試，以及用上傳版本跑 `consumeFixtures` 的測試
- **Blocked by**：T15
- **Blocks**：—
- **撞車風險**：`apps/web` 的樣板上傳程式；T16-1 改的是批次，可同時進行
- **驗收測試**：每一項各有一份會被擋下（或通過邊界）的 zip fixture
- **不做**：改 `checkPack`
- **來源**：PR #14 的 Security Hardening

### T16-2 測試：完整並行跑時 workerd 測試偶發失敗
- **目標**：完整 `pnpm verify`／CI 並行跑各 Vitest 專案時，啟動 workerd 的測試會偶發失敗，單獨跑都通過：T16 的 `batch-zip.test.ts`（5 次 1 次，沒留錯誤）；`apps/print` 的 `print-route.test.ts`（PR #18 的 CI 2/2：120 秒逾時，以及 workerd `SQLITE_BUSY_RECOVERY` 後卡到 job 逾時）；`request-blocking.test.ts`（本機 1/1：data: 樣式表 @import 的外部伺服器收到 `/imported.css`）。先找出共用的狀態（推測是各專案的 workerd 共用 `.wrangler/state`、本機 Chrome 或錄製用伺服器的連接埠，未證實），再讓測試彼此隔離；request-blocking 那次要確認是測試隔離問題，不是封鎖真的漏掉
- **Blocked by**：T16、T07-3
- **Blocks**：—（CI 偶發紅燈會擋每張 PR 的 merge；在樣板票大量 merge 前修好）
- **撞車風險**：`apps/print`、`apps/web` 的 vitest 設定與測試；不要跟 T16-3 同時派
- **驗收測試**：記錄下每種失敗的原因；修正後完整 `pnpm verify` 連跑 10 次（CI=1）都通過，CI 連跑 3 次都通過
- **不做**：改功能程式（除非原因是真的漏洞，那就另開票）
- **來源**：PR #14、PR #18（`request-blocking.test.ts` 的 `/imported.css` 偶發失敗已由 T07-8，PR #51 修好）

### T02-3 契約：錯誤細節加 `code`、批次進度加自我檢查數（使用者 2026-10-24 同意）
- **目標**：`ApiError` 的 `details[]` 加選用欄位 `code`，讓問題代碼不必塞在 message 開頭；網頁與本地工具改讀這個欄位。`Batch.progress`（目前是嚴格的 `{ completed, failed }`，只算列印結果）加自我檢查的通過／失敗數，並接到 `GET /api/batches/:id`（T16-1 先只做每份的 `Fixture.check`，批次層級的數字等這張）
- **Blocked by**：T02、T15、T16-1
- **Blocks**：—（T20 結果檢視頁會用到批次層級的數字）
- **撞車風險**：契約變更；同時進行的票若用到 `ApiError` 或 `Batch`，rebase 後重跑測試
- **驗收測試**：上傳不合格樣板包時，每個錯誤細節都帶 `code`；有一份自我檢查失敗的批次，`GET /api/batches/:id` 的數字正確；重新匯出的 JSON Schema 含這些欄位
- **不做**：其他契約欄位
- **來源**：PR #14；T16-1 的 ASK

### T15-2 網頁把樣板包檔案送進印 PDF
- **目標**：T15 預覽與 T16 批次呼叫 `/print` 時，帶上 `pack: { template: manifest.files.template, files }`（T07-3 的介面，見 `apps/print/src/request.ts`），讓自帶字型、圖片、CSS 的樣板包能預覽與批次產出；超過 T07-3 上限（單檔 16 MiB、整包 24 MiB）時回清楚的錯誤；批次自我檢查的字型允許清單（T16-1 的 `platformFonts`）加上樣板包自帶字型的 PostScript 名稱，否則這類樣板包每一份都會有 `font` 差異
- **Blocked by**：T07-3、T15、T16-1
- **Blocks**：T22、T26（帶自己字型或圖片的樣板）
- **撞車風險**：`apps/web` 的預覽與批次程式；T16-1 merge 後再派
- **驗收測試**：T06 的 valid 範例包（換上真字型後）預覽與批次都印得出來且字型已載入；只靠平台字型的樣板包結果不變
- **不做**：批次間快取樣板包檔案（T07-5）
- **來源**：PR #15

### T07-5 印 PDF：同一批次共用樣板包檔案
- **目標**：目前每次列印都重新上傳樣板包，且網址每次不同、瀏覽器無法快取；改成以內容雜湊、批次為範圍的路徑，大字型每個 session 只載一次
- **Blocked by**：T07-3、T15-2
- **Blocks**：—
- **撞車風險**：`apps/print`；與 T07-2 不要同時派
- **驗收測試**：同一批次 10 份只上傳與載入樣板包字型一次；輸出 PDF 與不快取時相同
- **不做**：跨批次共用
- **來源**：PR #15

### T07-6 印 PDF：單一字母的公式文字不吃掉前文字母
- **目標**：print runtime 的 `missingText` 檢查裡，單一字元的文字節點（公式的 `x`、`r`）會用掉前面英文段落的字母，造成誤報 `text_missing`；改成依位置／區塊比對
- **Blocked by**：T07-3
- **Blocks**：—（建議在 T25 論文之前完成）
- **撞車風險**：`apps/print`；與 T07-2、T07-5 不要同時派
- **驗收測試**：英文段落加單字母公式的文件不再誤報；故意刪掉公式文字仍會被擋
- **不做**：改 T14 自我檢查
- **來源**：PR #15（slice 3 的測試作者發現）

### T05-2 假資料引擎：規則形狀的上限
- **目標**：T05 既有路徑的三個問題：(a) 約 5 萬個頂層欄位或很深的巢狀會讓 zod 丟 `RangeError: Maximum call stack`（與 T02-1 的大小與深度上限一起處理）；(b) 每個值的亂數串流都雜湊完整路徑，超長欄位名稱在大量值上很慢；改了會改變每筆紀錄的串流，要更新快照並在 PR 寫清楚；(c) 值的上限只算葉節點，空陣列組成的陣列不受限
- **Blocked by**：T12；(a) 等 T02-1
- **Blocks**：—
- **撞車風險**：`packages/fake-data`；與 T05-1 不要同時派
- **驗收測試**：三項各有一份會被擋下（或在時限內完成）的規則檔；同 seed 產出穩定
- **不做**：新的規則功能
- **來源**：PR #16 的 review

### T02-4 契約：表格列內的路徑（使用者 2026-10-24 同意；在 T24 之前）
- **目標**：規則裡經過欄位自己所屬陣列的路徑代表「目前這一列」，讓列小計、某列佔總額的比例寫得出來（目前的字面路徑會讀到每一列）；T12 引擎跟著實作
- **Blocked by**：T12
- **Blocks**：—（有列小計的樣板，例如 T24 財務明細，可能需要）
- **撞車風險**：契約變更；`packages/fake-data`
- **驗收測試**：列小計與列佔比各有範例，算出的值逐列正確；重新匯出的 JSON Schema 已更新
- **不做**：其他規則功能
- **來源**：PR #16

### T02-6 契約：陣列依日期排序（原 T12-1；使用者 2026-10-24 同意）
- **目標**：交易日期各自獨立抽樣，對帳單的列不依日期排序。`array` 規則加選用欄位 `sortBy`（只能指定項目裡的 `date` 欄位），整列依日期由早到晚穩定排序、空日期放最後，在 derived 欄位（runningBalance 等）計算之前排；沒寫 `sortBy` 的規則檔產出位元組完全相同。契約與 T12 引擎在同一張票完成（同 T02-4）
- **Blocked by**：T12
- **Blocks**：—（T26 銀行對帳單需要）
- **撞車風險**：契約變更；`packages/contract`、`packages/fake-data`
- **驗收測試**：100 份對帳單每份的列都依日期排列，餘額依排序後的順序逐筆正確；同 seed 產出穩定；既有規則檔與 main 位元組相同；重新匯出的 JSON Schema 已更新
- **不做**：日期以外的排序欄位
- **來源**：PR #16；T12-1 的 ASK

### T16-3 批次：用完的瀏覽器 session 要關掉
- **目標**：批次列印保留的 `X-Browser-Session` 在批次結束（或閒置）後從不關閉；本機每份批次都留下一個 Chrome（T15-2 量到：3 份的批次後 35 → 41 個 profile，60 秒後仍是 41；預覽不會累積），跑幾次驗收批次就吃掉數 GB 記憶體。雲端上則佔用並行瀏覽器名額直到逾時。批次結束、失敗或取消時關閉 session，並在 print Worker 端給閒置 session 上限
- **Blocked by**：T16、T07-3
- **Blocks**：—（樣板票 T22～T26 每張都要跑驗收批次；在那之前修好可避免 OOM）
- **撞車風險**：`apps/web` 批次與 `apps/print` session 程式；T15-2 merge 後再派
- **驗收測試**：連跑 3 次 10 份的批次，結束後本機 Chrome 數回到 0；批次中途失敗時也會關閉
- **不做**：批次間共用 session、快取樣板包檔案（T07-5）
- **來源**：T15-2 的資源量測

### T09-2 網站：在 workerd 裡跑對執行環境敏感的測試
- **目標**：`apps/web` 的字型名稱讀取、樣板儲存等測試改在 workerd 裡跑（`@cloudflare/vitest-pool-workers`）；Node 與 workerd 的 `node:zlib` 行為不同（`maxOutputLength` 依倍增緩衝區檢查），T15-2 只有在 stack 上驗收才抓到
- **Blocked by**：T15-2
- **Blocks**：—
- **撞車風險**：`apps/web` 的 vitest 設定；與改 `apps/web` 測試的票 rebase 時重跑
- **驗收測試**：故意讓 `maxOutputLength` 的處理退回 Node 寫法時，workerd 裡的測試會失敗
- **不做**：把所有 web 測試搬進 workerd
- **來源**：PR #19

### T12-2 假資料：依領域的填充文字
- **目標**：`text` 填充文字目前都像營運報告；加上主題或詞庫選項（或句子的 `choice`），讓通報單、論文等看起來像該領域的文件（若需改規則檔格式，先開契約小票）
- **Blocked by**：T12
- **Blocks**：—
- **撞車風險**：`packages/fake-data`；可能是契約變更
- **驗收測試**：同一規則檔換主題後產出的文字詞彙不同；同 seed 穩定
- **不做**：AI 生成文字
- **來源**：PR #18

### T12-3 假資料：姓名跟著性別
- **目標**：`name` 規則可以參照另一個欄位的性別，避免「王秀蓁」配「男」（需改規則檔格式，先開契約小票）
- **Blocked by**：T12
- **Blocks**：—
- **撞車風險**：`packages/fake-data`；契約變更
- **驗收測試**：100 份裡姓名與性別都一致；同 seed 穩定
- **不做**：其他欄位間的參照
- **來源**：PR #18

### T14-2 開發工具：共用的 PDF 轉圖
- **目標**：T3 預覽瀏覽器只會下載 PDF、不會顯示；提供一個共用指令把 PDF 每頁轉成圖片（pdf.js + container 裡的 Playwright Chromium），樣板票的目視檢查不必各自重寫
- **Blocked by**：T14
- **Blocks**：—
- **撞車風險**：新的開發工具，不改功能程式
- **驗收測試**：對一份多頁 PDF 產出每頁 PNG，並可疊上 gt.json 的框
- **不做**：放進正式產品
- **來源**：PR #18


### T07-7 印 PDF：連結的樣式表套用前就選字型（急）
- **目標**：T15-2 起樣板包的 CSS 以 `<link>` 載入；print runtime 在 `PagedConfig.before`（DOMContentLoaded）就用 computed style 與 `<style>` 的 at-rule 決定要宣告哪些平台字型（`apps/print/public/print-runtime.js` 的 `loadUsedFaces`），連結的樣式表還沒套用時一個字型都沒宣告，整份 PDF 印成系統備用字型，而「字型載入失敗」的檢查也不會觸發。改成等每個 `link[rel=stylesheet]` 載入後再掃描，並讓 `findUsedInAtRules` 也讀連結樣式表裡的 `@page`／`@media print`
- **Blocked by**：T15-2
- **Blocks**：T22（驗收「10 份全過」）；T23 已 merge，修好後重跑它的驗收批次
- **撞車風險**：`apps/print` 的 print runtime；與 T07-5、T07-6、T07-8 不要同時派
- **驗收測試**：只在連結 CSS 裡用平台字型的樣板包（minimal-example、T22 月報）連跑 30 份，全部用 Noto 字型、自我檢查無 `font` 差異；平台字型真的載入失敗時仍會擋下
- **不做**：改樣板包、改 `linkStyles`
- **來源**：PR #20（T10，10/30 失敗）與 T22 驗收（7/10、8/10 失敗）各自獨立發現

### T07-8 印 PDF：被擋的請求偶爾仍送出
- **目標**：`apps/print/src/lib.ts` 的 `blockOtherRequests` 先呼叫 `onBlocked`（停止列印），`finally` 隨即 `page.close()`；推測 Chrome 在套用 `Fetch.failRequest` 之前就拆掉攔截，被暫停的請求於是被放行。回應正確回報 `422 request_blocked`，但外部伺服器已收到請求。改成等 abort 完成後再關分頁。T07-16 的分支上也看到一次：`request-blocking.test.ts`「CSS background url(http://…)… outside server gets no request」在完整 `pnpm verify` 4 次裡失敗 1 次（`expected ['/background.png'] to deeply equal []`），單獨跑 3/3 通過；先確認是不是同一個 race
- **Blocked by**：T07-3
- **Blocks**：—
- **撞車風險**：`apps/print`；與 T07-7 不要同時派；T16-2 會把這個斷言的失敗記為已知問題
- **驗收測試**：data: 樣式表 `@import` 外部伺服器的文件連印 200 次，外部伺服器收到 0 個請求（修正前約 1/100 會收到）
- **不做**：其他攔截規則
- **來源**：T16-2（單獨重複跑 100 次的實驗）

### T07-9 印 PDF：Paged.js 改由 npm 套件提供
- **目標**：`apps/print/public/paged.polyfill.js`（3.3 萬行）是 Paged.js 0.4.3 的複製檔；`packages/ground-truth`、`packages/self-check` 已從 npm 的 `pagedjs@0.4.3` 讀同一個檔。`apps/print` 改為依賴 `pagedjs`（鎖死版本），在 `dev:print`、deploy 與測試前把 `dist/paged.polyfill.js` 複製進 `public/`（gitignore），repo 不再收這份檔
- **Blocked by**：T07
- **Blocks**：—
- **撞車風險**：`apps/print`；與 T07-5、T07-6、T07-8 不要同時派
- **驗收測試**：先比對 repo 裡的檔案與 npm 0.4.3 的 `dist/paged.polyfill.js` 是否位元組相同（不同就停下回報）；print Worker 提供的 `/paged.polyfill.js` 與 npm 套件的檔案位元組相同（測試會抓到漏複製）；乾淨 checkout 跑 `dev:print` 與 `pnpm verify` 都通過；同 seed 的批次輸出與改動前相同
- **不做**：升級 Paged.js
- **來源**：使用者 2026-10-24（cloc 統計）

### T07-10 印 PDF：`@import` 進來的樣式表裡的平台字型
- **目標**：T07-7 後 runtime 會讀連結樣式表的 `@page`／`@media print`，但被 `@import` 的樣式表裡、只用於列印的平台字型規則仍掃不到
- **Blocked by**：T07-7
- **Blocks**：—（目前沒有樣板包這樣寫）
- **撞車風險**：`apps/print` 的 print runtime；與 T07-5、T07-6、T07-8、T07-9 不要同時派
- **驗收測試**：只在 `@import` 樣式表的 `@media print` 裡用平台字型的樣板包，印出來只含 Noto 字型
- **不做**：其他 CSS 載入方式
- **來源**：PR #21 的 review

### T02-5 契約：頁碼區塊（使用者 2026-10-24 同意；在 T02-3、T02-4 之後）
- **目標**：樣板目前印不出頁碼：`counter(page)` 印出的字不在任何 `data-gt` 元素裡（自我檢查會失敗），寫進 DOM 的數字又不知道一筆資料會分成幾頁（規格書 §5）。gt.json 加一種頁碼區塊類型；樣板放一個頁碼元素（例如「第 {page} 頁／共 {total} 頁」），print runtime 在 Paged.js 分頁完成後、讀 gt.json 之前逐頁填入數字；ground-truth 讀取與自我檢查跟著支援；規格書補上用法
- **Blocked by**：T02-4
- **Blocks**：—（之後的樣板票可以印頁碼）
- **撞車風險**：契約變更；`apps/print` 的 print runtime、`packages/ground-truth`；與 T07-5、T07-6、T07-8、T07-9、T07-10 不要同時派
- **驗收測試**：一份會分成多頁的樣板（例如 T22 月報）每頁頁尾印出正確的「第 n 頁／共 N 頁」，gt.json 每頁有對應的頁碼區塊，批次 10 份自我檢查全過；重新匯出的 JSON Schema 已更新
- **不做**：其他頁碼格式（羅馬數字、章節頁碼）
- **來源**：PR #22（T22）

### T07-11 印 PDF：英文文件裡的數字抽出來變成 U+0000
- **目標**：`lang="en"` 且用 Noto Sans TC 的文件，PDF 文字層裡的數字抽出來是 U+0000，所以「2026-10-24」會被判 `text_missing`（main 上也一樣）；OCR 訓練用的 PDF 文字層錯了，ground truth 就對不上。先找出原因（字型子集、ToUnicode 對照、`lang` 造成的字形選擇等），再修
- **Blocked by**：T07-6
- **Blocks**：T25（論文多半有英文段落與數字）
- **撞車風險**：`apps/print` 的 print runtime 或字型處理；與 T02-5、T07-5、T07-8、T07-9、T07-10 不要同時派
- **驗收測試**：`lang="en"` 與 `lang="zh-TW"` 的文件各含日期與金額，印出的 PDF 文字層抽出的數字正確，列印不再誤報 `text_missing`；批次自我檢查無 `text` 差異
- **不做**：改 T14 自我檢查的比對規則
- **來源**：PR #28（T07-6 測試時發現）

### T07-12 印 PDF：缺字檢查跨過儲存格邊界比對
- **目標**：`missingText`（`packages/self-check/src/text.ts`，只有列印擋缺字在用）把區塊框內的文字項目不加分隔地接起來，再由長到短把要找的文字扣掉。相鄰的數字儲存格 `3.19`、`3.01` 接成 `…3.193.01…` 後，另一格的 `93.01` 會跨界先配對、用掉 `9`，於是 `3.19` 被誤報 `text_missing`。改成每段文字只在單一項目（或以分隔字元隔開的項目）內配對，不跨項目
- **Blocked by**：T07-6
- **Blocks**：T24（驗收 10 份全過）；數字多的樣板（T25、T26）
- **撞車風險**：`packages/self-check/src/text.ts` 與 print 的缺字檢查；與 T07-11 不要同時派
- **驗收測試**：相鄰數字儲存格會互相跨界配對的表格（例如 T24 財務明細那份 fixture）不再誤報；故意刪掉一格的數字仍會被擋；T24 的 10 份驗收批次全過
- **不做**：改 T14 自我檢查 `checkPdf` 的比對規則
- **來源**：T24 驗收（`page 2: 3.19`）

### T07-13 印 PDF：全形斜線「／」沒有進到 PDF 文字層
- **目標**：全形斜線 U+FF0F 在粗體、一般、換行或單行時，列印的缺字檢查都讀不到（ASCII `/` 正常）。T07-11 查到原因：U+FF0F 與 U+2215 ∕ 在 cmap 共用 glyph 18194，ToUnicode 取較小的碼位，抽出來是 U+2215（T03 §2.5 的機制；`apps/print/src/fonts/build.ts` 的 cmap 修補沒有拿掉 U+2215）。修正字型的 cmap，讓抽出的是 U+FF0F。一併處理 T26 發現的中點「・」U+30FB：Noto Sans TC 印出後讀不到（有「・」得 422 `text_missing`，拿掉就 200；Serif 正常），推測也是共用 glyph，先確認機制；並掃過整份 cmap，找出其他共用 glyph、會抽錯碼位的常用字元
- **Blocked by**：T07-11
- **Blocks**：—
- **撞車風險**：`apps/print` 字型處理；與 T07-11、T07-12 不要同時派
- **驗收測試**：含「／」、Sans 的「・」的區塊印出後，PDF 文字層抽出的是原字元，不再誤報 `text_missing`；列出掃描找到的其他字元與處理結果
- **不做**：改樣板包
- **來源**：T24 驗收；「・」來自 T26 驗收

### T07-14 印 PDF：跨頁表格保留欄寬
- **目標**：Paged.js 用 `cloneNode(false)` 重建跨頁表格的外殼，print runtime 的表格 handler 只把 `<thead>` 抄回去、沒抄 `<colgroup>`，所以第 2 頁起欄寬變平均（T24：客戶名稱第 1 頁 18%，之後 1/11）。把 `<colgroup>` 跟 `<thead>` 一起抄到每個接續的表格片段
- **Blocked by**：T07
- **Blocks**：—（每個有跨頁表格的樣板：T22、T24、T26）
- **撞車風險**：`apps/print` 的 print runtime；與 T02-5、T07-5、T07-8、T07-9、T07-10 不要同時派
- **驗收測試**：T24 財務明細跨頁後每頁的欄寬與第 1 頁相同（量測每欄的 x 範圍）；gt.json 每頁仍與 PDF 相符；批次 10 份自我檢查全過
- **不做**：其他 Paged.js 表格缺陷
- **來源**：PR #33（T24）

### T07-15 印 PDF：只設在頁碼欄位上的平台字型
- **目標**：T02-5 的頁碼欄位（`data-gt-page-number`、`data-gt-page-count`）在找字型時還是空的，所以只設在欄位本身的平台字型或字重不會在分頁前載入，數字改用後援字型。`findUsedInDocument` 要把這兩種欄位當成有自己的文字
- **Blocked by**：T02-5
- **Blocks**：—
- **撞車風險**：`apps/print` 的 print runtime；與 T07-14、T07-5、T07-8、T07-9、T07-10 不要同時派
- **驗收測試**：一份只在頁碼欄位設粗體平台字型的 fixture，印出的頁碼用的是該字型（PDF 字型清單），gt.json 每頁仍與 PDF 相符
- **不做**：改頁碼欄位的寫法
- **來源**：PR #35（T02-5）。順帶：`templates/monthly-report/src/acceptance.ts` 用法註解的 `acceptance -- --url` 在 pnpm 12 會失敗，拿掉 `--`

### T23-1 樣板：通報單與銀行對帳單改用民國年
- **目標**：T06-2 加了內建的 `{{rocDate d format="…"}}`。`templates/incident-form` 與 `templates/bank-statement`（交易列的 `{{date}}`、`issueDate`）目前直接印出 YYYY-MM-DD，改成台灣表單常見的民國年格式（例如 113/05/07、民國113年5月7日）
- **Blocked by**：T06-2
- **Blocks**：—
- **撞車風險**：只動這兩個樣板包；與正在改它們的票不要同時派
- **驗收測試**：兩個樣板各跑一批 10 份，自我檢查全過；gt.json 的日期文字與 PDF 一致；目視確認
- **不做**：改平台程式、改其他樣板
- **來源**：PR #36（T06-2）

### T07-16 印 PDF：print runtime 的頁面判定不被樣板偽造
- **目標**：`apps/print/public/print-runtime.js` 的 `pagedPages()` 用 `.pagedjs_pages > .pagedjs_page` 找頁面，樣板內容裡放同樣的結構就能偽造，讓 expectedText 與頁碼填入對錯頁。改用 T08-1 在 `packages/ground-truth` 定下的同一條規則（`<body>` 直接子層的最後一個 `.pagedjs_pages` 的直接子層 `.pagedjs_page`）
- **Blocked by**：T08-1
- **Blocks**：—
- **撞車風險**：`apps/print` 的 print runtime；與 T07-14、T07-15、T07-5、T07-8、T07-9、T07-10 不要同時派
- **驗收測試**：樣板內容含偽造的 `.pagedjs_pages > .pagedjs_page` 時，頁碼填入與缺字檢查仍以真正的頁面為準；既有樣板 gt.json 不變
- **不做**：改 ground-truth 的規則
- **來源**：T08-1 的 ASK

### T07-17 印 PDF：`apps/print` 的 tsconfig 分成 Worker 與 Node 測試
- **目標**：`apps/print` 的 tsconfig 為了讓 Node 測試與 vitest.config 通過而載入 DOM lib（Worker 的 `URL` 與 Node 的 `URL`、fs、fetch 參數型別不合，共 11 處），而 `packages/template-tools/src/text.ts` 的 `TextDecoder({ fatal: true })` 在 Worker 型別下缺 `ignoreBOM`（1 處）。拆成 Worker 與 Node 測試兩個 program，拿掉 DOM lib
- **Blocked by**：T08-1
- **Blocks**：—
- **撞車風險**：`apps/print` 的測試檔與 tsconfig；`packages/template-tools/src/text.ts`
- **驗收測試**：`apps/print` 不載入 DOM lib 也能 typecheck；`pnpm verify` 全過；行為不變
- **不做**：改執行邏輯
- **來源**：T08-1 的 ASK

### T14-3 自我檢查：公式文字的順序與 U+200B
- **目標**：自我檢查依 PDF 的繪製順序比對公式文字；KaTeX 有定位的 span（上下標、分數、`\tag`）晚於同一行其他文字繪製，所以幾乎每個真實公式都失敗。另外 `.vlist-s` 的 U+200B 會進 gt 的文字，但 PDF 沒有。T25 的樣板在自己的 CSS（`templates/paper/src/build.ts`）繞過了這兩點；其他有公式的樣板會再碰到。改成公式文字的比對不看順序（或依 KaTeX 的結構還原順序），並讓 gt 與自我檢查都不含 U+200B
- **Blocked by**：T14、T13
- **Blocks**：—
- **撞車風險**：`packages/self-check`、`packages/ground-truth` 的公式文字；與 T08-1 不要同時派
- **驗收測試**：一份不帶 T25 CSS 修正、含上下標、分數與 `\tag` 的 KaTeX fixture，自我檢查通過；T25 的樣板拿掉繞道後仍全過（或說明為何保留）；其他樣板 gt.json 不變
- **不做**：改公式的 `latex` 欄位
- **來源**：PR #38（T25）

### T15-3 樣板上傳：`KaTeX_Main-Regular.woff2` 的字型名稱在批次裡讀不到
- **目標**：同一個樣板包裡 `KaTeX_Math-Italic.woff2`、`KaTeX_Size2-Regular.woff2` 正常，`KaTeX_Main-Regular.woff2` 卻被當成非樣板包字型；Node 讀得到 `postScriptName`。推測是 workerd 裡 brotli 的輸出上限（`apps/web/src/templates/font-names.ts` 的 `outputLimit`；這個字型的表解壓後 42,926 bytes），未驗證。先在 workerd 裡重現並確認原因，再修
- **Blocked by**：T15
- **Blocks**：—
- **撞車風險**：`apps/web/src/templates/font-names.ts`；可與 T09-2（在 workerd 裡跑字型名稱測試）一起考慮
- **驗收測試**：上傳含 `KaTeX_Main-Regular.woff2` 的樣板包，批次裡它的文字被認成樣板包字型；在 workerd 內有測試
- **不做**：改字型白名單規則
- **來源**：PR #38（T25；該樣板目前改帶 TTF）

### T10-1 規格書：雙欄與 KaTeX 公式的寫法
- **目標**：`packages/pack-spec` 的 SPEC §5 或 `skill/references/recipes.md` 補上「雙欄」與「KaTeX 公式」兩則寫法，指向 `templates/paper`：用 `build.ts` 預先渲染、帶 KaTeX 字型（T15-3 後 woff2 可用）、直接用 KaTeX 原本的 CSS（T14-3 後不再需要繞道）、公式的留白；雙欄要用 `column-fill: balance`（`auto` 配 `break-inside: avoid` 會把整個多欄區塊推到下一頁）
- **Blocked by**：T25
- **Blocks**：—
- **撞車風險**：`packages/pack-spec`；T14-3、T15-3 合併後要同步改寫法
- **驗收測試**：文件內容與 `templates/paper` 一致；skill 的範例片段能通過 check-pack
- **不做**：改平台程式
- **來源**：PR #38（T25）

### T14-4 自我檢查：沒有文字的區塊也要核對框的位置
- **目標**：樣板的 CSS 動到 Paged.js 的頁面框或 html／body 的盒模型時（例如 `@page { margin: 20mm }` 加上 `.pagedjs_page { margin-top: -20mm !important }`，或 `body { padding-left: 10mm }`），頁數不變，但 PDF 印出的位置和 gt 的框對不上（T08-1 的 Security review 重現：圖片 gt `[56.68, 56.68, 86.68, 86.68]`，PDF 實際約 `[57, 0, 87, 30]`）。有文字的區塊會被自我檢查抓到，沒有文字的區塊不會：`packages/self-check/src/check.ts` 約 272 行跳過無文字的圖片（空勾選框、空白欄位是否也跳過，見 T08-1 PR）。(1) 自我檢查用 PDF 的幾何資訊核對無文字區塊的框：圖片看 content stream 的變換矩陣，向量圖形看路徑，逐頁比對；(2) 另加一道便宜的防線：checkPack 或列印時拒絕作用在 `.pagedjs_*` 或 html／body 盒模型上的樣板 CSS
- **Blocked by**：T14、T08-1
- **Blocks**：—
- **撞車風險**：`packages/self-check`；(2) 若放在 `packages/template-tools`，與正在改它的票不要同時派
- **驗收測試**：上述兩種位移的 fixture 被自我檢查判為框不符；5 個既有樣板各一批 10 份仍全過；空勾選框與圖片各至少一個案例
- **不做**：改區塊讀取規則
- **來源**：T08-1 的 Security review（第 2 輪）

### T09-3 網站：`page_count_mismatch` 的中文說明，以及偶發逾時的測試
- **目標**：(1) T08-1 新增的列印錯誤 `page_count_mismatch`（PDF 頁數與 Paged.js 頁數不同）在 `apps/web` 的 `explain.ts` 還沒有中文說明，補上，並指出常見原因（樣板 CSS 動到 `.pagedjs_*` 或 body 的版面）；(2) `apps/web/src/api/batch-checks.test.ts` 的「reports self-check totals…」在 CI 偶發撞到 60 秒逾時（PR #39 第一次 CI；本機 6/6 通過、重跑通過），找出原因；(3) `apps/print/src/session-idle-sweep.test.ts`「a session in use by a print is not closed even when listed without a connectionId」在完整 `pnpm verify` 負載下 120 秒逾時（T15-3 分支 3 次中 1 次，單獨跑 14/14 通過）
- **Blocked by**：T08-1
- **Blocks**：—
- **撞車風險**：`apps/web`
- **驗收測試**：批次結果頁對 `page_count_mismatch` 顯示中文說明；該測試在 CI 連跑 3 次不逾時，或說明原因與修法
- **不做**：改錯誤代碼
- **來源**：PR #39（T08-1）

### T07-18 印 PDF：Paged.js 的頁面框被樣板改動時拒絕列印
- **目標**：Paged.js 完成後，在 print runtime 檢查 `.pagedjs_page`、`.pagedjs_sheet`、`.pagedjs_area` 等頁面框的 margin、padding、position、transform 仍是 Paged.js 自己設的值，html／body 也沒有被移動；被改動就拒絕列印（422，類似 `page_count_mismatch`）。樣板可以用不點名 pagedjs 的選擇器（例如 `body > div > div { margin-top: -20mm !important }`）移動頁面框，再用絕對定位的 `::after` 在 gt 框裡畫一份假圖騙過 T14-4 的墨跡檢查（T14-4 Security review 重現：實際圖在 `[57, 0, 87, 30]`）；checkPack 擋不了這類選擇器，PDF 幾何也分不出是誰畫的，只能在來源處擋
- **Blocked by**：T07-16、T14-4
- **Blocks**：—
- **撞車風險**：`apps/print` 的 print runtime；與 T07-15、T07-5、T07-8、T07-9、T07-10 不要同時派
- **驗收測試**：上述 decoy 與 T08-1／T14-4 的位移 fixture 都得 422；5 個既有樣板各一批 10 份不受影響（無誤擋）
- **不做**：改區塊讀取規則、加「無主墨跡」檢查
- **來源**：T14-4 的 Security review

### T25-1 樣板：論文改回 KaTeX 的 woff2 字型
- **目標**：T25 因為 T15-3 的問題改帶 KaTeX 的 TTF；T15-3 修好後，`templates/paper` 改回 `katex` 套件的 woff2（樣板包變小）
- **Blocked by**：T15-3、T14-3（T14-3 也會改 `templates/paper`）
- **Blocks**：—
- **撞車風險**：`templates/paper`
- **驗收測試**：批次 10 份自我檢查與 `compare.ts` 全過；樣板包大小前後對照
- **不做**：改平台程式
- **來源**：PR #43（T15-3）

### T14-5 自我檢查：公式比對的搜尋要有上限
- **目標**：T14-3 的公式比對（`packages/self-check` 的 `covers`）用 PDF 文字項目拼出 gt 文字，搜尋沒有步數上限；刻意重複的公式在 `checkPdf` 裡跑了 12 秒。加上固定的步數上限（與輸入無關、可重現），超過時把該公式回報為文字不符或明確的「無法判定」，不要跑好幾秒
- **Blocked by**：T14-3
- **Blocks**：—
- **撞車風險**：`packages/self-check`
- **驗收測試**：該重複公式在 1 秒內得到明確結果；`templates/paper` 批次 10 份仍全過
- **不做**：改公式比對規則
- **來源**：PR #45（T14-3）。另：T14-3 的盲點是公式裡兩個完整項目對調（例如分子分母），記錄在 PR #45

### T20-1 網站：批次結果頁的路由測試
- **目標**：T09-3 在批次結果頁（`apps/web/src/routes/batches/$id/index.tsx`）每個失敗 fixture 下顯示錯誤的中文說明，但沒有測試真的渲染這個路由；目前只測了 `fixture-error.tsx` 元件。補一個渲染整個路由的測試（含失敗 fixture 與說明）
- **Blocked by**：T09-3
- **Blocks**：—
- **撞車風險**：`apps/web` 的批次頁
- **驗收測試**：拿掉路由裡的說明元件時，該測試失敗
- **不做**：改頁面行為
- **來源**：PR #46（T09-3）

### T10-2 規格書：補上 `css-page-box` 與自我檢查的 `ink`
- **目標**：T14-4 新增的 checkPack 檢查 `css-page-box`（拒絕作用在 `.pagedjs_*` 或 html／body 盒模型上的 CSS）沒寫進 `packages/pack-spec` 的 SPEC §9、§5 與 `skill/references/check-codes.md`；自我檢查的 `ink`（沒有文字的區塊與 PDF 實際畫出的位置不符）也沒寫進規格書。補上說明、常見原因與改法
- **Blocked by**：T14-4
- **Blocks**：—
- **撞車風險**：`packages/pack-spec`
- **驗收測試**：文件與 `packages/template-tools`、`packages/self-check` 的實際行為一致；skill 的範例片段仍通過 `skill.test.ts`
- **不做**：改平台程式
- **來源**：PR #48（T10-1）

### T14-6 樣板：空白欄位要有墨跡（minimal-example 與其他樣板）
- **目標**：T14-4 之後，沒有文字的區塊必須在框內畫出東西。`templates/minimal-example` 的 `.pair [data-gt="field"]` 有大小但沒有墨跡，`recorder` 為空（`blankProbability` 0.3）的紀錄都以 `ink`「paints nothing」失敗（T10-2 批次 10 份中 2 份）。加上底線（例如 `border-bottom: 0.5pt solid #000`）。同時檢查其他 5 個樣板裡所有可能為空的欄位、勾選框與圖片，找出同樣的問題一併修好（T14-4 的驗收各批 10 份全過，可能只是剛好沒抽到空值）
- **Blocked by**：T14-4
- **Blocks**：—
- **撞車風險**：`templates/*`；與正在改同一樣板的票不要同時派
- **驗收測試**：每個樣板用會讓每個可空欄位至少為空一次的 seed 或資料跑批次，自我檢查全過；列出檢查過的欄位
- **不做**：改平台程式
- **來源**：PR #50（T10-2）

### T06-3 樣板工具：`css-page-box` 漏掉帶引號的屬性選擇器
- **目標**：`[class*="pagedjs"] { margin: 20mm }` 能通過 checkPack，因為字串遮罩在找選擇器之前就先執行；不帶引號的寫法會被擋。改成帶引號的屬性選擇器也會被擋
- **Blocked by**：T14-4
- **Blocks**：—
- **撞車風險**：`packages/template-tools`
- **驗收測試**：帶單、雙引號與不帶引號的 `[class*=pagedjs]`、`[class^=pagedjs]` 都被擋；5 個既有樣板與 minimal-example 仍通過 checkPack
- **不做**：其他 CSS 規則
- **來源**：PR #50（T10-2）

### T07-19 印 PDF：缺字檢查支援旋轉文字
- **目標**：`packages/self-check` 的 `missingText`（apps/print 的列印缺字檢查在用）仍把每個文字項目的 x 範圍當成橫排，所以旋轉 +90° 與 180° 的文字被誤判 `text_missing`（例如 `page 1: 內部使用`、`倒置文字`）。T14-1 讓 `readPdf` 為非橫排文字回報可選的 `dir`，改用它判斷
- **Blocked by**：T14-1
- **Blocks**：—
- **撞車風險**：`packages/self-check` 的 `missingText`、`apps/print`
- **驗收測試**：+90°、180°、-90° 的文字都能列印並通過自我檢查；故意移出框外的對照組仍被擋；既有樣板 gt.json 不變
- **不做**：改橫排文字的判斷
- **來源**：PR #52（T14-1）。另（選做、目前沒有樣板需要）：用 CSS 重排的相鄰行內區塊（flex `order`、`row-reverse`），在未標記的 PDF 裡仍會誤判

### T14-7 樣板：minimal-example 的驗收程式
- **目標**：其他樣板都有 `src/acceptance.ts`，minimal-example 沒有（T14-6 用暫時的腳本跑批次）。補上，至少涵蓋自我檢查全過與空白 `recorder` 的情況
- **Blocked by**：T14-6
- **Blocks**：—
- **撞車風險**：`templates/minimal-example`
- **驗收測試**：`node src/acceptance.ts --url …` 在 seed t10-2 跑 10 份通過；故意拿掉底線時失敗
- **不做**：改樣板外觀
- **來源**：PR #53（T14-6）

### T15-4 樣板上傳：長 Huffman 碼與檔案數上限的 CPU
- **目標**：T15-1 之後，大量長 Huffman 碼的 deflate 串流在 workerd 要 546–680 ms（main 原本 109–174 ms），1,000 個項目各 13 個區塊、共 20 MiB 的上傳要 1.66 秒（原本 1.42 秒）。(1) 區塊掃描改用兩層解碼表處理長碼；(2) 在解壓縮前先檢查 200 個檔案的上限，不必解完才擋
- **Blocked by**：T15-1
- **Blocks**：—
- **撞車風險**：`apps/web/src/templates/`（`deflate-blocks.ts`、`unzip.ts`）
- **驗收測試**：上述兩種輸入在 workerd 的時間回到 main 的水準以下；6 個真的樣板仍能上傳；T15-1 的各種炸彈仍被擋；另測 zopfli 與 7-Zip ultra 壓的 zip
- **不做**：改上限數值
- **來源**：PR #55（T15-1）

### T07-20 印 PDF：只在螢幕或只在列印套用的樣式表
- **目標**：Paged.js 保留 `<style media="screen">`、`[data-pagedjs-ignore]` 與 `@media all and (…)`，所以只在其中一種媒體套用的樣式表能在量測 gt（螢幕）與列印之間移動 `data-gt` 內容。二擇一：在列印媒體下讀 gt，或拒絕只在單一媒體套用、會影響版面的樣式表。選做：拒絕樣板 CSS 裡的視窗單位（vw、vh、vmin、vmax…），關掉 T07-18 留下的視窗大小殘餘風險
- **Blocked by**：T07-18
- **Blocks**：—
- **撞車風險**：`apps/print` 的 print runtime、`packages/ground-truth`（若改在列印媒體下讀）或 `packages/template-tools`（若改成拒絕）
- **驗收測試**：只在螢幕移動 `data-gt` 內容的樣板被擋（或 gt 與 PDF 相符）；6 個樣板各一批 10 份不受影響、gt.json 不變
- **不做**：改區塊讀取規則以外的列印流程
- **來源**：PR #56（T07-18）
