# Claude Code mods

## context-gauge

![preview](docs/preview-dark.png)

Desktop 和手機 app 畫一行高的 SVG 細條（上方是輸入框上的細條，下方是面板與 `/gauge`），字體用系統字體（Windows 是 Segoe UI），跟 Desktop 其他介面一致；終端畫文字版。

輸入框上方的用量細條，加上可折疊的右側面板。

- **Context**：用量百分比與 token 數，接近自動壓縮門檻時變紅並顯示 `⚠ auto-compact soon`
- **額度**：5h / 7d 用量與重置倒數，以及本次 session 花費
- **任務進行中**：思考、輸出、工具各花的時間，tok/s，工具時間軸，**■ Stop** 按鈕
- **完成通知**：一輪超過 20 秒時，結束會跳 toast
- **自動收尾（預設關閉）**：5h、週額度各自設定開關與門檻；任務進行中達到門檻時倒數 10 秒，然後在正在跑的那一輪插入收尾指示
- **/compact 規則**：context 到設定的百分比時，提醒你 /compact（預設 70%），或閒置時自動 /compact
- **設定頁**：`/gauge settings`，或細條旁的 ⚙；可切換顯示風格與文字大小

### 安裝（CLI 和 Desktop 都適用）

```sh
claude plugin marketplace add kirishimarisano-rgb/Claude-code-usage-context-cost-show
claude plugin install context-gauge@kirishima-mods
```

裝好後重開 Claude Code。Desktop 要完全結束再開（Mac 用 ⌘Q），然後在 **Code** 分頁開本機 session。更新：`claude plugin marketplace update kirishima-mods`。

### 不安裝、直接從資料夾跑

```sh
git clone https://github.com/kirishimarisano-rgb/Claude-code-usage-context-cost-show
claude --plugin-dir ./Claude-code-usage-context-cost-show/context-gauge
```

**Claude Code Desktop**（不能加參數）：在 `~/.claude/settings.json` 的 `env` 加上 mod 的絕對路徑，然後在 Desktop 的 Code 分頁開一個**本機** session（不是雲端 session）：

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/Claude-code-usage-context-cost-show/context-gauge"
  }
}
```

Windows 的路徑寫成 `C:\\Users\\you\\...\\context-gauge`。要改檔後自動重載，再加 `"CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"`。

| 指令 | 作用 |
| --- | --- |
| `/gauge` | 在對話裡顯示儀表（只能顯示文字的客戶端會看到文字快照） |
| `/gauge pane` | 打開右側面板（`f` 折疊/展開） |
| `/gauge settings` | 設定頁 |
| `/gauge wrap 5h 90\|on\|off` | 5 小時額度的自動收尾 |
| `/gauge wrap 7d 95\|on\|off` | 週額度的自動收尾 |
| `/gauge compact 70\|remind\|auto\|off` | context 到幾 % 時提醒或自動 /compact |
| `/gauge look classic\|minimal\|terminal` | 顯示風格：Classic（深綠/深黃/深紅，預設）、Minimal（低飽和）、Terminal（最原本的文字進度條，Desktop 也用文字畫） |
| `/gauge size s\|m\|l` | 文字大小（預設 M） |
| `/gauge footer auto\|on\|off` | 每輪回答下附一行用量；`auto`（預設）只在沒有客戶端能畫細條時開啟，例如雲端 session |

上方細條只在終端與 Claude Code Desktop 顯示，手機 app 不顯示。右側面板要在終端全螢幕、寬度 110 欄以上才會停靠在右側。雲端 session 沒有可以畫 mod 介面的客戶端，所以只能看 `/gauge` 的文字快照。

### 雲端 session（claude.ai/code）

連進雲端 session 的客戶端（網頁、Desktop、手機）都不畫 mod 介面，所以沒有上方細條和面板。改成在每輪回答下面附一行用量：

```
🟢 ctx 20%  ·  🟢 5h 12% ↻4h17m  ·  🔴 7d 93% ↻1h47m  ·  $5.01  ·  ⏱ 2m13s (think 40s)  ·  14 tools  ·  52 tok/s
```

這行只顯示給你看，不會進入模型讀到的對話紀錄。

要讓每個雲端 session 都自動裝好，在雲端環境的 **setup script** 加上：

```sh
claude plugin marketplace add kirishimarisano-rgb/Claude-code-usage-context-cost-show
claude plugin install context-gauge@kirishima-mods
```

### 讀寫範圍

只讀 session 用量、每輪事件與時鐘。寫入只有畫面、記憶體中的狀態，以及保存在 `$.store` 的設定（面板是否折疊、設定頁的各項）。不讀寫專案檔案、不執行程式、不連網。

會影響對話的只有：■ Stop、自動收尾（插入一段收尾提示），以及 /compact 規則設為 Auto 時的自動壓縮（壓縮本身會呼叫一次模型）。

### 開發

```sh
claude plugin validate context-gauge
claude plugin test context-gauge
```
