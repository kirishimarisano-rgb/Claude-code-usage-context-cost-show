# Claude Code mods

## context-gauge

輸入框上方的用量細條，加上可折疊的右側面板。

- **Context**：用量百分比與 token 數，接近自動壓縮門檻時變紅並顯示 `⚠ auto-compact soon`
- **額度**：5h / 7d 用量與重置倒數，以及本次 session 花費
- **任務進行中**：思考、輸出、工具各花的時間，tok/s，工具時間軸，**■ Stop** 按鈕
- **完成通知**：一輪超過 20 秒時，結束會跳 toast
- **自動收尾（預設關閉）**：5h 或 7d 達到門檻時倒數 10 秒，然後在正在跑的那一輪插入收尾指示

### 使用

```sh
git clone https://github.com/kirishimarisano-rgb/Mods-Claude-code-0-powerd-by-claude
claude --plugin-dir ./Mods-Claude-code-0-powerd-by-claude/context-gauge
```

**Claude Code Desktop**（不能加參數）：在 `~/.claude/settings.json` 的 `env` 加上 mod 的絕對路徑，然後在 Desktop 的 Code 分頁開一個**本機** session（不是雲端 session）：

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/Users/you/Mods-Claude-code-0-powerd-by-claude/context-gauge"
  }
}
```

Windows 的路徑寫成 `C:\\Users\\you\\...\\context-gauge`。要改檔後自動重載，再加 `"CLAUDE_CODE_PLUGIN_DIR_WATCH": "1"`。

| 指令 | 作用 |
| --- | --- |
| `/gauge` | 在對話裡顯示儀表（只能顯示文字的客戶端會看到文字快照） |
| `/gauge pane` | 打開右側面板（`f` 折疊/展開） |
| `/gauge wrap on\|off` | 開關自動收尾 |
| `/gauge wrap 95` | 設定自動收尾門檻（50–100） |

上方細條只在終端與 Claude Code Desktop 顯示，手機 app 不顯示。右側面板要在終端全螢幕、寬度 110 欄以上才會停靠在右側。雲端 session 沒有可以畫 mod 介面的客戶端，所以只能看 `/gauge` 的文字快照。

### 讀寫範圍

只讀 session 用量、每輪事件與時鐘。寫入只有畫面、記憶體中的狀態，以及兩個保存在 `$.store` 的設定（面板是否折疊、自動收尾的開關與門檻）。不讀寫專案檔案、不執行程式、不連網。

### 開發

```sh
claude plugin validate context-gauge
claude plugin test context-gauge
```
